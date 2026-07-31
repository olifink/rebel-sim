import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('DO/LOOP (M8, CORE-VOCABULARY.md §6)', () => {
  it('DO...LOOP runs from index to limit-1, I pushes the current index', () => {
    const m = new Machine();
    m.interpret(': COUNT 5 0 DO I . LOOP ;');
    m.interpret('COUNT');
    expect(m.screen.readRowText(0).trimEnd()).toBe('0 1 2 3 4');
  });

  it('DO...LOOP sums 0..4 via I', () => {
    const m = new Machine();
    m.interpret(': SUM5 0 5 0 DO I + LOOP ;');
    m.interpret('SUM5');
    expect(m.stack.pop()).toBe(0 + 1 + 2 + 3 + 4);
  });

  it('a single-iteration DO...LOOP runs exactly once', () => {
    const m = new Machine();
    m.interpret(': ONE 0 1 0 DO 1+ LOOP ;');
    m.interpret('ONE');
    expect(m.stack.pop()).toBe(1);
  });

  it('DO...LOOP with limit=index runs once, not zero times — classic Forth behavior, not a bug: DO never pre-checks, LOOP only tests after the body has already run', () => {
    const m = new Machine();
    m.interpret(': ONCE 0 3 3 DO 1+ LOOP ;');
    m.interpret('ONCE');
    expect(m.stack.pop()).toBe(1);
  });

  it('nested DO loops: I is innermost, J is one level out', () => {
    const m = new Machine();
    m.interpret(': NESTED 2 0 DO 3 0 DO J 10 * I + . LOOP LOOP ;');
    m.interpret('NESTED');
    // outer j=0: inner i=0,1,2 -> 0,1,2 ; outer j=1: inner i=0,1,2 -> 10,11,12
    expect(m.screen.readRowText(0).trimEnd()).toBe('0 1 2 10 11 12');
  });

  it('+LOOP counts up by a custom increment', () => {
    const m = new Machine();
    m.interpret(': EVENS 10 0 DO I . 2 +LOOP ;');
    m.interpret('EVENS');
    expect(m.screen.readRowText(0).trimEnd()).toBe('0 2 4 6 8');
  });

  it('+LOOP counts down with a negative increment', () => {
    const m = new Machine();
    m.interpret(': COUNTDOWN 0 5 DO I . -1 +LOOP ;');
    m.interpret('COUNTDOWN');
    expect(m.screen.readRowText(0).trimEnd()).toBe('5 4 3 2 1');
  });

  it('DO/LOOP used outside a definition throws (compile-only)', () => {
    const m = new Machine();
    expect(() => m.interpret('5 0 DO I LOOP')).toThrow(/compile-only/);
  });
});
