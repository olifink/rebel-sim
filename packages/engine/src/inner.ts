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
 */

import { Arena, CELL_SIZE as CELL } from './arena.js';
import { DataStack } from './stack.js';
import { executePrimitive, PrimitiveContext } from './primitives.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const DOCOL = opcodes.docolTokenId;
const EXIT_TOKEN = opcodes.primitives.find((p) => p.name === 'EXIT')!.id;
const LIT_TOKEN = opcodes.primitives.find((p) => p.name === 'LIT')!.id;
const KEY_TOKEN = opcodes.primitives.find((p) => p.name === 'KEY')!.id;
const ACCEPT_TOKEN = opcodes.primitives.find((p) => p.name === 'ACCEPT')!.id;

/** Not a valid arena offset (offsets are unsigned), so it's safe as the
 * return-stack sentinel meaning "top-level call, stop when popped." */
const TOP_LEVEL_SENTINEL = -1;

const CHAR_BACKSPACE = 8;
const CHAR_ENTER = 10;
const CHAR_SPACE = 32;

export type StepSignal = 'progress' | 'blocked';

export class Inner {
  constructor(
    private readonly arena: Arena,
    private readonly rstack: DataStack,
    private readonly ctx: PrimitiveContext,
  ) {}

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
    if (codeField !== DOCOL) {
      yield* this.dispatch(codeField);
      return;
    }

    this.rstack.push(TOP_LEVEL_SENTINEL);
    let ip = xt + CELL;

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
      } else if (slotCode === DOCOL) {
        this.rstack.push(ip);
        ip = slotXt + CELL;
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
    if (token === ACCEPT_TOKEN) {
      yield* this.accept();
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
