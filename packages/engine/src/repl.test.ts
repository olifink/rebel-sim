import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('Machine.interpret', () => {
  it('evaluates a basic arithmetic expression', () => {
    const m = new Machine();
    m.interpret('2 3 + .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('5');
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

  it('EMIT writes a character at the cursor and CR moves to the next row', () => {
    const m = new Machine();
    m.interpret('65 EMIT');
    expect(m.screen.readRowText(0).trimEnd()).toBe('A');
    expect(m.screen.getCursorCol()).toBe(1);

    m.interpret('CR');
    expect(m.screen.getCursorCol()).toBe(0);
    expect(m.screen.getCursorRow()).toBe(1);
  });

  it('rejects unrecognized words', () => {
    const m = new Machine();
    expect(() => m.interpret('FROBNICATE')).toThrow(/unrecognized word/);
  });

  it('handles negative number literals', () => {
    const m = new Machine();
    m.interpret('-5 3 + .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('-2');
  });

  it('divides and mods with truncating semantics, and rejects divide-by-zero', () => {
    const m = new Machine();
    m.interpret('7 2 / .');
    m.interpret('7 2 MOD .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('3 1');
    expect(() => m.interpret('1 0 /')).toThrow(/division by zero/);
  });
});
