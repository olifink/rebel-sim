import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { DataStack, StackOverflowError, StackUnderflowError } from './stack.js';

function makeStack(bankSize = 16) {
  const arena = new Arena(64);
  const banks = new BankTable(arena);
  const bank = banks.createBank('DSTK', 'main', bankSize);
  return new DataStack(arena, bank);
}

describe('DataStack', () => {
  it('pushes and pops in LIFO order', () => {
    const s = makeStack();
    s.push(1);
    s.push(2);
    s.push(3);
    expect(s.pop()).toBe(3);
    expect(s.pop()).toBe(2);
    expect(s.pop()).toBe(1);
  });

  it('reports depth and a top-to-bottom snapshot', () => {
    const s = makeStack();
    s.push(10);
    s.push(20);
    expect(s.depth).toBe(2);
    expect(s.toArray()).toEqual([20, 10]);
  });

  it('throws on underflow', () => {
    const s = makeStack();
    expect(() => s.pop()).toThrow(StackUnderflowError);
  });

  it('throws on overflow', () => {
    const s = makeStack(8); // room for 2 cells
    s.push(1);
    s.push(2);
    expect(() => s.push(3)).toThrow(StackOverflowError);
  });
});
