import { describe, expect, it } from 'vitest';
import { bootMachine } from './test-support.js';
import { findWord } from './dictionary.js';

// Runs `text` through the real, Forth-defined INTERPRET (system.fth,
// spec/04-FORTH-CORE.md §6.13) rather than the engine's own native
// fallback tokenizer — even before Step 5 flips the driving loop's own
// default preference. Works because the shared input cursor really is
// shared: `' INTERPRET EXECUTE` is itself processed by the (currently
// still-active) native fallback, but by the moment EXECUTE actually
// threads into INTERPRET's body, the cursor is sitting right after
// EXECUTE on the very same line — exactly where `text` starts. INTERPRET
// then reads the rest of the line itself, via its own WORD/FIND/NUMBER
// calls, the same way it will once it's the default path too.
function viaInterpret(text: string): string {
  return `' INTERPRET EXECUTE ${text}`;
}

describe('FIND (spec/04-FORTH-CORE.md §6.13)', () => {
  it('finds a native primitive, returning its real entry address', () => {
    const m = bootMachine();
    m.interpret(viaInterpret('S" DUP" FIND'));
    const flag = m.stack.pop();
    const entryAddr = m.stack.pop();
    expect(flag).toBe(-1);
    expect(entryAddr).toBe(findWord(m, 'DUP')!.entryAddr);
  });

  it('finds a bootstrap (Forth-defined) word too', () => {
    const m = bootMachine();
    m.interpret(viaInterpret('S" WORDS" FIND'));
    const flag = m.stack.pop();
    const entryAddr = m.stack.pop();
    expect(flag).toBe(-1);
    expect(entryAddr).toBe(findWord(m, 'WORDS')!.entryAddr);
  });

  it('is case-insensitive against the stored (always-uppercase) name', () => {
    const m = bootMachine();
    m.interpret(viaInterpret('S" dup" FIND'));
    const flag = m.stack.pop();
    const entryAddr = m.stack.pop();
    expect(flag).toBe(-1);
    expect(entryAddr).toBe(findWord(m, 'DUP')!.entryAddr);
  });

  it('reports flag 0 for a genuinely unknown name', () => {
    const m = bootMachine();
    m.interpret(viaInterpret('S" NOSUCHWORD" FIND'));
    const flag = m.stack.pop();
    expect(flag).toBe(0);
  });

  it('skips a HIDDEN entry (mid-compilation word) the same way native findWord does', () => {
    const m = bootMachine();
    // `:` leaves STATE compiling; `[` is IMMEDIATE so it runs even while
    // compiling, dropping back to interpreting for the rest of this same
    // line — enough to run FIND against PARTIAL's own still-HIDDEN name,
    // without needing viaInterpret()'s own "interpreting at the point
    // EXECUTE runs" assumption to hold across an unrelated open definition.
    m.interpret(': PARTIAL [ S" PARTIAL" FIND');
    expect(m.stack.pop()).toBe(0); // flag: not found (HIDDEN, correctly skipped)
  });
});

describe('NUMBER (spec/04-FORTH-CORE.md §6.13)', () => {
  it('parses a positive decimal number', () => {
    const m = bootMachine();
    m.interpret(viaInterpret('42'));
    expect(m.stack.pop()).toBe(42);
  });

  it('parses a negative decimal number', () => {
    const m = bootMachine();
    m.interpret(viaInterpret('-17'));
    expect(m.stack.pop()).toBe(-17);
  });

  it('respects the current BASE', () => {
    const m = bootMachine();
    m.interpret('16 BASE !');
    m.interpret(viaInterpret('FF'));
    expect(m.stack.pop()).toBe(255);
    m.interpret('10 BASE !');
  });

  it('rejects a digit invalid for the current BASE instead of silently accepting it', () => {
    // spec/04-FORTH-CORE.md's own reference NUMBER has no such check — 'F'
    // would silently parse as digit value 15 in base 10. This project adds
    // validation (M43) specifically so a typo still errors instead of
    // becoming a meaningless number.
    const m = bootMachine();
    expect(() => m.interpret(viaInterpret('FF'))).toThrow();
  });

  it('rejects non-alphanumeric garbage rather than treating it as digits', () => {
    const m = bootMachine();
    expect(() => m.interpret(viaInterpret('FOOBAR'))).toThrow();
  });

  it('rejects a lone minus sign passed directly to NUMBER', () => {
    // A bare "-" typed at the top level never reaches this guard at all —
    // "-" is itself a real dictionary word (subtraction), so FIND matches
    // it before NUMBER ever runs; EXECUTE-ing it on an empty stack throws
    // its own "stack underflow" first. Calling NUMBER directly (bypassing
    // FIND, the way S"'s addr/len feeds it here) is the only way to reach
    // this specific guard, since NUMBER is itself a public BOOTSTRAP word
    // (§6.13) other code can call directly, not merely INTERPRET's helper.
    const m = bootMachine();
    expect(() => m.interpret(viaInterpret('S" -" NUMBER'))).toThrow();
  });

  it('echoes the failing token to the screen before aborting (fig-Forth/Forth-79 "TOKEN ?" convention)', () => {
    // Neither predecessor had THROW/CATCH (an ANS Forth invention) — the
    // whole error-reporting mechanism was ABORT plus TYPEing the token
    // that failed. NUMBER does the TYPE itself (system.fth's NUM-ABORT)
    // since it's the only place holding the token's original addr/len by
    // the time a validation guard can fail.
    const m = bootMachine();
    expect(() => m.interpret(viaInterpret('FOOBAR'))).toThrow();
    expect(m.screen.readRowText(0).trimEnd()).toBe('FOOBAR');
  });

  it('echoes a lone minus sign the same way, called directly on NUMBER', () => {
    const m = bootMachine();
    expect(() => m.interpret(viaInterpret('S" -" NUMBER'))).toThrow();
    expect(m.screen.readRowText(0).trimEnd()).toBe('-');
  });
});

describe('INTERPRET (spec/04-FORTH-CORE.md §5.1-5.4, §6.13)', () => {
  it('executes a found word while interpreting', () => {
    const m = bootMachine();
    m.interpret(viaInterpret('3 4 +'));
    expect(m.stack.pop()).toBe(7);
  });

  it('rejects a COMPILE-ONLY word used while interpreting', () => {
    // Per this project's own decision: INTERPRET's Forth body signals this
    // via plain ABORT (no message-carrying THROW mechanism exists yet,
    // spec/04-FORTH-CORE.md §8) — unlike the native fallback's own
    // `${upper} is compile-only` message, this one is deliberately generic.
    const m = bootMachine();
    expect(() => m.interpret(viaInterpret('IF'))).toThrow(/ABORT/);
  });

  it('defines a word (switches to compiling mid-line) and calls it afterward', () => {
    const m = bootMachine();
    m.interpret(viaInterpret(': DOUBLE DUP + ;'));
    m.interpret(viaInterpret('5 DOUBLE'));
    expect(m.stack.pop()).toBe(10);
  });

  it('runs an IMMEDIATE word during compilation, not deferred', () => {
    const m = bootMachine();
    m.interpret(viaInterpret(': TATTLE 42 EMIT ; IMMEDIATE'));
    m.interpret(viaInterpret(': SHOUT TATTLE ;'));
    expect(m.screen.readRowText(0).trimEnd()).toBe('*'); // ran at SHOUT's compile time
  });

  it('compiles control flow correctly (IF/ELSE/THEN via the real control-flow words)', () => {
    const m = bootMachine();
    m.interpret(viaInterpret(': SIGN DUP 0< IF DROP -1 ELSE DROP 1 THEN ;'));
    m.interpret(viaInterpret('-5 SIGN'));
    expect(m.stack.pop()).toBe(-1);
    m.interpret(viaInterpret('5 SIGN'));
    expect(m.stack.pop()).toBe(1);
  });

  it('a genuinely unrecognized, non-numeric token throws', () => {
    const m = bootMachine();
    expect(() => m.interpret(viaInterpret('NOSUCHWORD!!'))).toThrow();
  });
});
