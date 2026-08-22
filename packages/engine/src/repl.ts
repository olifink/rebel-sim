/**
 * The outer interpreter / compiler (FORTH-ARCHITECTURE.md §4's STATE
 * sysvar drives the split): tokenizes a line and, per token, either
 * executes it (interpreting) or compiles a call/literal into the
 * definition under construction (compiling) — the classic Forth
 * text-interpreter loop.
 *
 * M43 (spec/04-FORTH-CORE.md §5.2/§6.13): the *real* outer interpreter
 * is self-hosted Forth source now — `INTERPRET`, `FIND`, `NUMBER`, `[`,
 * `]` (`system.fth`), built on native `WORD`/`STATE` and the now-
 * ordinary-dictionary-entry `:`/`;`/`IMMEDIATE`/`COMPILE-ONLY`
 * primitives (`primitives.ts`) — findable via `FIND`, listed by
 * `WORDS`, never special-cased by spelling. What lives in *this* file
 * (`tokenizeAndRun`/`interpretExecuting`/`interpretCompiling`, driven
 * through `dispatchLine()`) is the **native fallback**: the mechanism
 * that loads `system.fth` itself (nothing can call `INTERPRET` before
 * it's defined), and — by design, not just as a bootstrapping
 * artifact — the ongoing path for any `Machine` that never loads a
 * bootstrap layer at all, which most engine-level tests deliberately
 * don't, to exercise a primitive in isolation. `dispatchLine()` is the
 * one place that decides which of the two actually runs a given line.
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
import { Bank, BankTable, BLOCK_SIZE } from './banks.js';
import { DataStack } from './stack.js';
import { Sysvars } from './sysvars.js';
import { PrimitiveContext, WarmReset } from './primitives.js';
import { Screen, ScreenHal } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Channel, CompositeChannel, KeyboardChannel, RemoteChannel } from './channel.js';
import { Storage, StorageHal } from './storage.js';
import { NULL_TIMING_HAL, TimingHal } from './timing.js';
import { Inner, StepSignal } from './inner.js';
import {
  abortDefinition,
  compileCell,
  DictionaryContext,
  findWord,
  FLAG_COMPILE_ONLY,
  FLAG_IMMEDIATE,
  listDictionaryEntries,
  writeHeader,
} from './dictionary.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const SYSV_BANK_SIZE = 4096; // 4 KiB, matches Rebel-ROM's XS size class (docs/SYSVARS.md §1)
const DSTK_BANK_SIZE = 4096; // 1024 cells
const RSTK_BANK_SIZE = 4096; // 1024 cells
const DICT_BANK_SIZE = 1 << 16; // 64 KiB
const KMAP_BANK_SIZE = 4096; // 4 KiB, matches Rebel-ROM's XS size class (docs/KEYBOARD.md §6); table itself is 512 bytes
// spec/04-FORTH-CORE.md §5.3/§6.13: the TIB now has to physically hold
// every line fed to the outer interpreter (WORD scans real arena bytes,
// not a JS string) — bumped from 128 once system.fth's own longest line
// (XT-NAME's definition, 144 chars) needed to fit inside it.
const TIB_SIZE = 256; // Terminal Input Buffer — generous for a REPL line (M7a)
const SPACE_CHAR_CODE = 32; // BL — the delimiter nextInputToken()/the native fallback tokenizer scan on
const PAD_SIZE = 128; // DEVELOPING.md §7, M16: interpreted-mode S" scratch text — sized like TIB, same "generous for one line" reasoning
// M31: both are logical sub-region sizes within one WORK bank now, not
// independent bank-size requests — createBank() rounds the *combined*
// request up to a size class (spec/02-MEMORY-MODEL.md §4.3), same as
// it would for either alone, so merging them costs one XS class
// instead of two.
const WORK_BANK_SIZE = TIB_SIZE + PAD_SIZE;
// FORTH-ARCHITECTURE.md §7: generic 1024-byte-block-addressable storage
// (renamed from SCRS 2026-08-18) — (BLOCK-READ)/(BLOCK-WRITE) (140/141,
// primitives.ts) are the only primitives that touch it directly. 16
// blocks rounds to exactly the S size class, no rounding waste.
const BLKS_BANK_SIZE = 16 * BLOCK_SIZE; // 16 KiB
const DEFAULT_ARENA_SIZE = 1 << 20; // 1 MiB, plenty through M7a

// M3 boot-time screen mode. Rebel-ROM has no runtime mode-change
// mechanism yet either (docs/SCREEN-MODULE.md §9's "mode-change
// ownership: deferred") — Rebel-Sim boots into this mode and stays.
// 640x480 (80x60 chars at 8x8), settled Oliver, M54: an earlier 320x240
// -> 512x384 bump was dialed back after 640x480 first read as
// bigger-than-needed, but 80 columns turned out to suit the editor
// better than the original 512-wide assumption (which was sized around
// a full-screen editor matching 1024-byte blocks) — kept, not
// experimental. Matches app.ts's FRAMEBUFFER_WIDTH/HEIGHT (kept in sync
// by hand, no shared constant between the two packages).
const DEFAULT_SCREEN_WIDTH = 640;
const DEFAULT_SCREEN_HEIGHT = 480;
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
  /** Host-supplied monotonic clock (spec/01-HAL.md §7) — `performance.now()`
   * in the browser. Defaults to a fixed no-op clock: nothing in the engine
   * reads elapsed time yet, so this only establishes the HAL contract for
   * a future consumer (e.g. a `DELAY` word) to build against. */
  timingHal?: TimingHal;
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
 * inside a single `step()` call, same as any other word. `'cold'`
 * (rebel-opcodes.json 132): `COLD` was just executed — the engine itself
 * makes no state change for this (see inner.ts's `dispatch()`); the host
 * is expected to discard this `Machine` and construct a fresh one
 * (PORTING-WEB.md). */
export type StepStatus = 'idle' | 'blocked' | 'more-to-run' | 'breakpoint' | 'cold';

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
  readonly timingHal: TimingHal;
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
  /** spec/04-FORTH-CORE.md §5.6/M43: `INTERPRET`'s own `cfa`, resolved
   * lazily and cached the first time `dispatchLine()` finds it in the
   * dictionary — `undefined` for the lifetime of any `Machine` that never
   * loads a bootstrap layer at all (most engine-level tests), by design
   * (see `dispatchLine()`'s own comment). */
  private interpretCfa: number | undefined;

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
  //
  // spec/04-FORTH-CORE.md §5.3/§6.13 (M43): this cursor now points into
  // *real arena memory* (the TIB), not a pre-split JS string array —
  // WORD (§6.13) has to return an (addr, len) view into the live input
  // line, which a JS array has no address for at all. `inputPos` is the
  // current scan position, `inputEnd` one past the current line's last
  // byte; both absolute arena addresses within [tibBase, tibBase+tibSize).
  private inputPos = 0;
  private inputEnd = 0;

  constructor(options: MachineOptions = {}) {
    this.arena = new Arena(options.arenaSize ?? DEFAULT_ARENA_SIZE);
    this.banks = new BankTable(this.arena);
    // Named explicitly, matching tag, same as WORK/EDITOR below — BANK@/
    // BANK-SIZE resolve by name now, not tag (tags are expected to
    // repeat once multiple banks share one, name is the real unique
    // identity), so every boot bank needs a real name instead of an
    // auto-generated serial for `BANK@ SYSV`-style lookups to keep
    // working at all.
    const sysvBank = this.banks.createBank('SYSV', SYSV_BANK_SIZE, 'SYSV');
    const dstkBank = this.banks.createBank('DSTK', DSTK_BANK_SIZE, 'DSTK');
    const rstkBank = this.banks.createBank('RSTK', RSTK_BANK_SIZE, 'RSTK');
    this.dictBank = this.banks.createBank('DICT', DICT_BANK_SIZE, 'DICT');

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

    const charBank = this.banks.createBank('CHAR', charCols * charRows, 'CHAR');
    this.screen = new Screen(this.arena, charBank, this.sysvars, options.screenHal);
    this.screen.cls();

    const kmapBank = this.banks.createBank('KMAP', KMAP_BANK_SIZE, 'KMAP');
    this.keyboard = new Keyboard(this.arena, this.sysvars, kmapBank);
    this.channel = options.channel
      ?? (options.remoteChannel
            ? new CompositeChannel([new KeyboardChannel(this.keyboard), options.remoteChannel])
            : new KeyboardChannel(this.keyboard));

    this.storage = new Storage(this.arena, this.banks, options.storageHal);
    this.timingHal = options.timingHal ?? NULL_TIMING_HAL;

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

    // FORTH-ARCHITECTURE.md §7: generic block storage, boot-created like
    // every other bank — (BLOCK-READ)/(BLOCK-WRITE) (140/141) resolve it
    // by tag via ctx.banks.requireBank('BLKS'), same pattern BANK@ uses.
    // Named 'EDITOR', not 'BLKS' — tag stays the generic, HAL-level
    // "1024-byte block storage" identity (M45's SCRS->BLKS rename is
    // still the right call), but `name` is real per-bank identity
    // (uniqueness is enforced on it, multiple banks are expected to
    // share a tag) and the bank monitor's own display column, so it's
    // free to say what THIS instance is actually for — today, the only
    // consumer is the Screen Editor (LOAD/LIST/BLOCK/BUFFER/UPDATE/
    // FLUSH). Cosmetic/persistence-only: BANK@/requireBank('BLKS') look
    // up by tag, never name, and an existing saved project's own
    // already-baked-in name keeps restoring correctly regardless of
    // this boot-time default (RESTORE replaces the whole bank table
    // from the save file itself) — only a project saved after this
    // change gets the new 'EDITOR.BLK' asset basename.
    const blksBank = this.banks.createBank('BLKS', BLKS_BANK_SIZE, 'EDITOR');
    // Screen Editor follow-up: space-filled, not the zero bytes a fresh
    // bank would otherwise hold — NUL isn't BL, so the outer
    // interpreter's own BL-delimited WORD scan (system.fth's LOAD/LIST)
    // would read a run of raw NUL bytes as one long unrecognized token
    // and ABORT the instant anything touched an untouched screen. A
    // native fillBytes() call here is instant; doing this in Forth via
    // 16 screens' worth of DO/LOOP-driven FILL calls (tried first) added
    // over a second to every boot — negligible content, real dispatch
    // cost, times 16 KiB of individual token-threaded steps.
    this.arena.fillBytes(blksBank.base, BLKS_BANK_SIZE, SPACE_CHAR_CODE);
  }

  getBase(): number {
    return this.sysvars.getBase();
  }

  /** spec/04-FORTH-CORE.md §6.13's `WORD` contract, and the single real
   * implementation everything else in this class builds on: skip leading
   * `delimiterCode` bytes from the shared cursor, read non-delimiter
   * bytes up to the next `delimiterCode` or end of line, consume the
   * trailing delimiter too (if one was actually hit, as opposed to
   * running out of line), and return a *view* into the TIB — never a
   * copy. `len === 0` means the line is exhausted; never throws. */
  wordScan(delimiterCode: number): { addr: number; len: number } {
    while (this.inputPos < this.inputEnd && this.arena.readByte(this.inputPos) === delimiterCode) {
      this.inputPos++;
    }
    const start = this.inputPos;
    while (this.inputPos < this.inputEnd && this.arena.readByte(this.inputPos) !== delimiterCode) {
      this.inputPos++;
    }
    const len = this.inputPos - start;
    if (this.inputPos < this.inputEnd) {
      this.inputPos++; // consume the delimiter that stopped the scan
    }
    return { addr: start, len };
  }

  /** FORTH-ARCHITECTURE.md §7's `LOAD` (screen-source interpretation):
   * the one thing no existing primitive exposed — every prior consumer of
   * the shared cursor (`ACCEPT`'s own `replLoop` step, `loadLineIntoTib`
   * above) only ever pointed it at the TIB. `LOAD` needs to point it at an
   * arbitrary `BLOCK`-returned buffer address instead, so the exact same
   * `WORD`/`FIND`/`NUMBER`/`INTERPRET` machinery can read a screen's line
   * as if it had been typed. Deliberately a thin, direct field-set — no
   * bounds/bank validation here, same trust-the-caller precedent `WORD`
   * itself already has (`len === 0` just means "nothing to read", never a
   * thrown error). */
  setInput(addr: number, len: number): void {
    this.inputPos = addr;
    this.inputEnd = addr + len;
  }

  private decodeBytes(addr: number, len: number): string {
    let s = '';
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(this.arena.readByte(addr + i));
    }
    return s;
  }

  /** Consumes and returns the next word from whatever line is currently
   * being interpreted (§7's shared-cursor mechanism, above) — a thin
   * decode wrapper over `wordScan`, kept as the one thing every native
   * raw-token-consuming primitive (`CREATE`, `BANK@`, `'`, `S"`, ...)
   * still calls; none of them needed to change when the cursor moved
   * from a JS array onto real TIB bytes. Throws if the input is
   * exhausted — matching how `:` already fails loudly (`beginDefinition`)
   * when a name is missing, rather than silently returning something
   * meaningless. */
  nextInputToken(): string {
    const { addr, len } = this.wordScan(SPACE_CHAR_CODE);
    if (len === 0) {
      throw new Error('expected a name, but the input ended');
    }
    return this.decodeBytes(addr, len);
  }

  /** Writes `line` into the TIB and resets the shared cursor to its
   * start — the programmatic-caller (`interpret()`/`beginLine()`)
   * equivalent of what `ACCEPT` already does for the on-screen REPL
   * (`replLoop`, below), which sets the same two fields directly since
   * its bytes are already physically in the TIB. */
  private loadLineIntoTib(line: string): void {
    if (line.length > this.tibSize) {
      throw new Error(`line exceeds the TIB's ${this.tibSize}-byte capacity: ${line.length} bytes`);
    }
    for (let i = 0; i < line.length; i++) {
      this.arena.writeByte(this.tibBase + i, line.charCodeAt(i) & 0xff);
    }
    this.inputPos = this.tibBase;
    this.inputEnd = this.tibBase + line.length;
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
        if (value === 'cold') {
          return 'cold';
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

      // ACCEPT's bytes already live in the TIB — just point the shared
      // cursor at them directly, no JS-string round-trip needed (M43:
      // tokenizeAndRun reads the cursor now, not a `line` parameter).
      this.inputPos = this.tibBase;
      this.inputEnd = this.tibBase + len;

      // No CR here: real Forth doesn't print one for <enter> either — a
      // real terminal's own local echo supplies that CR, not the Forth
      // system. This screen has no such terminal underneath it, so a
      // single space stands in as the separator between the typed line
      // and the status text that follows, instead of faking a newline.
      this.screen.emit(32);
      yield 'progress';

      try {
        yield* this.dispatchLine();
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
        if (err instanceof WarmReset) {
          // WARM already did this same clearing itself (primitives.ts,
          // case 131) before throwing — landing back here is success,
          // classic Forth WARM/QUIT semantics: the rest of the line is
          // abandoned, same as any other error, but it's not one, so
          // the prompt reads "ok", not "? ...".
          this.emitString('ok');
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.reportError(message);
        }
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

  /** This target's realization of `hal_report_error` (spec/01-HAL.md
   * §8.1) — the sink an uncaught error/ABORT path reports through on its
   * way back to a clean prompt. Rebel-Sim's only reporting surface is the
   * screen (no serial/UART concept in a browser), so unlike Screen/
   * Storage/Timing this is a plain internal method, not a host-injectable
   * HAL: there is exactly one real implementation on this target, nothing
   * varies per host. Safe to call from a partially-failed interpreter
   * state and reentrantly — it only ever calls `screen.emit()`, already
   * true of `emitString()` above with no additional state of its own. */
  private reportError(message: string): void {
    this.emitString(`? ${message}`);
  }

  private *runLine(line: string): Generator<StepSignal, void, void> {
    this.loadLineIntoTib(line);
    try {
      yield* this.dispatchLine();
    } catch (err) {
      if (this.sysvars.getState() === -1) {
        abortDefinition(this);
      }
      // WarmReset (primitives.ts, case 131) already cleared both stacks
      // itself before throwing — landing back here is WARM's normal,
      // successful completion (classic Forth WARM/QUIT semantics: the
      // rest of the line is abandoned), not a genuine error, so unlike
      // every other caught error here it isn't rethrown to the
      // programmatic caller. Kept as its own branch rather than folded
      // into replLoop()'s handling above so interpret()/beginLine() get
      // the identical "does not throw" contract the interactive REPL
      // does, deliberately breaking from this method's usual
      // don't-touch-programmatic-callers stance for this one case.
      if (err instanceof WarmReset) {
        return;
      }
      throw err;
    }
  }

  /** spec/04-FORTH-CORE.md §5.6: the actual driving-loop dispatch this
   * document describes — "read a line into the input buffer, reset the
   * shared cursor, call INTERPRET, repeat." Threads through the real,
   * self-hosted `INTERPRET` (`system.fth`) once it exists in the
   * dictionary — one call per line; `INTERPRET`'s own Forth body loops
   * internally via repeated `WORD` calls until the line is exhausted.
   * Falls back to the native tokenizer otherwise, which is what makes
   * loading `system.fth` itself possible in the first place (nothing
   * calls `INTERPRET` before it's defined) and, by design (not merely a
   * bootstrapping artifact), the ongoing path for any `Machine` that
   * never loads a bootstrap layer at all — most engine-level tests
   * construct a bare one deliberately, to exercise a primitive in
   * isolation, and keep working completely unchanged. Production
   * (`app.ts`, any real REPL session) always boots through `system.fth`
   * first, so it always runs the genuine self-hosted path. `cfa` is
   * resolved once and cached (`interpretCfa`) rather than chain-walked
   * on every single line, since it never goes away once found — `COLD`
   * aside, which reconstructs an entirely fresh `Machine`, not this
   * cached field on an existing one. */
  private *dispatchLine(): Generator<StepSignal, void, void> {
    if (this.interpretCfa === undefined) {
      const found = findWord(this, 'INTERPRET');
      if (found) {
        this.interpretCfa = found.cfa;
      }
    }
    if (this.interpretCfa !== undefined) {
      yield* this.inner.executeXT(this.interpretCfa);
    } else {
      yield* this.tokenizeAndRun();
    }
  }

  /** The native fallback outer-interpreter loop (spec/04-FORTH-CORE.md
   * §5.1–§5.4) — reads from whatever `[inputPos, inputEnd)` the caller
   * already set up (`runLine`/`replLoop`), via `wordScan` rather than a
   * pre-split JS array (M43), so it shares the exact same cursor a
   * native primitive like `CREATE` (`nextInputToken()`) or a future
   * Forth-level `WORD` call would also be walking. */
  private *tokenizeAndRun(): Generator<StepSignal, void, void> {
    while (true) {
      const { addr, len } = this.wordScan(SPACE_CHAR_CODE);
      if (len === 0) {
        return;
      }
      const token = this.decodeBytes(addr, len);
      const upper = token.toUpperCase();

      if (this.sysvars.getState() === -1) {
        yield* this.interpretCompiling(upper, token);
      } else {
        yield* this.interpretExecuting(upper, token);
      }
    }
  }

  /** spec/04-FORTH-CORE.md §5.2/M43: `:`/`;`/`IMMEDIATE`/`COMPILE-ONLY`
   * are ordinary dictionary entries now (`primitives.ts` cases 136–139)
   * — this dispatcher no longer special-cases any of them by spelling,
   * only by the same `compileOnly`/`immediate` dictionary properties
   * every other word is judged by. */
  private *interpretExecuting(upper: string, token: string): Generator<StepSignal, void, void> {
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
