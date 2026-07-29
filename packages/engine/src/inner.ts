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
 * (PrimitiveContext) has no access to.
 */

import { Arena, CELL_SIZE as CELL } from './arena.js';
import { DataStack } from './stack.js';
import { executePrimitive, PrimitiveContext } from './primitives.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const DOCOL = opcodes.docolTokenId;
const EXIT_TOKEN = opcodes.primitives.find((p) => p.name === 'EXIT')!.id;
const LIT_TOKEN = opcodes.primitives.find((p) => p.name === 'LIT')!.id;

/** Not a valid arena offset (offsets are unsigned), so it's safe as the
 * return-stack sentinel meaning "top-level call, stop when popped." */
const TOP_LEVEL_SENTINEL = -1;

export class Inner {
  constructor(
    private readonly arena: Arena,
    private readonly rstack: DataStack,
    private readonly ctx: PrimitiveContext,
  ) {}

  /** Executes the word whose Code Field lives at `xt`. */
  executeXT(xt: number): void {
    const codeField = this.arena.readCell(xt);

    if (codeField === LIT_TOKEN) {
      throw new Error('LIT used outside a compiled word body');
    }
    if (codeField === EXIT_TOKEN) {
      throw new Error('EXIT used outside a compiled word body');
    }
    if (codeField !== DOCOL) {
      executePrimitive(this.ctx, codeField);
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
      } else if (slotCode === EXIT_TOKEN) {
        ip = this.rstack.pop();
      } else if (slotCode === DOCOL) {
        this.rstack.push(ip);
        ip = slotXt + CELL;
      } else {
        executePrimitive(this.ctx, slotCode);
      }
    }
  }
}
