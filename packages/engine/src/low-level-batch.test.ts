import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

function run(line: string): number[] {
  const m = new Machine();
  m.interpret(line);
  return m.stack.toArray();
}

describe('Low-level primitive batch (DEVELOPING.md §15, M23)', () => {
  it('XOR', () => {
    expect(run('6 3 XOR')).toEqual([5]); // 110 ^ 011 = 101
    expect(run('5 5 XOR')).toEqual([0]);
  });

  it('.S prints the stack bottom-to-top, non-destructively', () => {
    const m = new Machine();
    m.interpret('1 2 3 .S');
    expect(m.screen.readRowText(0).trimEnd()).toBe('1 2 3');
    expect(m.stack.toArray()).toEqual([3, 2, 1]); // untouched
  });

  it('.S on an empty stack prints nothing and does not throw', () => {
    const m = new Machine();
    expect(() => m.interpret('.S')).not.toThrow();
    expect(m.screen.readRowText(0).trimEnd()).toBe('');
  });

  it('2SWAP', () => {
    // ( a b c d -- c d a b ), bottom-to-top: 1 2 3 4 -> 3 4 1 2; top-first (toArray order): [2, 1, 4, 3]
    expect(run('1 2 3 4 2SWAP')).toEqual([2, 1, 4, 3]);
  });

  it('2OVER', () => {
    expect(run('1 2 3 4 2OVER')).toEqual([2, 1, 4, 3, 2, 1]);
  });

  it('CELLS and CELL+', () => {
    expect(run('3 CELLS')).toEqual([12]);
    expect(run('100 CELL+')).toEqual([104]);
  });

  it('FILL writes len bytes of char starting at addr', () => {
    const m = new Machine();
    m.interpret('64 CREATE-BANK FILB');
    const addr = m.stack.pop();
    m.interpret(`${addr} 8 42 FILL`);
    for (let i = 0; i < 8; i++) {
      m.interpret(`${addr + i} C@`);
      expect(m.stack.pop()).toBe(42);
    }
  });

  it('CMOVE copies len bytes low-to-high', () => {
    const m = new Machine();
    m.interpret('64 CREATE-BANK CMVB');
    const addr = m.stack.pop();
    const src = addr;
    const dst = addr + 32;
    m.interpret(`${src} 4 99 FILL`);
    m.interpret(`${src} ${dst} 4 CMOVE`);
    for (let i = 0; i < 4; i++) {
      m.interpret(`${dst + i} C@`);
      expect(m.stack.pop()).toBe(99);
    }
  });

  it('BL pushes the space character code', () => {
    expect(run('BL')).toEqual([32]);
  });

  it('SPACE emits a single space', () => {
    const m = new Machine();
    m.interpret('SPACE');
    expect(m.screen.readRowText(0)[0]).toBe(' ');
  });

  it('WITHIN is true for lo <= n < hi, false at and beyond hi', () => {
    expect(run('5 0 10 WITHIN')).toEqual([-1]);
    expect(run('0 0 10 WITHIN')).toEqual([-1]); // lo inclusive
    expect(run('10 0 10 WITHIN')).toEqual([0]); // hi exclusive
    expect(run('-1 0 10 WITHIN')).toEqual([0]);
  });

  it('0 PICK is DUP, 1 PICK is OVER', () => {
    expect(run('5 0 PICK')).toEqual([5, 5]);
    expect(run('1 2 1 PICK')).toEqual([1, 2, 1]);
  });

  it('0 ROLL is a no-op, 1 ROLL is SWAP, 2 ROLL is ROT', () => {
    expect(run('1 0 ROLL')).toEqual([1]);
    expect(run('1 2 1 ROLL')).toEqual([1, 2]); // SWAP: bottom-to-top a b -> b a
    expect(run('1 2 3 2 ROLL')).toEqual([1, 3, 2]); // ROT: a b c -> b c a
  });
});

describe('BASE/HEX/DECIMAL (DEVELOPING.md §16, M24)', () => {
  it('BASE defaults to 10 on a fresh Machine', () => {
    expect(run('BASE @')).toEqual([10]);
  });

  it('HEX sets BASE to 16, DECIMAL sets it back to 10', () => {
    expect(run('HEX BASE @')).toEqual([16]);
    expect(run('HEX DECIMAL BASE @')).toEqual([10]);
  });

  it('BASE is a real writable variable, not just HEX/DECIMAL private state', () => {
    expect(run('16 BASE ! BASE @')).toEqual([16]);
  });

  it('HEX changes how . formats output', () => {
    const m = new Machine();
    // 255 is parsed while still decimal, HEX only affects formatting on .
    m.interpret('255 HEX .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('ff');
  });

  it('after HEX, every subsequent numeric token parses as hex too — a real, documented consequence, not a bug', () => {
    // "10" under BASE 16 is decimal 16, not decimal 10.
    expect(run('HEX 10 DECIMAL')).toEqual([16]);
  });
});
