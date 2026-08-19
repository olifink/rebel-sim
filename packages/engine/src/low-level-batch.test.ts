import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';

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

  it('self-hosted .S (system.fth, post-boot) on an empty stack prints nothing — regression for a real bug found by Oliver', () => {
    // system.fth's own `: .S DEPTH 0 DO ... LOOP ;` had no guard for the
    // empty-stack case (DEPTH 0). This Forth's DO/LOOP always runs its
    // body at least once, even when limit == start (TYPE has an explicit
    // guard for the exact same reason, just above in system.fth) -- so
    // `0 0 DO` still ran once, computing `-1 PICK` and printing a
    // garbage stack-pointer-ish value instead of nothing. Fixed by
    // adding the same `DUP 0= IF DROP EXIT THEN` guard TYPE already has.
    const m = bootMachine();
    expect(() => m.interpret('.S')).not.toThrow();
    expect(m.screen.readRowText(0).trimEnd()).toBe('');
    expect(m.stack.toArray()).toEqual([]);
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

  it('self-hosted FILL/CMOVE (system.fth, post-boot) with zero length are true no-ops — regression for a real bug found by Oliver', () => {
    // Same DO/LOOP-always-runs-once class as the .S bug above: system.fth's
    // own `: FILL ... SWAP DO ... LOOP DROP ;` and `: CMOVE 0 DO ... LOOP
    // 2DROP ;` had no zero-length guard, so `addr 0 char FILL` still wrote
    // one stray byte and `src dst 0 CMOVE` still copied one stray byte.
    // Fixed by adding TYPE's own `DUP 0= IF ... EXIT THEN` guard to both.
    const m = bootMachine();
    m.interpret('64 CREATE-BANK ZLEN');
    const addr = m.stack.pop();
    m.interpret(`${addr} 4 66 FILL`); // 'B' sentinel across the whole region
    m.interpret(`${addr} 0 88 FILL`); // zero-length -- must not touch byte 0
    m.interpret(`${addr} C@`);
    expect(m.stack.pop()).toBe(66);

    m.interpret(`${addr} 4 + 4 66 FILL`);
    m.interpret(`${addr + 8} 4 99 FILL`); // distinct sentinel for the CMOVE target
    m.interpret(`${addr} ${addr + 8} 0 CMOVE`); // zero-length -- must not touch target byte 0
    m.interpret(`${addr + 8} C@`);
    expect(m.stack.pop()).toBe(99);
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

describe('SP@/SP!/SP0, RP@/RP!/RP0 (DEVELOPING.md §21, M28)', () => {
  it('SP0 equals SP@ on an empty stack', () => {
    const m = new Machine();
    m.interpret('SP0');
    const sp0 = m.stack.pop();
    m.interpret('SP@'); // stack is empty again after the pop above
    const spEmpty = m.stack.pop();
    expect(spEmpty).toBe(sp0);
  });

  it('SP@ decreases by 4 (one cell) per push', () => {
    const m = new Machine();
    m.interpret('SP@');
    const before = m.stack.pop();
    m.interpret('99 SP@');
    const after = m.stack.pop();
    expect(before - after).toBe(4);
  });

  it('SP@ ... SP! round-trips depth back to zero — the standard stack-reset idiom', () => {
    const m = new Machine();
    m.interpret('SP@');
    const saved = m.stack.pop();
    m.interpret('1 2 3');
    expect(m.stack.depth).toBe(3);
    m.stack.push(saved);
    m.interpret('SP!');
    expect(m.stack.depth).toBe(0);
  });

  it('SP0 SP! empties the stack directly', () => {
    const m = new Machine();
    m.interpret('1 2 3 SP0 SP!');
    expect(m.stack.depth).toBe(0);
  });

  it('RP0/RP@ mirror SP0/SP@ for the return stack, and reflect a real in-progress call', () => {
    const m = new Machine();
    m.interpret(': DEPTH-INSIDE RP@ RP0 - ; DEPTH-INSIDE');
    // Inside DEPTH-INSIDE's own execution, the inner interpreter has
    // pushed one return address — RP@ must read strictly below RP0.
    expect(m.stack.pop()).toBeLessThan(0);
  });

  it('SP0/RP0 are independent constants — pushing onto one stack never moves the other', () => {
    const m = new Machine();
    m.interpret('RP0 RP@ =');
    expect(m.stack.pop()).toBe(-1); // TRUE: return stack still empty at the top level
    m.interpret('1 2 3'); // grows the data stack only
    m.interpret('RP0 RP@ =');
    expect(m.stack.pop()).toBe(-1); // still TRUE — RP unaffected by data-stack pushes
  });
});
