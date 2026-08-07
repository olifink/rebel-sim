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
 *
 * M7a: `startRepl()` puts the *same* session slot to a different use —
 * a self-contained, never-completing on-screen REPL (prompt, `ACCEPT` a
 * line into the `TIB` bank, interpret, repeat) driven by the host purely
 * through `step()`, with no more per-line `beginLine()` calls from
 * outside. `beginLine()`/`interpret()` remain exactly as before for
 * feeding a line programmatically (tests, mainly) — the two entry points
 * share one session, so only one can be active at a time.
 */

import { Arena } from './arena.js';
import { Bank, BankTable } from './banks.js';
import { DataStack } from './stack.js';
import { Sysvars } from './sysvars.js';
import { PrimitiveContext } from './primitives.js';
import { Screen, ScreenHal } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Channel, CompositeChannel, KeyboardChannel, RemoteChannel } from './channel.js';
import { Storage, StorageHal } from './storage.js';
import { Inner, StepSignal } from './inner.js';
import {
  abortDefinition,
  beginDefinition,
  compileCell,
  DictionaryContext,
  endDefinition,
  findWord,
  FLAG_COMPILE_ONLY,
  FLAG_IMMEDIATE,
  listDictionaryEntries,
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
const TIB_SIZE = 128; // Terminal Input Buffer — generous for a REPL line (M7a)
const PAD_SIZE = 128; // DEVELOPING.md §7, M16: interpreted-mode S" scratch text — sized like TIB, same "generous for one line" reasoning
// M31: both are logical sub-region sizes within one WORK bank now, not
// independent bank-size requests — createBank() rounds the *combined*
// request up to a size class (spec/02-MEMORY-MODEL.md §4.3), same as
// it would for either alone, so merging them costs one XS class
// instead of two.
const WORK_BANK_SIZE = TIB_SIZE + PAD_SIZE;
const DEFAULT_ARENA_SIZE = 1 << 20; // 1 MiB, plenty through M7a

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
  /** Host-supplied project/cart file I/O (localStorage, etc). Defaults to a
   * no-op — openProject()/saveAsset() calls just do nothing useful,
   * which is fine for engine-level tests that don't exercise storage. */
  storageHal?: StorageHal;
  /** What blocking `KEY` binds to (FORTH-ARCHITECTURE.md §7a). Defaults
   * to a `KeyboardChannel` wrapping this Machine's own `keyboard` — a
   * test can inject a fake `Channel` instead. Takes priority over
   * `remoteChannel` below if both are given. */
  channel?: Channel;
  /** M9 (WebMCP): a `RemoteChannel` a host can push() text into (e.g. a
   * WebMCP tool's execute() handler) without displacing the keyboard —
   * when given (and `channel` isn't), input is merged via
   * `CompositeChannel([KeyboardChannel, remoteChannel])` so a human at
   * the keyboard and a remote/agent caller share the same session. */
  remoteChannel?: RemoteChannel;
}

/** `step()`'s return: `'idle'` — no session in flight, nothing to do.
 * `'blocked'` — the session is alive but waiting on the bound channel
 * (e.g. `KEY` with nothing queued); call `step()` again later, once
 * `hasData()` might be true. `'more-to-run'` — the budget ran out before
 * the line finished; call `step()` again to continue it. `'breakpoint'`
 * (DEBUGGING.md, M10) — execution paused right before a breakpointed
 * word's body would run; `pausedAtWord()` names it, `step()` again to
 * resume (same "just call step() again" shape as `'blocked'`, but the
 * caller — not a data source — decides when). Storage (`PROJECT`/`SAVE`/
 * `RESTORE`/`BSAVE`/`BLOAD`) used to need its own suspend/resume status
 * here, back when an OPFS-backed `StorageHal` was Promise-based — now
 * that storage is synchronous (`local-storage-storage-hal.ts`), those
 * are ordinary `primitives.ts` dispatch cases that run to completion
 * inside a single `step()` call, same as any other word. */
export type StepStatus = 'idle' | 'blocked' | 'more-to-run' | 'breakpoint';

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
  // M31 (spec/02-MEMORY-MODEL.md §4.6): TIB and PAD share one WORK
  // bank, at fixed sub-offsets, rather than each independently
  // rounding up to its own XS size class — both are small, transient,
  // per-line scratch text, so co-locating them costs one class instead
  // of two. tibBase/tibSize replace what used to be a standalone
  // `tibBank: Bank` field; padBase/padSize are unchanged in shape,
  // just computed as an offset within workBank now instead of a
  // separate bank's own base.
  private readonly tibBase: number;
  private readonly tibSize: number;
  private readonly acceptCfa: number;
  readonly padBase: number;
  readonly padSize: number;
  private session: Generator<StepSignal, void, void> | undefined;

  /** DEBUGGING.md (M10): word-level breakpoints, a session-local `Set`
   * of `cfa` addresses — not a dictionary header flag (that byte is
   * already fully packed) and not persisted (a debugging aid, not
   * project state). `Machine` owns the `Set` instance so it can expose
   * name-based mutation without `Inner` needing dictionary-lookup logic
   * of its own; `Inner` only ever reads it. */
  private readonly breakpoints = new Set<number>();

  // The outer interpreter's own parse position — M8, CORE-VOCABULARY.md
  // §7: CREATE/VARIABLE/CONSTANT/S" all need to consume the *next* word
  // directly from whatever line is currently being interpreted, even
  // when called from deep inside another word's execution (the
  // `: CONST CREATE , DOES> @ ;` pattern — CREATE, running as part of
  // CONST's own execution, must grab its name from CONST's *caller's*
  // line, e.g. `5 CONST FIVE`, not from CONST's own compiled body).
  // Sharing one mutable cursor via instance fields (rather than a local
  // variable private to tokenizeAndRun) is what makes that possible —
  // the same role classic Forth's >IN plays over a raw input buffer.
  private currentTokens: string[] = [];
  private currentTokenIndex = 0;

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
    // DEVELOPING.md §20, M27: ARENA-SIZE moved out of CORE — it's now
    // MMAP's own header cell (written by mmap.initHeader(), already
    // run as part of `this.banks = new BankTable(this.arena)` above),
    // arena-bookkeeping rather than Forth-interpreter state.

    const charBank = this.banks.createBank('CHAR', charCols * charRows);
    this.screen = new Screen(this.arena, charBank, this.sysvars, options.screenHal);
    this.screen.cls();

    const kmapBank = this.banks.createBank('KMAP', KMAP_BANK_SIZE);
    this.keyboard = new Keyboard(this.arena, this.sysvars, kmapBank);
    this.channel = options.channel
      ?? (options.remoteChannel
            ? new CompositeChannel([new KeyboardChannel(this.keyboard), options.remoteChannel])
            : new KeyboardChannel(this.keyboard));

    this.storage = new Storage(this.arena, this.banks, options.storageHal);

    this.stack = new DataStack(this.arena, dstkBank, this.sysvars, 'SP0', 'SP');
    this.rstack = new DataStack(this.arena, rstkBank, this.sysvars, 'RP0', 'RP');
    this.inner = new Inner(this.arena, this.rstack, this, this.breakpoints);

    for (const p of opcodes.primitives) {
      // M8: some primitives (IF/DO/DOES>/S"/...) must run at compile
      // time (IMMEDIATE) and/or only make sense while compiling
      // (COMPILE_ONLY, docs/FORTH-ARCHITECTURE.md §6's reserved bit 5,
      // unused until now) — flagged per-primitive in rebel-opcodes.json
      // rather than hardcoded here, same source-of-truth discipline as
      // token IDs themselves.
      let flags = 0;
      if ('immediate' in p && p.immediate) flags |= FLAG_IMMEDIATE;
      if ('compileOnly' in p && p.compileOnly) flags |= FLAG_COMPILE_ONLY;
      writeHeader(this, p.name, flags, p.id);
    }

    // M31: TIB and PAD as fixed sub-offsets within one WORK bank —
    // see the field-declaration comment above for why.
    const workBank = this.banks.createBank('WORK', WORK_BANK_SIZE, 'WORK');
    this.tibBase = workBank.base;
    this.tibSize = TIB_SIZE;
    this.acceptCfa = findWord(this, 'ACCEPT')!.cfa;

    this.padBase = workBank.base + TIB_SIZE;
    this.padSize = PAD_SIZE;
  }

  getBase(): number {
    return this.sysvars.getBase();
  }

  /** Consumes and returns the next word from whatever line is currently
   * being interpreted (§7's shared-cursor mechanism, above). Throws if
   * the input is exhausted — matching how `:` already fails loudly
   * (`beginDefinition`) when a name is missing, rather than silently
   * returning something meaningless. */
  nextInputToken(): string {
    if (this.currentTokenIndex >= this.currentTokens.length) {
      throw new Error('expected a name, but the input ended');
    }
    return this.currentTokens[this.currentTokenIndex++];
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
   * no reason); `'breakpoint'` the instant the session yields one
   * (DEBUGGING.md, M10) — same never-busy-spin reasoning, except here
   * it's an explicit caller decision, not a data source, that resolves
   * it; `'more-to-run'` if the budget ran out first; `'idle'` once the
   * session actually finishes (and clears it). An error thrown
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
        if (value === 'breakpoint') {
          return 'breakpoint';
        }
      }
      return 'more-to-run';
    } catch (err) {
      this.session = undefined;
      throw err;
    }
  }

  /** DEBUGGING.md (M10): arm a word-level breakpoint by name — `step()`
   * will return `'breakpoint'` right before that word's body next runs,
   * every time it's entered (recursive/looped calls each re-break; see
   * `Inner.checkBreakpoint`'s doc comment). Throws on an unknown word,
   * matching how the outer interpreter itself fails loudly on one
   * (`interpretExecuting`'s `? unrecognized word` case) — and throws on
   * a non-`breakable` one (a primitive, `CONSTANT`, or plain
   * `CREATE`/`VARIABLE` with no `DOES>`) rather than silently accepting
   * a breakpoint that could never fire (`Inner.checkBreakpoint` only
   * ever checks `DOCOL`/`DODOES` entry points). */
  setBreakpoint(name: string): void {
    const found = findWord(this, name);
    if (!found) {
      throw new Error(`unrecognized word: ${name}`);
    }
    if (!found.breakable) {
      throw new Error(`${found.name} has no compiled body to break on (not a colon-definition or DOES>'d word)`);
    }
    this.breakpoints.add(found.cfa);
  }

  /** Disarms a breakpoint set via `setBreakpoint()`. A no-op (not an
   * error) if the word has no breakpoint set — clearing is idempotent,
   * unlike setting on an unknown word. */
  clearBreakpoint(name: string): void {
    const found = findWord(this, name);
    if (!found) {
      throw new Error(`unrecognized word: ${name}`);
    }
    this.breakpoints.delete(found.cfa);
  }

  /** Names of all currently-armed breakpoints. */
  listBreakpoints(): string[] {
    return listDictionaryEntries(this)
      .filter((e) => this.breakpoints.has(e.cfa))
      .map((e) => e.name);
  }

  /** Name of the word `step()` most recently paused at (`Inner.pausedAtXt`),
   * or `undefined` if nothing has ever triggered a breakpoint this
   * session. Only meaningful immediately after `step()` returns
   * `'breakpoint'` — once execution resumes past it, this keeps
   * returning the same (now stale) name until the next breakpoint hit,
   * so callers should gate on `step()`'s own return value, not this. */
  pausedAtWord(): string | undefined {
    const xt = this.inner.pausedAtXt;
    if (xt === undefined) {
      return undefined;
    }
    return listDictionaryEntries(this).find((e) => e.cfa === xt)?.name;
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

  /** Starts the self-contained on-screen REPL (M7a): `ACCEPT` a line onto
   * the screen, interpret it, print `ok`/`? <message>`, repeat forever —
   * the visible on-screen interaction a real Forth machine has, not a
   * separate DOM scrollback pane. No `> ` prompt glyph is drawn — a real
   * Forth doesn't print one either, `ok`/an error is the only "ready"
   * signal (DEVELOPING.md's REPL-formatting entry). Uses the same
   * `session`/`step()` machinery as `beginLine()`; the two are mutually
   * exclusive (only one session at a time, CHANNELS-DESIGN.md §4) — don't
   * call `beginLine()`/`interpret()` externally once this is running.
   * Errors print directly to the screen (`? <message>`) and the loop
   * continues; they never escape this call the way they would from
   * `step()` after `beginLine()`. */
  startRepl(): void {
    if (this.session) {
      throw new Error('a previous line is still running or blocked — call step() to continue it');
    }
    // DEVELOPING.md §17/§18, M25/M26: the interactive on-screen REPL
    // shows a live cursor from its very first prompt — deliberately
    // scoped to *this* entry point, not Machine's constructor (would
    // make every programmatic interpret()/beginLine() caller, tests
    // included, pay for cursor redraws it never asked for) and not
    // packages/app (keeps this REPL-level behavior, not app-specific
    // UI policy — any host driving startRepl() gets it for free).
    this.screen.showCursor();
    this.session = this.replLoop();
  }

  private *replLoop(): Generator<StepSignal, void, void> {
    while (true) {
      this.stack.push(this.tibBase);
      this.stack.push(this.tibSize);
      yield* this.inner.executeXT(this.acceptCfa);
      const len = this.stack.pop();

      let line = '';
      for (let i = 0; i < len; i++) {
        line += String.fromCharCode(this.arena.readByte(this.tibBase + i));
      }

      // No CR here: real Forth doesn't print one for <enter> either — a
      // real terminal's own local echo supplies that CR, not the Forth
      // system. This screen has no such terminal underneath it, so a
      // single space stands in as the separator between the typed line
      // and the status text that follows, instead of faking a newline.
      this.screen.emit(32);
      yield 'progress';

      try {
        yield* this.tokenizeAndRun(line);
        this.emitString('ok');
      } catch (err) {
        if (this.sysvars.getState() === -1) {
          abortDefinition(this);
        }
        // DEVELOPING.md §9, M17: any uncaught error gets back to a
        // genuinely clean prompt, not just a printed message — fixes a
        // real, confirmed bug (threadFrom's rstack sentinel push has no
        // try/finally, so it leaks one entry per uncaught error
        // otherwise) and makes ABORT's own behavior the same thing every
        // other error already does, not a special case. Deliberately
        // NOT applied to interpret()/runLine() — that's a separate,
        // unchanged contract for programmatic callers.
        this.stack.clear();
        this.rstack.clear();
        const message = err instanceof Error ? err.message : String(err);
        this.emitString(`? ${message}`);
      }
      // The trailing CR belongs to the status text (`ok`/`? ...`), not
      // to the next prompt — matches real Forth's `ok\n`, printed once
      // ready, rather than a leading CR pushed out ahead of the prompt.
      this.screen.emit(10);
      yield 'progress';
    }
  }

  private emitString(s: string): void {
    for (const ch of s) {
      this.screen.emit(ch.charCodeAt(0));
    }
  }

  private *runLine(line: string): Generator<StepSignal, void, void> {
    try {
      yield* this.tokenizeAndRun(line);
    } catch (err) {
      if (this.sysvars.getState() === -1) {
        abortDefinition(this);
      }
      throw err;
    }
  }

  private *tokenizeAndRun(line: string): Generator<StepSignal, void, void> {
    this.currentTokens = line.trim().split(/\s+/).filter(Boolean);
    this.currentTokenIndex = 0;
    while (this.currentTokenIndex < this.currentTokens.length) {
      const token = this.nextInputToken();
      const upper = token.toUpperCase();

      if (this.sysvars.getState() === -1) {
        yield* this.interpretCompiling(upper, token);
      } else {
        if (upper === ':') {
          beginDefinition(this, this.nextInputToken(), DOCOL);
          yield 'progress';
          continue;
        }
        yield* this.interpretExecuting(upper, token);
      }
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
      if (found.compileOnly) {
        throw new Error(`${upper} is compile-only — used outside a colon-definition`);
      }
      yield* this.inner.executeXT(found.cfa);
      return;
    }
    const n = parseNumber(token, this.getBase());
    if (n === undefined) {
      throw new Error(`unrecognized word: ${token}`);
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
      throw new Error(`unrecognized word: ${token}`);
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
