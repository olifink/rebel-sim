import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('Return stack words (M8, CORE-VOCABULARY.md §5)', () => {
  it('>R and R> round-trip a value through the return stack', () => {
    const m = new Machine();
    m.interpret(': RTEST 5 >R 1 2 + R> + ;'); // (1+2) + 5
    m.interpret('RTEST');
    expect(m.stack.pop()).toBe(8);
  });

  it('R@ copies without consuming', () => {
    const m = new Machine();
    m.interpret(': RTEST 9 >R R@ R@ R> + + ;'); // 9 + 9 + 9
    m.interpret('RTEST');
    expect(m.stack.pop()).toBe(27);
  });

  it('>R/R> work correctly nested across two frames', () => {
    const m = new Machine();
    m.interpret(': INNER >R 1 R> ;'); // ( x -- 1 x )
    m.interpret(': OUTER 42 INNER ;');
    m.interpret('OUTER');
    expect(m.stack.toArray()).toEqual([42, 1]); // top-first: 42 on top, 1 underneath
  });
});
