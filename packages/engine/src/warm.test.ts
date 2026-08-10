import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { findWord } from './dictionary.js';

describe('WARM (rebel-opcodes.json 131)', () => {
  it('empties both stacks but leaves an already-defined word findable', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    const hereBefore = m.sysvars.getHere();
    const latestBefore = m.sysvars.getLatest();

    m.interpret('1 2 3 WARM');

    expect(m.stack.depth).toBe(0);
    expect(m.rstack.depth).toBe(0);
    // DICT/MMAP genuinely untouched — same word, same HERE/LATEST.
    expect(findWord(m, 'SQUARE')).toBeDefined();
    expect(m.sysvars.getHere()).toBe(hereBefore);
    expect(m.sysvars.getLatest()).toBe(latestBefore);
  });

  it('does not throw — unlike ABORT, control returns normally to the rest of the line', () => {
    const m = new Machine();
    expect(() => m.interpret('1 2 3 WARM 4 5')).not.toThrow();
    // WARM cleared the stack mid-line; 4 5 pushed after it are what's
    // left (toArray() is top-of-stack first).
    expect(m.stack.toArray()).toEqual([5, 4]);
  });
});
