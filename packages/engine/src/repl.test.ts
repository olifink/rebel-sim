import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('Machine.interpret', () => {
  it('evaluates a basic arithmetic expression', () => {
    const m = new Machine();
    expect(m.interpret('2 3 + .')).toBe('5 ');
  });

  it('supports stack shuffling words', () => {
    const m = new Machine();
    m.interpret('1 2 SWAP');
    expect(m.stack.toArray()).toEqual([1, 2]);
  });

  it('DUP/DROP/OVER/ROT behave per their stack effects', () => {
    const m = new Machine();
    m.interpret('1 2 3 ROT');
    expect(m.stack.toArray()).toEqual([1, 3, 2]);

    const m2 = new Machine();
    m2.interpret('5 DUP');
    expect(m2.stack.toArray()).toEqual([5, 5]);

    const m3 = new Machine();
    m3.interpret('5 DROP');
    expect(m3.stack.depth).toBe(0);

    const m4 = new Machine();
    m4.interpret('1 2 OVER');
    expect(m4.stack.toArray()).toEqual([1, 2, 1]);
  });

  it('comparisons use the -1/0 boolean convention', () => {
    const m = new Machine();
    m.interpret('3 3 =');
    expect(m.stack.pop()).toBe(-1);

    const m2 = new Machine();
    m2.interpret('3 4 =');
    expect(m2.stack.pop()).toBe(0);
  });

  it('EMIT and CR write raw characters to output', () => {
    const m = new Machine();
    expect(m.interpret('65 EMIT')).toBe('A');
    expect(m.interpret('CR')).toBe('\n');
  });

  it('rejects unrecognized words', () => {
    const m = new Machine();
    expect(() => m.interpret('FROBNICATE')).toThrow(/unrecognized word/);
  });

  it('handles negative number literals', () => {
    const m = new Machine();
    expect(m.interpret('-5 3 + .')).toBe('-2 ');
  });

  it('divides and mods with truncating semantics, and rejects divide-by-zero', () => {
    const m = new Machine();
    expect(m.interpret('7 2 / .')).toBe('3 ');
    expect(m.interpret('7 2 MOD .')).toBe('1 ');
    expect(() => m.interpret('1 0 /')).toThrow(/division by zero/);
  });
});
