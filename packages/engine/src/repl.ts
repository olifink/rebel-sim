/**
 * The outer interpreter / compiler (FORTH-ARCHITECTURE.md §4's STATE
 * sysvar drives the split): tokenizes a line and, per token, either
 * executes it (interpreting) or compiles a call/literal into the
 * definition under construction (compiling) — the classic Forth
 * text-interpreter loop. `:`/`;`/`IMMEDIATE` are handled as special
 * compiler syntax rather than dictionary words (see dictionary.ts's
 * header comment for why).
 *
 * M7 (FORTH-ARCHITECTURE.md §7a): one line is now a resumable session
 * (`runLine`, a generator), not a single run-to-completion call — the
 * mechanism blocking `KEY` needs. Two entry points sit on top of it:
 * `beginLine()` (start a session, run nothing yet) and `step(budget)`
 * (drive the current session up to `budget` steps, stopping early if it
 * blocks). `interpret()` is unchanged in *contract* for every existing
 * caller/test: `beginLine()` + an effectively-unbounded `step()` call,
 * so a line that never calls `KEY` (everything before M7) still runs
 * fully to completion synchronously, throwing exactly as before on a
 * genuine error. The one real behavior change: a line that blocks on an
 * empty-queued `KEY` now returns with the session still alive (drive it
 * further via `step()`) instead of throwing "no event queued" (M4).
 */

import { Arena } from './arena.js';
import { Bank, BankTable } from './banks.js';
import { DataStack } from './stack.js';
import { Sysvars } from './sysvars.js';
import { PrimitiveContext } from './primitives.js';
import { Screen, ScreenHal } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Channel, KeyboardChannel } from './channel.js';
import { Storage, StorageHal } from './storage.js';
import { Inner, StepSignal } from './inner.js';
import {
  abortDefinition,
  beginDefinition,
  compileCell,
  DictionaryContext,
  endDefinition,
  findWord,
  markLatestImmediate,
  writeHeader,
} from './dictionary.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const DOCOL = opcodes.docolTokenId;

const SYSV_BANK_SIZE = 4096; // 4 KiB, matches Rebel-ROM's XS size class (docs/SYSVARS.md §1)
const DSTK_BANK_SIZE = 4096; // 1024 cells
const RSTK_BANK_SIZE = 4096; // 1024 cells
const DICT_BANK_SIZE = 1 << 16; // 64 KiB
const KMAP_BANK_SIZE = 4096; // 4 KiB, matches Rebel-ROM's XS size class (docs/KEYBOARD.md §6); table itself is 512 bytes
const DEFAULT_ARENA_SIZE = 1 << 20; // 1 MiB, plenty through M4

// M3 boot-time screen mode. Rebel-ROM has no runtime mode-change
// mechanism yet either (docs/SCREEN-MODULE.md §9's "mode-change
// ownership: deferred") — Rebel-Sim boots into this mode and stays.
const DEFAULT_SCREEN_WIDTH = 320;
const DEFAULT_SCREEN_HEIGHT = 240;
const DEFAULT_CHAR_CELL_W = 8; // matches the ZX Spectrum 8x8 font port
const DEFAULT_CHAR_CELL_H = 8;
const DEFAULT_INK = 0x00ff00; // green
const DEFAULT_PAPER = 0x000000; // black

export interface MachineOptions {
  arenaSize?: number;
  /** Host-supplied pixel drawing (canvas, etc). Defaults to a no-op —
   * the CHAR bank / sysvar state is fully correct without one, which is
   * all engine-level tests need. */
  screenHal?: ScreenHal;
  /** Host-supplied project/cart file I/O (OPFS, etc). Defaults to a
   * no-op — openProject()/saveAsset() calls just do nothing useful,
   * which is fine for engine-level tests that don't exercise storage. */
  storageHal?: StorageHal;
  /** What blocking `KEY` binds to (FORTH-ARCHITECTURE.md §7a). Defaults
   * to a `KeyboardChannel` wrapping this Machine's own `keyboard` — a
   * test can inject a fake `Channel` instead, and M8's `RemoteChannel`
   * will plug in here with no other engine changes. */
  channel?: Channel;
}

/** `step()`'s return: `'idle'` — no session in flight, nothing to do.
 * `'blocked'` — the session is alive but waiting on the bound channel
 * (e.g. `KEY` with nothing queued); call `step()` again later, once
 * `hasData()` might be true. `'more-to-run'` — the budget ran out before
 * the line finished; call `step()` again to continue it. */
export type StepStatus = 'idle' | 'blocked' | 'more-to-run';

export class Machine implements PrimitiveContext, DictionaryContext {
  readonly arena: Arena;
  readonly banks: BankTable;
  readonly stack: DataStack;
  readonly rstack: DataStack;
  readonly sysvars: Sysvars;
  readonly dictBank: Bank;
  readonly screen: Screen;
  readonly keyboard: Keyboard;
  readonly storage: Storage;
  readonly channel: Channel;
  private readonly inner: Inner;
  private session: Generator<StepSignal, void, void> | undefined;

  constructor(options: MachineOptions = {}) {
    this.arena = new Arena(options.arenaSize ?? DEFAULT_ARENA_SIZE);
    this.banks = new BankTable(this.arena);
    const sysvBank = this.banks.createBank('SYSV', SYSV_BANK_SIZE);
    const dstkBank = this.banks.createBank('DSTK', DSTK_BANK_SIZE);
    const rstkBank = this.banks.createBank('RSTK', RSTK_BANK_SIZE);
    this.dictBank = this.banks.createBank('DICT', DICT_BANK_SIZE);

    this.sysvars = new Sysvars(this.arena, sysvBank);
    this.sysvars.initHeader();
    this.sysvars.setBase(10);
    this.sysvars.setState(0);
    this.sysvars.setLatest(0);
    this.sysvars.setHere(this.dictBank.base);

    const charCols = DEFAULT_SCREEN_WIDTH / DEFAULT_CHAR_CELL_W;
    const charRows = DEFAULT_SCREEN_HEIGHT / DEFAULT_CHAR_CELL_H;
    this.sysvars.set('SCREEN', 'SCREEN-WIDTH', DEFAULT_SCREEN_WIDTH);
    this.sysvars.set('SCREEN', 'SCREEN-HEIGHT', DEFAULT_SCREEN_HEIGHT);
    this.sysvars.set('SCREEN', 'CHAR-CELL-W', DEFAULT_CHAR_CELL_W);
    this.sysvars.set('SCREEN', 'CHAR-CELL-H', DEFAULT_CHAR_CELL_H);
    this.sysvars.set('SCREEN', 'CHAR-COLS', charCols);
    this.sysvars.set('SCREEN', 'CHAR-ROWS', charRows);
    this.sysvars.set('SCREEN', 'INK', DEFAULT_INK);
    this.sysvars.set('SCREEN', 'PAPER', DEFAULT_PAPER);
    this.sysvars.set('CORE', 'CURSOR-X', 0);
    this.sysvars.set('CORE', 'CURSOR-Y', 0);

    const charBank = this.banks.createBank('CHAR', charCols * charRows);
    this.screen = new Screen(this.arena, charBank, this.sysvars, options.screenHal);
    this.screen.cls();

    const kmapBank = this.banks.createBank('KMAP', KMAP_BANK_SIZE);
    this.keyboard = new Keyboard(this.arena, this.sysvars, kmapBank);
    this.channel = options.channel ?? new KeyboardChannel(this.keyboard);

    this.storage = new Storage(this.arena, this.banks, options.storageHal);

    this.stack = new DataStack(this.arena, dstkBank);
    this.rstack = new DataStack(this.arena, rstkBank);
    this.inner = new Inner(this.arena, this.rstack, this);

    for (const p of opcodes.primitives) {
      writeHeader(this, p.name, 0, p.id);
    }
  }

  getBase(): number {
    return this.sysvars.getBase();
  }

  /** Starts a new session for one line of Forth source, without running
   * anything yet — call `step()` to actually drive it. Throws if a
   * previous session is still in flight (running or blocked): Rebel-Sim
   * has one outer-loop instance bound to one channel
   * (CHANNELS-DESIGN.md §4's session model) — no multiplexing/queuing of
   * concurrent lines exists, or is needed, yet. */
  beginLine(line: string): void {
    if (this.session) {
      throw new Error('a previous line is still running or blocked — call step() to continue it');
    }
    this.session = this.runLine(line);
  }

  /** Drives the current session up to `budget` steps. Returns `'idle'`
   * immediately if there's no session; `'blocked'` the instant the
   * session yields blocked (never busy-spins waiting for the channel —
   * that can only ever be resolved by something outside this call, e.g.
   * a keystroke, so spinning here would just freeze synchronously for
   * no reason); `'more-to-run'` if the budget ran out first; `'idle'`
   * once the session actually finishes (and clears it). An error thrown
   * mid-session propagates out of this call and clears the session (it's
   * dead either way — same as a completed one). */
  step(budget: number): StepStatus {
    if (!this.session) {
      return 'idle';
    }
    try {
      for (let i = 0; i < budget; i++) {
        const { value, done } = this.session.next();
        if (done) {
          this.session = undefined;
          return 'idle';
        }
        if (value === 'blocked') {
          return 'blocked';
        }
      }
      return 'more-to-run';
    } catch (err) {
      this.session = undefined;
      throw err;
    }
  }

  /** Convenience wrapper preserving the pre-M7 synchronous contract:
   * `beginLine()` plus an effectively-unbounded `step()` call. A line
   * that never blocks (everything before M7, and the overwhelming
   * majority of Forth source in general) still runs to completion
   * synchronously and throws exactly as before on a genuine error.
   * Output is visible through `screen`/`stack`, not a return value —
   * M1/M2's plain-text output buffer was always a stand-in for this (see
   * primitives.ts's earlier history), retired once a real CHAR-bank-
   * backed screen existed (M3). If the line blocks (e.g. `KEY` with an
   * empty queue), this returns anyway with the session still alive —
   * drive it further via `step()` once the channel might have data. */
  interpret(line: string): void {
    this.beginLine(line);
    this.step(Number.MAX_SAFE_INTEGER);
  }

  private *runLine(line: string): Generator<StepSignal, void, void> {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    try {
      while (i < tokens.length) {
        const token = tokens[i++];
        const upper = token.toUpperCase();

        if (this.sysvars.getState() === -1) {
          yield* this.interpretCompiling(upper, token);
        } else {
          if (upper === ':') {
            beginDefinition(this, tokens[i++], DOCOL);
            yield 'progress';
            continue;
          }
          yield* this.interpretExecuting(upper, token);
        }
      }
    } catch (err) {
      if (this.sysvars.getState() === -1) {
        abortDefinition(this);
      }
      throw err;
    }
  }

  private *interpretExecuting(upper: string, token: string): Generator<StepSignal, void, void> {
    if (upper === ';') {
      throw new Error('; used outside a definition');
    }
    if (upper === 'IMMEDIATE') {
      markLatestImmediate(this);
      yield 'progress';
      return;
    }
    const found = findWord(this, upper);
    if (found) {
      yield* this.inner.executeXT(found.cfa);
      return;
    }
    const n = parseNumber(token, this.getBase());
    if (n === undefined) {
      throw new Error(`? unrecognized word: ${token}`);
    }
    this.stack.push(n);
    yield 'progress';
  }

  private *interpretCompiling(upper: string, token: string): Generator<StepSignal, void, void> {
    if (upper === ':') {
      throw new Error(': cannot nest definitions');
    }
    if (upper === ';') {
      endDefinition(this, findWord(this, 'EXIT')!.cfa);
      yield 'progress';
      return;
    }
    const found = findWord(this, upper);
    if (found) {
      if (found.immediate) {
        yield* this.inner.executeXT(found.cfa);
      } else {
        compileCell(this, found.cfa);
        yield 'progress';
      }
      return;
    }
    const n = parseNumber(token, this.getBase());
    if (n === undefined) {
      throw new Error(`? unrecognized word: ${token}`);
    }
    compileCell(this, findWord(this, 'LIT')!.cfa);
    compileCell(this, n);
    yield 'progress';
  }
}

function parseNumber(token: string, base: number): number | undefined {
  const negative = token.startsWith('-');
  const body = negative ? token.slice(1) : token;
  if (body.length === 0 || !isValidInBase(body, base)) {
    return undefined;
  }
  const n = parseInt(body, base);
  if (Number.isNaN(n)) {
    return undefined;
  }
  return negative ? -n : n;
}

function isValidInBase(s: string, base: number): boolean {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  return [...s.toLowerCase()].every((c) => digits.includes(c));
}
