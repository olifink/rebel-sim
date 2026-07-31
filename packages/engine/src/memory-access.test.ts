import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

// HERE, not dictBank.base — the dictionary's own boot-registered entries
// (DUP, DROP, ...) already occupy the start of DICT; HERE is guaranteed
// free scratch space no earlier definition has claimed.
function scratchAddr(m: Machine): number {
  return m.sysvars.getHere();
}

describe('Memory access (M8, CORE-VOCABULARY.md §4)', () => {
  it('@ and ! round-trip a cell', () => {
    const m = new Machine();
    const addr = scratchAddr(m);
    m.interpret(`42 ${addr} !`);
    m.interpret(`${addr} @`);
    expect(m.stack.pop()).toBe(42);
  });

  it('! stores a negative cell correctly (signed round-trip)', () => {
    const m = new Machine();
    const addr = scratchAddr(m);
    m.interpret(`-7 ${addr} !`);
    m.interpret(`${addr} @`);
    expect(m.stack.pop()).toBe(-7);
  });

  it('C@ and C! operate on a single byte, zero-extended on read', () => {
    const m = new Machine();
    const addr = scratchAddr(m);
    m.interpret(`255 ${addr} C!`);
    m.interpret(`${addr} C@`);
    expect(m.stack.pop()).toBe(255);
  });

  it('C! truncates to the low 8 bits', () => {
    const m = new Machine();
    const addr = scratchAddr(m);
    m.interpret(`256 ${addr} C!`); // low byte of 256 is 0
    m.interpret(`${addr} C@`);
    expect(m.stack.pop()).toBe(0);
  });

  it('+! adds to the cell in place', () => {
    const m = new Machine();
    const addr = scratchAddr(m);
    m.interpret(`10 ${addr} !`);
    m.interpret(`5 ${addr} +!`);
    m.interpret(`${addr} @`);
    expect(m.stack.pop()).toBe(15);
  });
});
