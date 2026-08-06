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

  it('S" works loose at the prompt now (M16, DEVELOPING.md §7) — pushes addr/len via PAD, not a throw', () => {
    const m = new Machine();
    m.interpret('S" hello" TYPE');
    expect(m.screen.readRowText(0).trimEnd()).toBe('hello');
  });

  it('." works loose at the prompt too, printing directly with no PAD involved', () => {
    const m = new Machine();
    m.interpret('." hi there"');
    expect(m.screen.readRowText(0).trimEnd()).toBe('hi there');
  });

  it('interpreted S" is overwritten by the next S" call — PAD is a single shared scratch region, not per-call storage', () => {
    const m = new Machine();
    m.interpret('S" first"');
    const len1 = m.stack.pop();
    const addr1 = m.stack.pop();
    m.interpret('S" second-longer"');
    const len2 = m.stack.pop();
    const addr2 = m.stack.pop();
    expect(addr1).toBe(addr2); // same PAD base, reused
    let text = '';
    for (let i = 0; i < len2; i++) text += String.fromCharCode(m.arena.readByte(addr2 + i));
    expect(text).toBe('second-longer');
    expect(len1).toBe(5);
  });

  it('interpreted S" throws if the text is too long for PAD, rather than corrupting adjacent arena memory', () => {
    const m = new Machine();
    // padSize is now 4096 (PAD_BANK_SIZE rounds up to the XS size
    // class, spec/02-MEMORY-MODEL.md §4.3) — comfortably over that.
    const tooLong = 'x '.repeat(2200).trim();
    expect(() => m.interpret(`S" ${tooLong}"`)).toThrow(/too long for PAD/);
  });

  it('PAD ( -- addr ) exposes the scratch region address directly', () => {
    const m = new Machine();
    m.interpret('S" abc" DROP PAD =');
    expect(m.stack.pop()).toBe(-1); // TRUE — S"'s addr is PAD's base
  });

  it('compiled S"/." behavior is unaffected by the interpreted-mode addition — still inline-compiled, no PAD involved', () => {
    const m = new Machine();
    m.interpret(': GREET S" hello" TYPE ;');
    m.interpret('GREET');
    const addrBefore = (() => {
      m.interpret(': GET S" hello" ;');
      m.interpret('GET');
      const len = m.stack.pop();
      const addr = m.stack.pop();
      expect(len).toBe(5);
      return addr;
    })();
    m.interpret('PAD');
    const padBase = m.stack.pop();
    expect(addrBefore).not.toBe(padBase); // compiled string lives in DICT, not PAD
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
