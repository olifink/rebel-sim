import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('Strings (M8, CORE-VOCABULARY.md §8)', () => {
  it('S" pushes addr/len for an inline-compiled string, TYPE prints it', () => {
    const m = new Machine();
    m.interpret(': GREET S" hello" TYPE ;');
    m.interpret('GREET');
    expect(m.screen.readRowText(0).trimEnd()).toBe('hello');
  });

  it('S" addr/len round-trips through C@ (the bytes are really there, not synthesized)', () => {
    const m = new Machine();
    m.interpret(': GET-STR S" abc" ;');
    m.interpret('GET-STR');
    const len = m.stack.pop();
    const addr = m.stack.pop();
    expect(len).toBe(3);
    expect(m.arena.readByte(addr)).toBe('a'.charCodeAt(0));
    expect(m.arena.readByte(addr + 1)).toBe('b'.charCodeAt(0));
    expect(m.arena.readByte(addr + 2)).toBe('c'.charCodeAt(0));
  });

  it('two different S" strings in the same word compile to two independent inline regions', () => {
    const m = new Machine();
    m.interpret(': TWO S" one" TYPE 32 EMIT S" two" TYPE ;');
    m.interpret('TWO');
    expect(m.screen.readRowText(0).trimEnd()).toBe('one two');
  });

  it('." prints its string directly (sugar for S" ... TYPE)', () => {
    const m = new Machine();
    m.interpret(': HI ." hi" ;');
    m.interpret('HI');
    expect(m.screen.readRowText(0).trimEnd()).toBe('hi');
  });

  it('S" is compile-time only for now — throws a clear error while interpreting', () => {
    const m = new Machine();
    // compileOnly (checked by the outer interpreter before dispatch, per
    // the M8 IF/DO/... fix) fires first; the internal STATE check inside
    // compileInlineString is a redundant defensive backstop for a path
    // that's actually unreachable now (S" is always IMMEDIATE, so it can
    // never end up compiled as a plain call into another word's body).
    expect(() => m.interpret('S" oops"')).toThrow(/compile-only/);
  });

  it('S"/." now support multi-word strings (DEVELOPING.md §2.4 fixed the old single-token-only limitation)', () => {
    const m = new Machine();
    m.interpret(': GREET S" hello world" TYPE ;');
    m.interpret('GREET');
    expect(m.screen.readRowText(0).trimEnd()).toBe('hello world');

    const m2 = new Machine();
    m2.interpret(': HI ." hi there friend" ;');
    m2.interpret('HI');
    expect(m2.screen.readRowText(0).trimEnd()).toBe('hi there friend');
  });

  it('a word compiled with S" can be called more than once, correctly, each time', () => {
    const m = new Machine();
    m.interpret(': GREET S" hi" TYPE ;');
    m.interpret('GREET');
    m.interpret('CR');
    m.interpret('GREET');
    expect(m.screen.readRowText(0).trimEnd()).toBe('hi');
    expect(m.screen.readRowText(1).trimEnd()).toBe('hi');
  });
});
