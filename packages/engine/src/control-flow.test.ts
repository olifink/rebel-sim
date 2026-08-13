import { describe, expect, it } from 'vitest';
import { bootMachine } from './test-support.js';

describe('Control flow (M8, CORE-VOCABULARY.md §6)', () => {
  it('IF...THEN executes the branch only when the flag is true', () => {
    const m = bootMachine();
    m.interpret(': TEST -1 IF 111 THEN ;');
    m.interpret('TEST');
    expect(m.stack.toArray()).toEqual([111]);

    const m2 = bootMachine();
    m2.interpret(': TEST 0 IF 111 THEN ;');
    m2.interpret('TEST');
    expect(m2.stack.depth).toBe(0);
  });

  it('IF...ELSE...THEN picks the right branch', () => {
    const m = bootMachine();
    m.interpret(': SIGN DUP 0< IF DROP -1 ELSE DROP 1 THEN ;');
    m.interpret('-5 SIGN');
    expect(m.stack.pop()).toBe(-1);
    m.interpret('5 SIGN');
    expect(m.stack.pop()).toBe(1);
  });

  it('nested IF/ELSE/THEN', () => {
    const m = bootMachine();
    m.interpret(': CLASSIFY DUP 0 = IF DROP 0 ELSE DUP 0< IF DROP -1 ELSE DROP 1 THEN THEN ;');
    m.interpret('0 CLASSIFY');
    expect(m.stack.pop()).toBe(0);
    m.interpret('-3 CLASSIFY');
    expect(m.stack.pop()).toBe(-1);
    m.interpret('3 CLASSIFY');
    expect(m.stack.pop()).toBe(1);
  });

  it('BEGIN...UNTIL loops until the flag is true', () => {
    const m = bootMachine();
    // Counts 1..5, leaving 5 on the stack, consuming nothing else.
    m.interpret(': COUNT-TO-5 0 BEGIN 1+ DUP 5 = UNTIL ;');
    m.interpret('COUNT-TO-5');
    expect(m.stack.toArray()).toEqual([5]);
  });

  it('BEGIN...WHILE...REPEAT loops while the flag is true (sum 1..5 via the return stack as an accumulator)', () => {
    const m = bootMachine();
    // ( -- sum ) accumulate 1..5 using >R as scratch storage for the running total.
    m.interpret(': SUM5 0 >R 1 BEGIN DUP 5 > INVERT WHILE DUP R> + >R 1+ REPEAT DROP R> ;');
    m.interpret('SUM5');
    expect(m.stack.pop()).toBe(15);
  });

  it('RECURSE calls the current definition', () => {
    const m = bootMachine();
    // Classic recursive factorial-ish countdown-sum: SUMDOWN(n) = n + SUMDOWN(n-1), base case n=0 -> 0.
    m.interpret(': SUMDOWN DUP 0= IF EXIT THEN DUP >R 1- RECURSE R> + ;');
    m.interpret('5 SUMDOWN');
    expect(m.stack.pop()).toBe(15); // 5+4+3+2+1+0
  });

  it('IF used outside a definition throws (matching : and other compile-only words)', () => {
    const m = bootMachine();
    expect(() => m.interpret('-1 IF 1 THEN')).toThrow();
  });
});
