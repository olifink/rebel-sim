/**
 * The inner interpreter's DOCOL branch (FORTH-ARCHITECTURE.md §5):
 * executing a dictionary entry whose Code Field is a primitive dispatches
 * directly (primitives.ts); executing one whose Code Field is DOCOL means
 * "the Parameter Field is a list of further token offsets [XTs]" — walk
 * them via an explicit IP register and a real RSTK-backed return stack
 * (not JS recursion), so a runaway/deep call chain hits the RSTK bank's
 * own bounds check instead of a host stack overflow.
 *
 * EXIT and LIT are primitive token IDs but are special-cased here rather
 * than in primitives.ts's switch, because both need to mutate IP — an
 * inner-interpreter register that a plain stack-effect primitive
 * (PrimitiveContext) has no access to. ACCEPT (M7a) is special-cased for
 * a different reason: it's not just IP-mutating, it's a *multi-step*
 * blocking operation (one suspend point per character read) — something
 * a single `executePrimitive` switch case, which runs to completion in
 * one synchronous call, has no way to express. Its whole read-echo-
 * backspace loop lives here instead, built out of the same `StepSignal`
 * yields as everything else.
 *
 * M8 (CORE-VOCABULARY.md) adds four more IP-level concerns, all for the
 * same underlying reason as LIT/EXIT — a plain primitive can't touch
 * `ip` or the return stack:
 * - `BRANCH`/`0BRANCH` (§6): read the next cell as a jump target.
 * - `(DOES>)` (§7): rewrites LATEST's own Code Field to `dodoesTokenId`
 *   and stores the *current* `ip` (which, since this dispatch already
 *   advanced past its own slot, is exactly the address of the code
 *   `DOES>` was followed by) as that word's does-pointer, then unwinds
 *   the return stack exactly like EXIT — "run once, at compile-target-
 *   definition time, to wire up a does-pointer, then bail out."
 * - `(SLIT)` (§8): LIT generalized from one cell to a length-prefixed
 *   byte run — pushes (ip, length) as a string's addr/len, then skips
 *   `ip` past the bytes (cell-aligned) instead of past one fixed cell.
 * - `dovarTokenId`/`dodoesTokenId` themselves are Code Field *sentinels*
 *   (same tier as `DOCOL`, checked once at the top of `executeXT`, never
 *   inside the slot loop) — what a `CREATE`d or `DOES>`'d word's own
 *   entry actually holds. (A third such sentinel, `doconTokenId`, existed
 *   through M41 for `CONSTANT`'s dedicated dispatch — removed per
 *   spec/04-FORTH-CORE.md §4.1: `CONSTANT` is fully expressible as
 *   `CREATE , DOES> @`, `system.fth`, so a fourth Code-Field case bought
 *   nothing this document's own dispatch/breakpoint/decompile mechanisms
 *   didn't already have to special-case for `DODOES` anyway.)
 *   `DODOES` threads into compiled code exactly like `DOCOL` (shares
 *   `threadFrom()` below), just starting from a stored does-pointer
 *   instead of `xt + CELL`, and pushing a parameter-field address onto
 *   the data stack first.
 *
 * M7 (FORTH-ARCHITECTURE.md §7a): `executeXT` is a generator rather than
 * a plain function, so execution can suspend mid-word-body and resume
 * later — the mechanism blocking `KEY` needs. This was a natural
 * conversion specifically *because* nested DOCOL calls were already
 * threaded through an explicit ip+rstack loop rather than JS recursion
 * (M2's own design note) — there's no call-stack depth to preserve
 * across a suspend, only the loop-local `ip` variable, which a generator
 * already keeps alive across `yield` for free. Each `yield` carries a
 * `StepSignal`: `'progress'` after one slot/primitive is fully executed,
 * or `'blocked'` (possibly several times in a row) while KEY's dispatch
 * waits on `ctx.channel.hasData()` — the *same* token is retried on each
 * resume; nothing about it re-executes until data is actually available.
 *
 * DEBUGGING.md (M10): a third yield, `'breakpoint'`, reuses this exact
 * suspend/resume shape for word-level breakpoints — `checkBreakpoint()`
 * yields once right before threading into a compiled word's body
 * whose `cfa` is in the (session-local, `Machine`-owned) breakpoint
 * set, then resuming (another `.next()`) continues right past it into
 * the normal entry logic, no different from how `'blocked'` retries
 * the same token until data shows up.
 */

import { Arena, alignCell, CELL_SIZE as CELL } from './arena.js';
import { DataStack } from './stack.js';
import { NAME_LEN_MASK } from './dictionary.js';
import { executePrimitive, PrimitiveContext, projectNeedsRestart, restoreProject } from './primitives.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const DOCOL = opcodes.docolTokenId;
const DOVAR_TOKEN = opcodes.dovarTokenId;
const DODOES_TOKEN = opcodes.dodoesTokenId;

const EXIT_TOKEN = opcodes.primitives.find((p) => p.name === 'EXIT')!.id;
const LIT_TOKEN = opcodes.primitives.find((p) => p.name === 'LIT')!.id;
const KEY_TOKEN = opcodes.primitives.find((p) => p.name === 'KEY')!.id;
const ACCEPT_TOKEN = opcodes.primitives.find((p) => p.name === 'ACCEPT')!.id;
const BRANCH_TOKEN = opcodes.primitives.find((p) => p.name === 'BRANCH')!.id;
const ZBRANCH_TOKEN = opcodes.primitives.find((p) => p.name === '0BRANCH')!.id;
const DOES_TOKEN = opcodes.primitives.find((p) => p.name === '(DOES>)')!.id;
const SLIT_TOKEN = opcodes.primitives.find((p) => p.name === '(SLIT)')!.id;
const EXECUTE_TOKEN = opcodes.primitives.find((p) => p.name === 'EXECUTE')!.id;
const COLD_TOKEN = opcodes.primitives.find((p) => p.name === 'COLD')!.id;
const RESTORE_TOKEN = opcodes.primitives.find((p) => p.name === 'RESTORE')!.id;

/** Not a valid arena offset (offsets are unsigned), so it's safe as the
 * return-stack sentinel meaning "top-level call, stop when popped." */
const TOP_LEVEL_SENTINEL = -1;

const CHAR_BACKSPACE = 8;
const CHAR_ENTER = 10;
const CHAR_SPACE = 32;
const FALSE_VALUE = 0;

export type StepSignal = 'progress' | 'blocked' | 'breakpoint' | 'cold' | 'restart-project';

export class Inner {
  /** Set by `checkBreakpoint()` right before a `'breakpoint'` yield —
   * the `cfa` of the word about to run, so `Machine.pausedAtWord()`
   * (repl.ts) can resolve a name without `StepSignal` itself needing to
   * carry a payload. Stale once execution has moved on; callers should
   * only read this while genuinely paused (`step()` just returned
   * `'breakpoint'`). */
  pausedAtXt: number | undefined;

  /** M54: set right before a `'restart-project'` yield — the project
   * name a resize-triggered `RESTORE` needs the host to reboot straight
   * back into (`Machine.pendingRestartProject()`), same "payload lives
   * on `Inner`, not the `StepSignal` itself" shape as `pausedAtXt`
   * above. Stale once a fresh `Machine` exists; only meaningful
   * immediately after `step()` returns `'restart-project'`. */
  restartAtProject: string | undefined;

  constructor(
    private readonly arena: Arena,
    private readonly rstack: DataStack,
    private readonly ctx: PrimitiveContext,
    /** DEBUGGING.md: word-level breakpoints, a session-local `Set` of
     * `cfa` addresses owned by `Machine` (not a dictionary header flag —
     * that byte is already fully packed, and the header layout is a
     * fixed cross-target contract not worth growing for a debug-only,
     * session-local concern). */
    private readonly breakpoints: Set<number>,
  ) {}

  /** Checked right before threading into a compiled word's body — both
   * at top-level entry (`executeXT`'s own `DOCOL`/`DODOES_TOKEN`
   * branches) and on every nested call (`threadFrom`'s). Deliberately
   * not an if/else around the rest of the call: `yield 'breakpoint'`
   * just pauses, and resuming (another `.next()`) continues right after
   * it into the normal entry logic — no extra "already broke here"
   * state needed, so a recursive or looped call to the same word
   * correctly re-breaks every time. */
  private *checkBreakpoint(xt: number): Generator<StepSignal, void, void> {
    if (this.breakpoints.has(xt)) {
      this.pausedAtXt = xt;
      yield 'breakpoint';
    }
  }

  /** Executes the word whose Code Field lives at `xt`, yielding once per
   * completed step (or repeatedly while blocked) rather than running to
   * completion in one call — drive it with `for (const _ of gen) {}` for
   * the old run-to-completion behavior, or step it incrementally. */
  *executeXT(xt: number): Generator<StepSignal, void, void> {
    const codeField = this.arena.readCell(xt);

    if (codeField === LIT_TOKEN) {
      throw new Error('LIT used outside a compiled word body');
    }
    if (codeField === EXIT_TOKEN) {
      throw new Error('EXIT used outside a compiled word body');
    }
    if (codeField === BRANCH_TOKEN || codeField === ZBRANCH_TOKEN) {
      throw new Error('BRANCH/0BRANCH used outside a compiled word body');
    }
    if (codeField === DOES_TOKEN) {
      throw new Error('DOES> used outside a compiled word body');
    }
    if (codeField === SLIT_TOKEN) {
      throw new Error('S"/." used outside a compiled word body');
    }

    if (codeField === DOVAR_TOKEN) {
      // CREATE/VARIABLE, before any DOES> — push the address *past* the
      // leading does-pointer cell every DOVAR-coded word reserves
      // (primitives.ts's CREATE/VARIABLE cases), no threading. This is
      // "the parameter field" as CREATE's own contract describes it —
      // the does-pointer slot is bookkeeping, not part of it.
      this.ctx.stack.push(xt + CELL + CELL);
      return;
    }
    if (codeField === DODOES_TOKEN) {
      // A CREATE...DOES> word: push the address *past* the leading
      // does-pointer cell (the word's own data, e.g. what `,` stored),
      // then thread into the code the does-pointer points at, same as
      // DOCOL threading into a parameter field.
      yield* this.checkBreakpoint(xt);
      this.ctx.stack.push(xt + CELL + CELL);
      yield* this.threadFrom(this.arena.readCell(xt + CELL));
      return;
    }
    if (codeField !== DOCOL) {
      yield* this.dispatch(codeField);
      return;
    }

    yield* this.checkBreakpoint(xt);
    yield* this.threadFrom(xt + CELL);
  }

  /** The shared DOCOL/DODOES threading loop: walk compiled XT slots
   * starting at `startIp` via an explicit ip + rstack (never JS
   * recursion — M2's original design note, still why M7/M8's IP-mutating
   * words could all be built as generators with no further rework). */
  private *threadFrom(startIp: number): Generator<StepSignal, void, void> {
    this.rstack.push(TOP_LEVEL_SENTINEL);
    let ip = startIp;

    while (ip !== TOP_LEVEL_SENTINEL) {
      const slotXt = this.arena.readCell(ip);
      ip += CELL;
      const slotCode = this.arena.readCell(slotXt);

      if (slotCode === LIT_TOKEN) {
        this.ctx.stack.push(this.arena.readCell(ip));
        ip += CELL;
        yield 'progress';
      } else if (slotCode === EXIT_TOKEN) {
        ip = this.rstack.pop();
        yield 'progress';
      } else if (slotCode === BRANCH_TOKEN) {
        ip = this.arena.readCell(ip);
        yield 'progress';
      } else if (slotCode === ZBRANCH_TOKEN) {
        const flag = this.ctx.stack.pop();
        ip = flag === FALSE_VALUE ? this.arena.readCell(ip) : ip + CELL;
        yield 'progress';
      } else if (slotCode === SLIT_TOKEN) {
        const len = this.arena.readCell(ip);
        ip += CELL;
        this.ctx.stack.push(ip); // string bytes start right here
        this.ctx.stack.push(len);
        ip = alignCell(ip + len);
        yield 'progress';
      } else if (slotCode === DOES_TOKEN) {
        // Rewrite LATEST's Code Field to DODOES and store the current ip
        // (already past this slot — exactly the code following DOES> in
        // the *defining* word) as its does-pointer, then unwind like EXIT.
        const latestAddr = this.ctx.sysvars.getLatest();
        const flagsByte = this.arena.readByte(latestAddr + 4);
        const nameLen = flagsByte & NAME_LEN_MASK;
        const latestCfa = alignCell(latestAddr + 5 + nameLen);
        this.arena.writeCell(latestCfa, DODOES_TOKEN);
        this.arena.writeCell(latestCfa + CELL, ip);
        ip = this.rstack.pop();
        yield 'progress';
      } else if (slotCode === DOCOL) {
        yield* this.checkBreakpoint(slotXt);
        this.rstack.push(ip);
        ip = slotXt + CELL;
        yield 'progress';
      } else if (slotCode === DODOES_TOKEN) {
        yield* this.checkBreakpoint(slotXt);
        this.ctx.stack.push(slotXt + CELL + CELL);
        this.rstack.push(ip);
        ip = this.arena.readCell(slotXt + CELL);
        yield 'progress';
      } else if (slotCode === DOVAR_TOKEN) {
        this.ctx.stack.push(slotXt + CELL + CELL); // past the reserved does-pointer cell, see executeXT's DOVAR branch
        yield 'progress';
      } else {
        yield* this.dispatch(slotCode);
      }
    }
  }

  /** Dispatches one primitive token. `KEY` is the one token that can
   * suspend (FORTH-ARCHITECTURE.md §7a) — checked against the bound
   * Channel *before* `executePrimitive` ever runs, so the primitive
   * itself (primitives.ts case 30) only ever executes once data is
   * actually available and never needs to know about suspension itself.
   * `ACCEPT` (M7a) suspends potentially many times within one dispatch —
   * handled entirely by its own method rather than `executePrimitive`. */
  private *dispatch(token: number): Generator<StepSignal, void, void> {
    if (token === COLD_TOKEN) {
      // COLD (rebel-opcodes.json 132): a full reset needs a brand new
      // Machine (repl.ts's memory-holding fields are readonly, built
      // once in the constructor) — nothing this dispatcher or
      // executePrimitive could do in place. Yield a signal up through
      // step() instead and let the host (packages/app's tick()) do the
      // actual reconstruction; this token never reaches executePrimitive,
      // same shape as ACCEPT/EXECUTE below.
      yield 'cold';
      return;
    }
    if (token === RESTORE_TOKEN) {
      // M54: RESTORE ( "name" -- ) special-cased for the same structural
      // reason COLD is above — a resize-triggered restart needs a brand
      // new Machine (readonly fields, built once), which nothing this
      // dispatcher or executePrimitive could arrange in place. The
      // project name is consumed here, once, regardless of which branch
      // follows — projectNeedsRestart()/restoreProject() (primitives.ts)
      // never re-consume it themselves.
      const project = this.ctx.nextInputToken().toUpperCase();
      if (projectNeedsRestart(this.ctx, project)) {
        this.restartAtProject = project;
        yield 'restart-project';
        return;
      }
      restoreProject(this.ctx, project);
      yield 'progress';
      return;
    }
    if (token === ACCEPT_TOKEN) {
      yield* this.accept();
      return;
    }
    if (token === EXECUTE_TOKEN) {
      // Recurse into the same top-level entry point a direct call would
      // use — DOCOL/DOVAR/DODOES dispatch, breakpoints, and nested
      // blocking (KEY/ACCEPT) all fall out of this for free, since
      // executeXT's own threadFrom() pushes/pops its own rstack sentinel
      // regardless of whether it was reached via a compiled call or here.
      const xt = this.ctx.stack.pop();
      yield* this.executeXT(xt);
      return;
    }
    if (token === KEY_TOKEN) {
      while (!this.ctx.channel.hasData()) {
        yield 'blocked';
      }
    }
    executePrimitive(this.ctx, token);
    yield 'progress';
  }

  /** Blocking single-character read off the bound Channel — the same
   * suspend/resume shape `dispatch()` uses for `KEY`, factored out so
   * `accept()`'s loop can call it once per character. */
  private *readCharBlocking(): Generator<StepSignal, number, void> {
    while (!this.ctx.channel.hasData()) {
      yield 'blocked';
    }
    const char = this.ctx.channel.readByte();
    yield 'progress';
    return char;
  }

  /** `ACCEPT ( addr len -- len2 )` — classic Forth line input
   * (FORTH-ARCHITECTURE.md §7a / M7a's on-screen REPL). Reads and echoes
   * one character at a time until Enter; Backspace erases the last
   * echoed character (wrapping back across a screen row if the cursor is
   * at column 0 — the same wrap-only convention `Screen.advanceCursor`
   * uses going forward, M3) but never below the start of *this* call's
   * input — it can't reach back into whatever the screen already showed
   * before ACCEPT was invoked (e.g. a prompt), since only characters
   * actually read by this call count against `count`. */
  private *accept(): Generator<StepSignal, void, void> {
    const maxLen = this.ctx.stack.pop();
    const addr = this.ctx.stack.pop();
    const { screen } = this.ctx;
    const { arena } = this;
    let count = 0;

    while (true) {
      const char = yield* this.readCharBlocking();

      if (char === CHAR_ENTER) {
        break;
      }

      if (char === CHAR_BACKSPACE) {
        if (count > 0) {
          count--;
          let col = screen.getCursorCol();
          let row = screen.getCursorRow();
          if (col === 0) {
            col = screen.cols - 1;
            row = row === 0 ? screen.rows - 1 : row - 1;
          } else {
            col--;
          }
          screen.writeChar(col, row, CHAR_SPACE);
          screen.setCursor(col, row);
        }
        continue;
      }

      if (count < maxLen) {
        arena.writeByte(addr + count, char);
        count++;
        screen.emit(char);
      }
    }

    this.ctx.stack.push(count);
  }
}
