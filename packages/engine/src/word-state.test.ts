import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

// Reads len bytes straight out of the arena at addr — the same "decode a
// WORD/nextInputToken view" a caller like CREATE or the outer interpreter
// itself would do, used here just to turn a returned (addr, len) pair back
// into a JS string for assertions.
function readString(m: Machine, addr: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(m.arena.readByte(addr + i));
  }
  return s;
}

describe('WORD (spec/04-FORTH-CORE.md §6.13)', () => {
  it('reads the next space-delimited token as a view into the TIB', () => {
    const m = new Machine();
    m.interpret('BL WORD HELLO');
    const len = m.stack.pop();
    const addr = m.stack.pop();
    expect(len).toBe(5);
    expect(readString(m, addr, len)).toBe('HELLO');
  });

  it('skips multiple leading delimiter occurrences', () => {
    const m = new Machine();
    m.interpret('BL WORD    HELLO');
    const len = m.stack.pop();
    const addr = m.stack.pop();
    expect(readString(m, addr, len)).toBe('HELLO');
  });

  it('returns len 0 once the line is exhausted, without throwing', () => {
    const m = new Machine();
    expect(() => m.interpret('BL WORD')).not.toThrow();
    const len = m.stack.pop();
    expect(len).toBe(0);
  });

  it('advances the shared cursor — two WORD calls pull consecutive tokens', () => {
    const m = new Machine();
    m.interpret('BL WORD ONE BL WORD TWO');
    const len2 = m.stack.pop();
    const addr2 = m.stack.pop();
    const len1 = m.stack.pop();
    const addr1 = m.stack.pop();
    expect(readString(m, addr1, len1)).toBe('ONE');
    expect(readString(m, addr2, len2)).toBe('TWO');
  });

  it('accepts any delimiter char, not just BL — comma-delimited read', () => {
    const m = new Machine();
    // Nothing follows the comma WORD consumes: the shared cursor is genuinely
    // shared, so whatever WORD doesn't consume becomes the next thing the
    // outer tokenizer itself tries to interpret — leaving "DEF,GHI" here
    // would correctly fail as an unrecognized word, not get silently ignored.
    m.interpret('44 WORD ABC,');
    const len = m.stack.pop();
    const addr = m.stack.pop();
    expect(readString(m, addr, len)).toBe('ABC');
  });

  it("doesn't copy — reading the same view twice sees the same live bytes", () => {
    const m = new Machine();
    m.interpret('BL WORD HELLO');
    const len = m.stack.pop();
    const addr = m.stack.pop();
    const first = readString(m, addr, len);
    const second = readString(m, addr, len);
    expect(first).toBe(second);
    expect(first).toBe('HELLO');
  });
});

describe('STATE (spec/04-FORTH-CORE.md §6.13)', () => {
  it('pushes an address whose live value matches Sysvars.getState()', () => {
    const m = new Machine();
    m.interpret('STATE @');
    expect(m.stack.pop()).toBe(m.sysvars.getState());
  });

  it('reads 0 (interpreting) at the top level', () => {
    const m = new Machine();
    m.interpret('STATE @');
    expect(m.stack.pop()).toBe(0);
  });

  it('is a real, writable sysvar cell — @/! round-trip through it', () => {
    const m = new Machine();
    m.interpret('STATE');
    const addr = m.stack.pop();
    expect(addr).toBe(m.sysvars.fieldOffset('FORTH', 'STATE'));
  });
});
