/**
 * The inner interpreter: token-threaded switch dispatch
 * (FORTH-ARCHITECTURE.md §5). Token IDs 0..N-1 are native primitives
 * dispatched directly here. M1 has no compiler/colon-definitions yet, so
 * DOCOL (token 0) is not handled by this dispatcher — every token M1
 * ever sees is a primitive.
 *
 * Boolean convention (§7): TRUE = -1 (all bits set), FALSE = 0.
 */

import { DataStack } from './stack.js';
import { Screen } from './screen.js';

export const TRUE = -1;
export const FALSE = 0;

export interface PrimitiveContext {
  readonly stack: DataStack;
  readonly screen: Screen;
  getBase(): number;
}

/** Truncate a JS number to a signed 32-bit Forth cell. */
function toCell(n: number): number {
  return n | 0;
}

export function executePrimitive(ctx: PrimitiveContext, tokenId: number): void {
  const s = ctx.stack;
  switch (tokenId) {
    case 1: // DUP
      s.push(s.peek(0));
      break;
    case 2: // DROP
      s.pop();
      break;
    case 3: { // SWAP
      const b = s.pop();
      const a = s.pop();
      s.push(b);
      s.push(a);
      break;
    }
    case 4: // OVER
      s.push(s.peek(1));
      break;
    case 5: { // ROT
      const c = s.pop();
      const b = s.pop();
      const a = s.pop();
      s.push(b);
      s.push(c);
      s.push(a);
      break;
    }
    case 6: { // +
      const b = s.pop();
      const a = s.pop();
      s.push(toCell(a + b));
      break;
    }
    case 7: { // -
      const b = s.pop();
      const a = s.pop();
      s.push(toCell(a - b));
      break;
    }
    case 8: { // *
      const b = s.pop();
      const a = s.pop();
      s.push(toCell(a * b));
      break;
    }
    case 9: { // /
      const b = s.pop();
      const a = s.pop();
      if (b === 0) throw new Error('division by zero');
      s.push(toCell(Math.trunc(a / b)));
      break;
    }
    case 10: { // MOD
      const b = s.pop();
      const a = s.pop();
      if (b === 0) throw new Error('division by zero');
      s.push(toCell(a % b));
      break;
    }
    case 11: { // =
      const b = s.pop();
      const a = s.pop();
      s.push(a === b ? TRUE : FALSE);
      break;
    }
    case 12: { // <
      const b = s.pop();
      const a = s.pop();
      s.push(a < b ? TRUE : FALSE);
      break;
    }
    case 13: { // >
      const b = s.pop();
      const a = s.pop();
      s.push(a > b ? TRUE : FALSE);
      break;
    }
    case 14: // 0=
      s.push(s.pop() === 0 ? TRUE : FALSE);
      break;
    case 15: { // AND
      const b = s.pop();
      const a = s.pop();
      s.push(toCell(a & b));
      break;
    }
    case 16: { // OR
      const b = s.pop();
      const a = s.pop();
      s.push(toCell(a | b));
      break;
    }
    case 17: // INVERT
      s.push(toCell(~s.pop()));
      break;
    case 18: { // . ( n -- )
      const v = s.pop();
      const digits = v.toString(ctx.getBase()) + ' ';
      for (const ch of digits) {
        ctx.screen.emit(ch.charCodeAt(0));
      }
      break;
    }
    case 19: // EMIT ( char -- )
      ctx.screen.emit(s.pop());
      break;
    case 20: // CR ( -- )
      ctx.screen.emit(10); // '\n' — Screen.emit special-cases it as cursor control
      break;
    case 23: { // CHAR! ( col row code -- )
      const code = s.pop();
      const row = s.pop();
      const col = s.pop();
      ctx.screen.writeChar(col, row, code);
      break;
    }
    case 24: { // CHAR@ ( col row -- code )
      const row = s.pop();
      const col = s.pop();
      s.push(ctx.screen.readChar(col, row));
      break;
    }
    case 25: // CLS ( -- )
      ctx.screen.cls();
      break;
    case 26: { // AT-XY ( col row -- )
      const row = s.pop();
      const col = s.pop();
      ctx.screen.setCursor(col, row);
      break;
    }
    case 27: // INK ( color -- )
      ctx.screen.setInk(s.pop());
      break;
    case 28: // PAPER ( color -- )
      ctx.screen.setPaper(s.pop());
      break;
    default:
      throw new Error(`unknown primitive token ${tokenId}`);
  }
}
