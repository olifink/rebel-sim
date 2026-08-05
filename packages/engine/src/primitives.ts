/**
 * The inner interpreter: token-threaded switch dispatch
 * (FORTH-ARCHITECTURE.md §5). Token IDs 0..N-1 are native primitives
 * dispatched directly here. M1 has no compiler/colon-definitions yet, so
 * DOCOL (token 0) is not handled by this dispatcher — every token M1
 * ever sees is a primitive.
 *
 * Boolean convention (§7): TRUE = -1 (all bits set), FALSE = 0.
 *
 * M8 (CORE-VOCABULARY.md): `PrimitiveContext` now extends
 * `DictionaryContext` and adds `rstack`/`nextInputToken()` — the control-
 * flow (`IF`/`BEGIN`/...) and defining (`VARIABLE`/`CREATE`/...) words
 * need direct compiler access (`HERE`, `compileCell`, `findWord`) that a
 * plain stack-effect primitive never needed before. `Machine` already
 * satisfies this shape (it always implemented `DictionaryContext` too,
 * for `:`/`;`) — this is a type-level widening, not a new field on it.
 */

import { DataStack } from './stack.js';
import { Screen } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Channel } from './channel.js';
import { BankTable, BankFlagResident, BankFlagActive } from './banks.js';
import { alignCell, CELL_SIZE } from './arena.js';
import {
  compileCell,
  DictionaryContext,
  findWord,
  NAME_LEN_MASK,
  writeHeader,
} from './dictionary.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

export const TRUE = -1;
export const FALSE = 0;

const DOVAR_TOKEN = opcodes.dovarTokenId;
const DOCON_TOKEN = opcodes.doconTokenId;

export interface PrimitiveContext extends DictionaryContext {
  readonly stack: DataStack;
  readonly rstack: DataStack;
  readonly screen: Screen;
  readonly keyboard: Keyboard;
  readonly channel: Channel;
  /** DEVELOPING.md §7, M16: the PAD bank — fixed scratch text S" copies
   * into while interpreting (compiling mode doesn't use it, see the
   * case 68/70 note below). */
  readonly padBase: number;
  readonly padSize: number;
  /** DEVELOPING.md §10, M18: the bank table BANK@ looks up tags in —
   * mirrors the padBase/padSize precedent (M16), exposing something the
   * host already tracks rather than duplicating it as arena bytes. */
  readonly banks: BankTable;
  getBase(): number;
  /** Consumes the next word directly from whatever line the outer
   * interpreter is currently walking — see repl.ts's header comment on
   * why this needs to be a shared cursor, not a local variable. */
  nextInputToken(): string;
}

/** Truncate a JS number to a signed 32-bit Forth cell. */
function toCell(n: number): number {
  return n | 0;
}

/** Shared by IF/WHILE/UNTIL (§6): compiles a call to `name` (BRANCH or
 * 0BRANCH) followed by a placeholder cell, returning the placeholder's
 * own address for the caller to push onto the data stack (patched later
 * by ELSE/THEN/REPEAT) or use immediately (UNTIL, a known backward
 * target needs no patching). */
function compileBranch(ctx: PrimitiveContext, name: string): number {
  compileCell(ctx, findWord(ctx, name)!.cfa);
  const placeholderAddr = ctx.sysvars.getHere();
  compileCell(ctx, 0);
  return placeholderAddr;
}

/** Shared by S"/./( (§8, DEVELOPING.md §2.4): consumes input tokens via
 * `nextInputToken()` until one ends with `closingChar`, rejoining with
 * single spaces — a real multi-word string/comment, not just the
 * single no-embedded-spaces token this used to be limited to. Doesn't
 * preserve the original line's exact whitespace (tabs, doubled spaces)
 * since tokenization already collapsed it before this ever runs —
 * documented, not hidden (DEVELOPING.md §2.2). */
function consumeQuotedText(ctx: PrimitiveContext, closingChar: string): string {
  let text = '';
  while (true) {
    const rawToken = ctx.nextInputToken();
    if (rawToken.endsWith(closingChar)) {
      const last = rawToken.slice(0, -1);
      // A standalone closing token (whitespace before it, e.g. Forth's
      // conventional "( comment )" spacing) leaves `last` empty — don't
      // add a spurious trailing separator space for it.
      return text + (text && last ? ' ' : '') + last;
    }
    text += (text ? ' ' : '') + rawToken;
  }
}

/** Compiles (SLIT) + `text`'s byte length + its raw bytes inline,
 * padded to the next cell boundary — the same "LIT followed by inline
 * data" convention LIT itself uses, generalized from one cell to a
 * byte run. Shared by S"/./( (consumeQuotedText builds the text each
 * one hands this). */
function compileSlit(ctx: PrimitiveContext, text: string): void {
  compileCell(ctx, findWord(ctx, '(SLIT)')!.cfa);
  compileCell(ctx, text.length);
  const start = ctx.sysvars.getHere();
  for (let i = 0; i < text.length; i++) {
    ctx.arena.writeByte(start + i, text.charCodeAt(i));
  }
  ctx.sysvars.setHere(alignCell(start + text.length));
}

/** Shared by S"/." while compiling (§8): both compile the same
 * (SLIT)-based inline-store, the difference between them being only
 * what gets compiled *after* it (case 68 vs. 70 below). */
function compileInlineString(ctx: PrimitiveContext): void {
  compileSlit(ctx, consumeQuotedText(ctx, '"'));
}

/** S"'s interpreted-mode body (DEVELOPING.md §7, M16): copies text into
 * the fixed PAD bank (overwritten on every call, same footgun as real
 * Forth's PAD — no reentrancy/nesting support) and pushes its addr/len,
 * so `S" hello" TYPE` works loose at the prompt, not just compiled. */
function interpretStringLiteral(ctx: PrimitiveContext): void {
  const text = consumeQuotedText(ctx, '"');
  if (text.length > ctx.padSize) {
    throw new Error(`S" text too long for PAD (${text.length} > ${ctx.padSize} bytes)`);
  }
  for (let i = 0; i < text.length; i++) {
    ctx.arena.writeByte(ctx.padBase + i, text.charCodeAt(i));
  }
  ctx.stack.push(ctx.padBase);
  ctx.stack.push(text.length);
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
    case 29: // KEY? ( -- flag )
      s.push(ctx.keyboard.hasEvent() ? TRUE : FALSE);
      break;
    case 30: { // KEY ( -- char ) — M7: blocks (FORTH-ARCHITECTURE.md §7a).
      // Reads through the bound Channel, not ctx.keyboard directly, so a
      // future RemoteChannel (M8) needs no change here. inner.ts's step
      // loop guards this dispatch on ctx.channel.hasData() first, so
      // readByte() always has something by the time this case runs; the
      // -1 check is a defensive internal-invariant guard, not a normal
      // Forth-level failure mode.
      const char = ctx.channel.readByte();
      if (char < 0) {
        throw new Error('KEY: internal error — dispatched with no channel data available');
      }
      s.push(char);
      break;
    }

    // --- M8, CORE-VOCABULARY.md §4: memory access ---
    case 32: // @ ( addr -- x )
      s.push(ctx.arena.readCell(s.pop()));
      break;
    case 33: { // ! ( x addr -- )
      const addr = s.pop();
      const x = s.pop();
      ctx.arena.writeCell(addr, x);
      break;
    }
    case 34: // C@ ( addr -- x )
      s.push(ctx.arena.readByte(s.pop()));
      break;
    case 35: { // C! ( x addr -- )
      const addr = s.pop();
      const x = s.pop();
      ctx.arena.writeByte(addr, x & 0xff);
      break;
    }
    case 36: { // +! ( n addr -- )
      const addr = s.pop();
      const n = s.pop();
      ctx.arena.writeCell(addr, toCell(ctx.arena.readCell(addr) + n));
      break;
    }

    // --- §5: return stack ---
    case 37: // >R ( x -- ) ( R: -- x )
      ctx.rstack.push(s.pop());
      break;
    case 38: // R> ( -- x ) ( R: x -- )
      s.push(ctx.rstack.pop());
      break;
    case 39: // R@ ( -- x ) ( R: x -- x )
      s.push(ctx.rstack.peek(0));
      break;

    // --- §6: control flow. BRANCH/0BRANCH are NOT handled here — they're
    // ip-mutating and special-cased in inner.ts, same as LIT/EXIT. IF
    // through RECURSE below are the IMMEDIATE compile-time words that
    // emit calls to them. ---
    case 42: // IF ( -- ) IMMEDIATE: pushes a backpatch address for ELSE/THEN
      s.push(compileBranch(ctx, '0BRANCH'));
      break;
    case 43: { // ELSE ( -- ) IMMEDIATE
      const elsePlaceholder = compileBranch(ctx, 'BRANCH');
      const ifPlaceholder = s.pop();
      ctx.arena.writeCell(ifPlaceholder, ctx.sysvars.getHere());
      s.push(elsePlaceholder);
      break;
    }
    case 44: { // THEN ( -- ) IMMEDIATE
      const placeholder = s.pop();
      ctx.arena.writeCell(placeholder, ctx.sysvars.getHere());
      break;
    }
    case 45: // BEGIN ( -- ) IMMEDIATE: pushes a backward-branch target
      s.push(ctx.sysvars.getHere());
      break;
    case 46: { // UNTIL ( -- ) IMMEDIATE
      const beginAddr = s.pop();
      compileCell(ctx, findWord(ctx, '0BRANCH')!.cfa);
      compileCell(ctx, beginAddr);
      break;
    }
    case 47: { // WHILE ( -- ) IMMEDIATE: BEGIN's addr stays underneath for REPEAT
      const beginAddr = s.pop();
      const whilePlaceholder = compileBranch(ctx, '0BRANCH');
      s.push(beginAddr);
      s.push(whilePlaceholder);
      break;
    }
    case 48: { // REPEAT ( -- ) IMMEDIATE
      const whilePlaceholder = s.pop();
      const beginAddr = s.pop();
      compileCell(ctx, findWord(ctx, 'BRANCH')!.cfa);
      compileCell(ctx, beginAddr);
      ctx.arena.writeCell(whilePlaceholder, ctx.sysvars.getHere());
      break;
    }
    case 49: { // RECURSE ( -- ) IMMEDIATE: calls LATEST directly, bypassing the HIDDEN skip
      const latest = ctx.sysvars.getLatest();
      const flagsByte = ctx.arena.readByte(latest + 4);
      const nameLen = flagsByte & NAME_LEN_MASK;
      compileCell(ctx, alignCell(latest + 5 + nameLen));
      break;
    }

    // --- §6: DO/LOOP/+LOOP (compile-time words + their runtime helpers) ---
    case 50: // DO ( -- ) IMMEDIATE
      compileCell(ctx, findWord(ctx, '(DO)')!.cfa);
      s.push(ctx.sysvars.getHere());
      break;
    case 51: { // LOOP ( -- ) IMMEDIATE
      compileCell(ctx, findWord(ctx, '(LOOP)')!.cfa);
      const doTarget = s.pop();
      compileCell(ctx, findWord(ctx, '0BRANCH')!.cfa);
      compileCell(ctx, doTarget);
      break;
    }
    case 52: { // +LOOP ( -- ) IMMEDIATE
      compileCell(ctx, findWord(ctx, '(+LOOP)')!.cfa);
      const doTarget = s.pop();
      compileCell(ctx, findWord(ctx, '0BRANCH')!.cfa);
      compileCell(ctx, doTarget);
      break;
    }
    case 53: { // (DO) ( limit index -- ) ( R: -- index limit )
      const index = s.pop();
      const limit = s.pop();
      ctx.rstack.push(limit);
      ctx.rstack.push(index);
      break;
    }
    case 54: { // (LOOP) ( -- flag ) ( R: index limit -- index' limit | -- )
      const index = ctx.rstack.pop();
      const limit = ctx.rstack.pop();
      const next = toCell(index + 1);
      if (next < limit) {
        ctx.rstack.push(limit);
        ctx.rstack.push(next);
        s.push(FALSE); // continue — LOOP's compiled 0BRANCH jumps back
      } else {
        s.push(TRUE); // done — loop-control cells already dropped
      }
      break;
    }
    case 55: { // (+LOOP) ( n -- flag ) ( R: index limit -- index' limit | -- )
      const increment = s.pop();
      const index = ctx.rstack.pop();
      const limit = ctx.rstack.pop();
      const next = toCell(index + increment);
      // Simplified boundary check vs. full ANS "unsigned crossing"
      // semantics: continue while still short of the limit, on whichever
      // side `increment`'s sign is heading. Correct for the common
      // counting-up/counting-down cases; genuinely adversarial
      // increments (e.g. one that jumps clean over the limit) aren't
      // specified any more precisely than this by CORE-VOCABULARY.md §6.
      const done = increment >= 0 ? next >= limit : next <= limit;
      if (!done) {
        ctx.rstack.push(limit);
        ctx.rstack.push(next);
        s.push(FALSE);
      } else {
        s.push(TRUE);
      }
      break;
    }
    case 56: // I ( -- n ) innermost loop index
      s.push(ctx.rstack.peek(0));
      break;
    case 57: // J ( -- n ) next-innermost loop index
      s.push(ctx.rstack.peek(2));
      break;

    // --- §7: defining words. DOVAR/DOCON/DODOES dispatch (what runs when
    // a *created* word is later executed) lives in inner.ts, not here —
    // these cases are what runs when the defining words themselves fire. ---
    case 59: // HERE ( -- addr )
      s.push(ctx.sysvars.getHere());
      break;
    case 60: // LATEST ( -- addr )
      s.push(ctx.sysvars.getLatest());
      break;
    case 61: // , ( x -- )
      compileCell(ctx, s.pop());
      break;
    case 62: { // ALLOT ( n -- )
      const n = s.pop();
      ctx.sysvars.setHere(ctx.sysvars.getHere() + n);
      break;
    }
    case 63: { // VARIABLE ( "name" -- )
      // Every DOVAR-coded word reserves a leading does-pointer cell —
      // see CREATE's case below for why — so VARIABLE's *actual* storage
      // is the cell after that, not the first one. Same layout CREATE
      // gets; VARIABLE is just CREATE plus an initialized data cell,
      // matching how real Forth systems typically define it.
      const name = ctx.nextInputToken();
      writeHeader(ctx, name, 0, DOVAR_TOKEN);
      compileCell(ctx, 0); // does-pointer slot: inert until/unless DOES> is ever applied
      compileCell(ctx, 0); // the variable's actual value
      break;
    }
    case 64: { // CONSTANT ( x "name" -- )
      const value = s.pop();
      const name = ctx.nextInputToken();
      writeHeader(ctx, name, 0, DOCON_TOKEN);
      compileCell(ctx, value);
      break;
    }
    case 65: { // CREATE ( "name" -- )
      // Reserves one leading cell unconditionally, *before* the
      // parameter field a following `,`/ALLOT will fill — not visible
      // through the word's own pushed address (DOVAR's dispatch skips
      // past it), it only becomes meaningful as the does-pointer slot
      // DODOES reads if DOES> is later applied to this same word. A
      // plain CREATE that's never DOES>'d just carries one permanently
      // unused cell — the price of not knowing in advance whether DOES>
      // is coming, paid by every CREATE'd word uniformly rather than
      // needing two different runtime representations.
      const name = ctx.nextInputToken();
      writeHeader(ctx, name, 0, DOVAR_TOKEN);
      compileCell(ctx, 0);
      break;
    }
    case 66: // DOES> ( -- ) IMMEDIATE: (DOES>)'s ip-mutating runtime lives in inner.ts
      compileCell(ctx, findWord(ctx, '(DOES>)')!.cfa);
      break;

    // --- §8: strings. (SLIT)'s runtime (pushing addr/len) lives in
    // inner.ts for the compiled path; the interpreted path (DEVELOPING.md
    // §7, M16) uses PAD instead and needs no (SLIT) involvement at all. ---
    case 68: // S" ( -- addr len ) IMMEDIATE, dual-mode: compile inline vs. PAD at interpret time
      if (ctx.sysvars.getState() === -1) {
        compileInlineString(ctx);
      } else {
        interpretStringLiteral(ctx);
      }
      break;
    case 69: { // TYPE ( addr len -- )
      const len = s.pop();
      const addr = s.pop();
      for (let i = 0; i < len; i++) {
        ctx.screen.emit(ctx.arena.readByte(addr + i));
      }
      break;
    }
    case 70: // ." ( -- ) IMMEDIATE, dual-mode: S" ... TYPE sugar vs. direct emit at interpret time
      if (ctx.sysvars.getState() === -1) {
        compileInlineString(ctx);
        compileCell(ctx, findWord(ctx, 'TYPE')!.cfa);
      } else {
        const text = consumeQuotedText(ctx, '"');
        for (const ch of text) {
          ctx.screen.emit(ch.charCodeAt(0));
        }
      }
      break;

    // --- §9: stack/arithmetic rounding out ---
    case 71: { // 2DUP ( a b -- a b a b )
      const b = s.peek(0);
      const a = s.peek(1);
      s.push(a);
      s.push(b);
      break;
    }
    case 72: // 2DROP ( a b -- )
      s.pop();
      s.pop();
      break;
    case 73: { // -ROT ( a b c -- c a b )
      const c = s.pop();
      const b = s.pop();
      const a = s.pop();
      s.push(c);
      s.push(a);
      s.push(b);
      break;
    }
    case 74: { // TUCK ( a b -- b a b )
      const b = s.pop();
      const a = s.pop();
      s.push(b);
      s.push(a);
      s.push(b);
      break;
    }
    case 75: { // NIP ( a b -- b )
      const b = s.pop();
      s.pop();
      s.push(b);
      break;
    }
    case 76: // ?DUP ( x -- x x | x )
      if (s.peek(0) !== 0) {
        s.push(s.peek(0));
      }
      break;
    case 77: // DEPTH ( -- n )
      s.push(s.depth);
      break;
    case 78: { // /MOD ( a b -- rem quot )
      const b = s.pop();
      const a = s.pop();
      if (b === 0) throw new Error('division by zero');
      s.push(toCell(a % b));
      s.push(toCell(Math.trunc(a / b)));
      break;
    }
    case 79: // NEGATE ( n -- -n )
      s.push(toCell(-s.pop()));
      break;
    case 80: // ABS ( n -- |n| )
      s.push(toCell(Math.abs(s.pop())));
      break;
    case 81: { // MIN ( a b -- min )
      const b = s.pop();
      const a = s.pop();
      s.push(a < b ? a : b);
      break;
    }
    case 82: { // MAX ( a b -- max )
      const b = s.pop();
      const a = s.pop();
      s.push(a > b ? a : b);
      break;
    }
    case 83: // 1+ ( n -- n+1 )
      s.push(toCell(s.pop() + 1));
      break;
    case 84: // 1- ( n -- n-1 )
      s.push(toCell(s.pop() - 1));
      break;
    case 85: // 2+ ( n -- n+2 )
      s.push(toCell(s.pop() + 2));
      break;
    case 86: // 2- ( n -- n-2 )
      s.push(toCell(s.pop() - 2));
      break;
    case 87: // 2* ( n -- n*2 )
      s.push(toCell(s.pop() * 2));
      break;
    case 88: // 2/ ( n -- n/2 ) arithmetic shift right
      s.push(toCell(s.pop() >> 1));
      break;
    case 89: { // <> ( a b -- flag )
      const b = s.pop();
      const a = s.pop();
      s.push(a !== b ? TRUE : FALSE);
      break;
    }
    case 90: // 0< ( n -- flag )
      s.push(s.pop() < 0 ? TRUE : FALSE);
      break;
    case 91: // 0> ( n -- flag )
      s.push(s.pop() > 0 ? TRUE : FALSE);
      break;
    case 92: { // U< ( a b -- flag ) unsigned comparison
      const b = s.pop() >>> 0;
      const a = s.pop() >>> 0;
      s.push(a < b ? TRUE : FALSE);
      break;
    }

    // --- DEVELOPING.md §2.4: comments, retained rather than discarded ---
    case 93: { // ( ( -- ) IMMEDIATE
      const text = consumeQuotedText(ctx, ')');
      if (ctx.sysvars.getState() === -1) {
        // Compiling: retain as compiled (SLIT)+2DROP inline data — a
        // genuine runtime no-op (push, then immediately drop).
        compileSlit(ctx, text);
        compileCell(ctx, findWord(ctx, '2DROP')!.cfa);
      }
      // Interpreting at the top level: consumed and discarded above —
      // there's no HERE to compile into, matches classic Forth here.
      break;
    }

    case 94: { // ' ( -- xt ) — DEVELOPING.md §6, see rebel-opcodes.json's note
      const name = ctx.nextInputToken();
      const found = findWord(ctx, name);
      if (!found) {
        throw new Error(`? unrecognized word: ${name}`);
      }
      s.push(found.cfa);
      break;
    }

    case 95: // LATEST-ADDR ( -- addr ) — DEVELOPING.md §8, see rebel-opcodes.json's note
      s.push(ctx.sysvars.fieldOffset('FORTH', 'LATEST'));
      break;

    case 97: // PAD ( -- addr ) — DEVELOPING.md §7, M16
      s.push(ctx.padBase);
      break;

    case 98: // ABORT ( -- ) — DEVELOPING.md §9, M17
      s.clear();
      throw new Error('ABORT');

    case 99: { // BANK@ ( "tag" -- addr ) — DEVELOPING.md §10/§12, M18/M20
      const tag = ctx.nextInputToken().toUpperCase();
      const addr = ctx.banks.mmap.findBankAddr(tag);
      if (addr === undefined) {
        throw new Error(`? unknown bank: ${tag}`);
      }
      s.push(addr);
      break;
    }

    case 100: { // CREATE-BANK ( size "tag" -- addr ) — DEVELOPING.md §13/§14, M21/M22
      const size = s.pop();
      const tag = ctx.nextInputToken().toUpperCase();
      const slot = ctx.banks.mmap.allocate(tag, tag, size, BankFlagResident | BankFlagActive);
      s.push(slot.base);
      break;
    }

    // --- DEVELOPING.md §15, M23: a batch of low-level primitives ---
    case 101: { // XOR ( a b -- a^b )
      const b = s.pop();
      const a = s.pop();
      s.push(toCell(a ^ b));
      break;
    }
    case 102: { // .S ( -- ) non-destructive stack print, bottom-to-top,
      // current BASE — same digit formatting as `.` (case 18), applied
      // to every cell instead of one popped value.
      const base = ctx.getBase();
      const items = [...s.toArray()].reverse();
      for (const v of items) {
        const digits = v.toString(base) + ' ';
        for (const ch of digits) {
          ctx.screen.emit(ch.charCodeAt(0));
        }
      }
      break;
    }
    case 103: { // 2SWAP ( a b c d -- c d a b )
      const d = s.pop();
      const c = s.pop();
      const b = s.pop();
      const a = s.pop();
      s.push(c);
      s.push(d);
      s.push(a);
      s.push(b);
      break;
    }
    case 104: { // 2OVER ( a b c d -- a b c d a b )
      const a = s.peek(3);
      const b = s.peek(2);
      s.push(a);
      s.push(b);
      break;
    }
    case 105: // CELLS ( n -- n*4 )
      s.push(toCell(s.pop() * CELL_SIZE));
      break;
    case 106: // CELL+ ( addr -- addr+4 )
      s.push(toCell(s.pop() + CELL_SIZE));
      break;
    case 107: { // FILL ( addr len char -- )
      const char = s.pop();
      const len = s.pop();
      const addr = s.pop();
      for (let i = 0; i < len; i++) {
        ctx.arena.writeByte(addr + i, char & 0xff);
      }
      break;
    }
    case 108: { // CMOVE ( addr1 addr2 len -- ) low-to-high; overlapping
      // ranges where addr2 falls inside [addr1, addr1+len) corrupt data
      // — documented footgun, not a bug (DEVELOPING.md §15).
      const len = s.pop();
      const addr2 = s.pop();
      const addr1 = s.pop();
      for (let i = 0; i < len; i++) {
        ctx.arena.writeByte(addr2 + i, ctx.arena.readByte(addr1 + i));
      }
      break;
    }
    case 109: // BL ( -- 32 )
      s.push(32);
      break;
    case 110: // SPACE ( -- )
      ctx.screen.emit(32);
      break;
    case 111: { // WITHIN ( n lo hi -- flag ) plain signed, non-wraparound
      // — deliberately not full ANS WITHIN (DEVELOPING.md §15).
      const hi = s.pop();
      const lo = s.pop();
      const n = s.pop();
      s.push(n >= lo && n < hi ? TRUE : FALSE);
      break;
    }
    case 112: { // PICK ( xu ... x1 x0 u -- xu ... x1 x0 xu )
      const n = s.pop();
      s.push(s.peek(n));
      break;
    }
    case 113: { // ROLL ( xu ... x1 x0 u -- xu-1 ... x1 x0 xu )
      const n = s.pop();
      if (n < 0) throw new Error('ROLL: negative index');
      const items: number[] = [];
      for (let i = 0; i <= n; i++) items.push(s.pop());
      for (let i = n - 1; i >= 0; i--) s.push(items[i]);
      s.push(items[n]);
      break;
    }

    // --- DEVELOPING.md §16, M24: radix control from Forth source ---
    case 114: // BASE ( -- addr ) — a real variable, same fieldOffset
      // pattern as LATEST-ADDR (case 95).
      s.push(ctx.sysvars.fieldOffset('FORTH', 'BASE'));
      break;
    case 115: // HEX ( -- )
      ctx.sysvars.setBase(16);
      break;
    case 116: // DECIMAL ( -- )
      ctx.sysvars.setBase(10);
      break;

    // --- DEVELOPING.md §17, M25: a visible, inverse-video text cursor ---
    case 117: // CURSEN ( -- )
      ctx.screen.showCursor();
      break;
    case 118: // CURSDIS ( -- )
      ctx.screen.hideCursor();
      break;

    default:
      throw new Error(`unknown primitive token ${tokenId}`);
  }
}
