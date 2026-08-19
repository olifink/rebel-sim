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
import { BankTable, BLOCK_SIZE } from './banks.js';
import { Storage } from './storage.js';
import { alignCell, CELL_SIZE } from './arena.js';
import {
  beginDefinition,
  compileCell,
  DictionaryContext,
  endDefinition,
  findWord,
  markLatestCompileOnly,
  markLatestImmediate,
  writeHeader,
} from './dictionary.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

export const TRUE = -1;
export const FALSE = 0;

const DOVAR_TOKEN = opcodes.dovarTokenId;
const DOCOL = opcodes.docolTokenId;

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
  /** DEVELOPING.md's storage section, M33: `PROJECT`/`SAVE`/`RESTORE`/
   * `BSAVE`/`BLOAD` call straight into this, the same way `BANK@`/
   * `CREATE-BANK` already call into `banks` above — storage is
   * synchronous now (localStorage, not OPFS), so there's no suspension
   * mechanism left for these to need; they're ordinary primitives. */
  readonly storage: Storage;
  getBase(): number;
  /** Consumes the next word directly from whatever line the outer
   * interpreter is currently walking — see repl.ts's header comment on
   * why this needs to be a shared cursor, not a local variable. */
  nextInputToken(): string;
  /** spec/04-FORTH-CORE.md §6.13: the raw mechanism `WORD` exposes to
   * Forth source directly — skip leading `delimiterCode` bytes from the
   * shared cursor, read up to the next `delimiterCode` or end of line,
   * consume a trailing delimiter if one was actually hit, return a view
   * into the TIB (`len === 0` means the line is exhausted; never
   * throws). The same method `nextInputToken()` is itself built on. */
  wordScan(delimiterCode: number): { addr: number; len: number };
  /** FORTH-ARCHITECTURE.md §7: repoints the shared input cursor at an
   * arbitrary `(addr, len)` region rather than the TIB — what `LOAD`
   * (`system.fth`) needs to feed a `BLOCK`-resident line through the same
   * `WORD`/`FIND`/`NUMBER`/`INTERPRET` machinery an ordinary typed line
   * uses. */
  setInput(addr: number, len: number): void;
}

/** Truncate a JS number to a signed 32-bit Forth cell. */
function toCell(n: number): number {
  return n | 0;
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

    // --- §6.5: control flow. BRANCH/0BRANCH are NOT handled here — they're
    // ip-mutating and special-cased in inner.ts, same as LIT/EXIT. IF
    // through +LOOP, RECURSE, I, J (the entire compile-time control-flow
    // layer spec/04-FORTH-CORE.md §6.5 calls its "flagship reduction") no
    // longer have cases here at all as of M42 — system.fth now defines
    // them in Forth source, built from BRANCH/0BRANCH/(DO)/(LOOP)/(+LOOP)
    // below, the five primitives that stay genuinely native. ---

    // --- §6.5: DO/LOOP/+LOOP's native runtime helpers — the compile-time
    // words that emit calls to them moved to system.fth (M42); these three
    // stay native (§6.5: "the only genuinely native control-flow
    // primitives this specification requires"). ---
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

    // --- §7: defining words. DOVAR/DODOES dispatch (what runs when
    // a *created* word is later executed) lives in inner.ts, not here —
    // these cases are what runs when the defining words themselves fire.
    // CONSTANT no longer has a case here at all (spec/04-FORTH-CORE.md
    // §4.1/§6.6: `: CONSTANT CREATE , DOES> @ ;`, system.fth) — its
    // former case 64 and the doconTokenId sentinel it used are gone. ---
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

    case 93: // ( ( -- ) IMMEDIATE
      // Classic Forth behavior: consumed and discarded, compiling or not.
      // M11 originally compiled this as (SLIT)+2DROP inline data so SEE
      // could echo a comment back — reverted (M44) once that turned out
      // not to earn its keep: SEE printed it indistinguishably from a
      // genuine discarded string ("comment text" 2DROP, never ( ... )),
      // exactly the ambiguity FORTH-ARCHITECTURE.md §9 item 13 flagged as
      // a risk when this encoding was chosen, and it never got resolved.
      consumeQuotedText(ctx, ')');
      break;

    case 94: { // ' ( -- xt ) — DEVELOPING.md §6, see rebel-opcodes.json's note
      const name = ctx.nextInputToken();
      const found = findWord(ctx, name);
      if (!found) {
        throw new Error(`unrecognized word: ${name}`);
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
        throw new Error(`unknown bank: ${tag}`);
      }
      s.push(addr);
      break;
    }

    case 100: { // CREATE-BANK ( size "tag" -- addr ) — DEVELOPING.md §13/§14/§20, M21/M22/M27, M30
      const size = s.pop();
      const tag = ctx.nextInputToken().toUpperCase();
      // M30 (spec/02-MEMORY-MODEL.md §4.3): routes through BankTable's
      // own createBank() now, not a direct mmap.allocate() bypass — the
      // spec names this call out explicitly as a source of bank-size
      // requests that MUST round up to a size class before carving,
      // same as any host-side creation. Auto-naming (no name given)
      // draws from the same MMAP-header counter host-side creation
      // uses, so this still can't collide with a host-created bank's
      // name.
      const bank = ctx.banks.createBank(tag, size);
      s.push(bank.base);
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

    // --- DEVELOPING.md §21, M28: the stack pointer as a real sysvar ---
    case 119: // SP0 ( -- a-addr )
      s.push(ctx.sysvars.getUnsigned('FORTH', 'SP0'));
      break;
    case 120: // SP@ ( -- a-addr )
      s.push(s.getPointer());
      break;
    case 121: // SP! ( a-addr -- )
      s.setPointer(s.pop());
      break;
    case 122: // RP0 ( -- a-addr )
      s.push(ctx.sysvars.getUnsigned('FORTH', 'RP0'));
      break;
    case 123: // RP@ ( -- a-addr )
      s.push(ctx.rstack.getPointer());
      break;
    case 124: // RP! ( a-addr -- )
      ctx.rstack.setPointer(s.pop());
      break;

    case 125: // HERE-ADDR ( -- addr ) — DEVELOPING.md §8.6, same pattern LATEST-ADDR
      // (case 95) established: the raw arena address of the HERE sysvar
      // cell itself, not its current value, so ordinary @/! can read and
      // write it directly. The gap FORGET (system.fth) needed: HERE was
      // read-only from Forth, same departure from Forth tradition LATEST
      // had before M13, left unfixed since nothing needed to write HERE
      // until now.
      s.push(ctx.sysvars.fieldOffset('FORTH', 'HERE'));
      break;

    // --- Project/bank storage (DEVELOPING.md's storage section, M33):
    // ordinary primitives now that StorageHal is synchronous
    // (local-storage-storage-hal.ts, not the earlier OPFS/Promise-based
    // one) — genuinely usable inside a colon-definition or via EXECUTE,
    // unlike the outer-loop-only special syntax PROJECT/SAVE/RESTORE
    // used to be (repl.ts's now-removed 'storage' StepStatus). ---
    case 126: // PROJECT ( "name" -- )
      ctx.sysvars.setProjectName(ctx.nextInputToken().toUpperCase());
      break;

    case 127: { // SAVE ( -- ) — every currently active bank, MMAP
      // included, in MMAP slot order (spec/01-HAL.md §6.3: no special
      // ordering requirement on the save side).
      const project = ctx.sysvars.getProjectName();
      if (!project) {
        throw new Error('no project name set - use PROJECT name first');
      }
      for (const bank of ctx.banks.getAllBanks()) {
        ctx.storage.saveAsset(project, bank);
      }
      break;
    }

    case 128: { // RESTORE ( "name" -- ) — Storage.openProject()'s
      // MMAP-first two-phase restore (§6.3.1), then repaint the visible
      // screen: a restore overwrites CHAR bytes directly, bypassing the
      // normal per-character HAL write-through screen.ts otherwise
      // always goes through, so nothing else would trigger a redraw.
      const project = ctx.nextInputToken().toUpperCase();
      ctx.sysvars.setProjectName(project);
      const restored = ctx.storage.openProject(project);
      // openProject() treats a missing project directory as "empty, not
      // an error" (§6.2's own hal_list_files contract) — correct at
      // that layer, but silent at this one leaves RESTORE looking like
      // it worked. Zero banks restored only happens for a directory
      // that doesn't exist or was never actually saved — a real SAVE
      // always writes MMAP plus 8 standard banks, so an existing
      // project can never legitimately restore to nothing.
      if (restored.length === 0) {
        throw new Error(`project '${project}' not found`);
      }
      ctx.screen.redrawAll();
      break;
    }

    case 129: { // BSAVE ( "tag" -- ) — save just one already-existing
      // bank, resolved by tag the same way BANK@ (case 99) does: "the
      // bank with this tag," first match if more than one shares it.
      const project = ctx.sysvars.getProjectName();
      if (!project) {
        throw new Error('no project name set - use PROJECT name first');
      }
      const tag = ctx.nextInputToken().toUpperCase();
      const bank = ctx.banks.requireBank(tag);
      ctx.storage.saveAsset(project, bank);
      break;
    }

    case 130: { // BLOAD ( "tag" -- ) — the single-bank counterpart to
      // RESTORE: overwrites one already-existing bank's own memory in
      // place from its previously-BSAVEd asset, rather than restoring a
      // whole project. Repaints the screen for the same reason RESTORE
      // does, only when the loaded bank is actually CHAR.
      const project = ctx.sysvars.getProjectName();
      if (!project) {
        throw new Error('no project name set - use PROJECT name first');
      }
      const tag = ctx.nextInputToken().toUpperCase();
      const bank = ctx.banks.requireBank(tag);
      const ok = ctx.storage.loadAsset(project, bank);
      if (!ok) {
        throw new Error(`no saved asset for bank ${tag} in project '${project}'`);
      }
      if (bank.tag === 'CHAR') {
        ctx.screen.redrawAll();
      }
      break;
    }

    case 131: // WARM ( -- ) — soft reset: same stack-clearing recovery
      // replLoop's own catch block performs after any uncaught error
      // (ABORT's effect, case 98), done directly rather than via throw,
      // and without touching DICT/MMAP — the running dictionary and bank
      // layout survive a WARM. No mid-definition guard is needed the way
      // replLoop's own catch block has one: WARM isn't IMMEDIATE, so a
      // non-immediate token typed while STATE is -1 gets compiled, not
      // executed — this case can never run with a half-finished
      // definition still open.
      ctx.stack.clear();
      ctx.rstack.clear();
      break;

    // COLD (132) never reaches here — inner.ts's dispatch() special-cases
    // it before executePrimitive is ever called, the same shape as
    // ACCEPT/EXECUTE, since a full reset needs host-level Machine
    // reconstruction (repl.ts's readonly fields), not anything this
    // switch can do in place.

    case 133: // REDRAW ( -- ) — same Screen.redrawAll() call RESTORE
      // (128) and BLOAD (130) already make internally after overwriting
      // CHAR directly; exposed as an ordinary word so Forth source that
      // pokes CHAR itself (BANK@ CHAR ... C!) has a way to repaint
      // without needing storage's fix-up path as an excuse to reach it.
      ctx.screen.redrawAll();
      break;

    // --- spec/04-FORTH-CORE.md §6.13, M43: the self-hosted outer
    // interpreter's own KERNEL primitives. ---
    case 134: { // WORD ( char -- addr len ) — raw-input-parsing access,
      // same basis as S"/(/''s classification (§2.2 rule 3). A view into
      // the live TIB, never a copy — a caller needing the text to outlive
      // the current line (CREATE, S") copies it themselves.
      const char = s.pop();
      const { addr, len } = ctx.wordScan(char);
      s.push(addr);
      s.push(len);
      break;
    }
    case 135: // STATE ( -- addr ) — direct sysvar-address exposure, same
      // pattern as BASE (114)/HERE-ADDR (125)/LATEST-ADDR (95). The
      // foundation `[`/`]`/INTERPRET (system.fth, §6.13) build on.
      s.push(ctx.sysvars.fieldOffset('FORTH', 'STATE'));
      break;

    case 136: // : ( "name" -- ) — spec/04-FORTH-CORE.md §5.2: begin a
      // definition. Not IMMEDIATE — dispatched like any other word found
      // while interpreting; while compiling, a non-immediate word is
      // just compiled as an ordinary call instead (§5.2's own "nothing
      // external gates this once dispatch is uniform"). beginDefinition
      // already self-guards against nesting (STATE === -1 → throw) —
      // exactly the "MUST check STATE itself" requirement, just reached
      // through ordinary dispatch now instead of repl.ts's old
      // special-casing.
      beginDefinition(ctx, ctx.nextInputToken(), DOCOL);
      break;
    case 137: // ; ( -- ) IMMEDIATE — §5.2: end a definition. MUST carry
      // IMMEDIATE (INTERPRET's compiling-mode dispatch rule is what
      // makes it run instead of compile, not its spelling) and MUST
      // self-check STATE, since — once IMMEDIATE — it would otherwise
      // execute unconditionally whenever found while interpreting too.
      if (ctx.sysvars.getState() !== -1) {
        throw new Error('; used outside a definition');
      }
      endDefinition(ctx, findWord(ctx, 'EXIT')!.cfa);
      break;
    case 138: // IMMEDIATE ( -- ) — §5.2: flags LATEST immediate. Not
      // itself IMMEDIATE — always typed and executed directly at the
      // prompt, never compiled into another definition's body.
      markLatestImmediate(ctx);
      break;
    case 139: // COMPILE-ONLY ( -- ) — the same bootstrap-marking
      // promotion IMMEDIATE (138) gets: `system.fth`'s own control-flow
      // words (§6.5) need a Forth-reachable way to set FLAG_COMPILE_ONLY
      // on themselves, and nothing else can. Not part of spec's own
      // vocabulary (predates M42, which added it as a special-cased
      // keyword specifically because nothing else could reach the flag
      // yet) — promoted to an ordinary primitive here for the same
      // "never special-cased by spelling" reason `:`/`;`/`IMMEDIATE` are.
      markLatestCompileOnly(ctx);
      break;

    case 140: { // (BLOCK-READ) ( addr n -- ) FORTH-ARCHITECTURE.md §7's
      // hal_block_read(n, addr): copy block n's 1024 bytes from the
      // resident BLKS bank into RAM at addr. Bounds-checked against
      // BLKS's actual size, not left to DataView to throw obscurely.
      const n = s.pop();
      const addr = s.pop();
      const blks = ctx.banks.requireBank('BLKS');
      const blockCount = blks.size / BLOCK_SIZE;
      if (n < 0 || n >= blockCount) {
        throw new Error(`block ${n} out of range (0..${blockCount - 1})`);
      }
      const blockBase = blks.base + n * BLOCK_SIZE;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        ctx.arena.writeByte(addr + i, ctx.arena.readByte(blockBase + i));
      }
      break;
    }

    case 141: { // (BLOCK-WRITE) ( addr n -- ) hal_block_write(n, addr):
      // the write-back half of (BLOCK-READ) (140) — same bounds check,
      // copies the other direction. Doesn't itself touch disk — SAVE/
      // BSAVE persist the whole BLKS bank separately, at project-save
      // time, same as any other bank.
      const n = s.pop();
      const addr = s.pop();
      const blks = ctx.banks.requireBank('BLKS');
      const blockCount = blks.size / BLOCK_SIZE;
      if (n < 0 || n >= blockCount) {
        throw new Error(`block ${n} out of range (0..${blockCount - 1})`);
      }
      const blockBase = blks.base + n * BLOCK_SIZE;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        ctx.arena.writeByte(blockBase + i, ctx.arena.readByte(addr + i));
      }
      break;
    }

    case 142: { // (SET-INPUT) ( addr len -- ) FORTH-ARCHITECTURE.md §7:
      // repoints the shared input cursor — LOAD's own mechanism for
      // feeding a BLOCK-resident screen line through WORD/FIND/NUMBER/
      // INTERPRET exactly like a typed line. Paren-named like
      // (BLOCK-READ)/(BLOCK-WRITE) (140/141): an internal primitive LOAD
      // calls, not something meant to be typed directly.
      const len = s.pop();
      const addr = s.pop();
      ctx.setInput(addr, len);
      break;
    }

    default:
      throw new Error(`unknown primitive token ${tokenId}`);
  }
}
