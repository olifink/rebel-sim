import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { DataStack, StackOverflowError, StackUnderflowError } from './stack.js';
import { Sysvars } from './sysvars.js';

function makeStack(bankSize = 16) {
  // Big enough for MMAP's own fixed overhead (DEVELOPING.md §11, M19 —
  // every BankTable reserves bank 0 for it), a real SYSV bank (the live
  // pointer is sysvar-backed since DEVELOPING.md §21, M28), and this
  // test's tiny DSTK bank.
  const arena = new Arena(1 << 16);
  const banks = new BankTable(arena);
  const sysvBank = banks.createBank('SYSV', 4096); // room for the FORTH group's real offsets
  const sysvars = new Sysvars(arena, sysvBank);
  const bank = banks.createBank('DSTK', bankSize);
  return new DataStack(arena, bank, sysvars, 'SP0', 'SP');
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

describe('DataStack pointer as a real sysvar (DEVELOPING.md §21, M28)', () => {
  function makeStackWithSysvars(bankSize = 16) {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const sysvBank = banks.createBank('SYSV', 4096);
    const sysvars = new Sysvars(arena, sysvBank);
    const bank = banks.createBank('DSTK', bankSize);
    const stack = new DataStack(arena, bank, sysvars, 'SP0', 'SP');
    return { arena, sysvars, bank, stack };
  }

  it('writes SP0 (the base) and SP (the live pointer) to the same empty address at construction', () => {
    const { sysvars, bank } = makeStackWithSysvars();
    const empty = bank.base + bank.size;
    expect(sysvars.getUnsigned('FORTH', 'SP0')).toBe(empty);
    expect(sysvars.getUnsigned('FORTH', 'SP')).toBe(empty);
  });

  it('getPointer() moves with every push/pop, and matches the arena address the top cell actually lives at', () => {
    const { arena, stack } = makeStackWithSysvars();
    const empty = stack.getPointer();
    stack.push(111);
    expect(stack.getPointer()).toBe(empty - 4);
    expect(arena.readCell(stack.getPointer())).toBe(111);
    stack.pop();
    expect(stack.getPointer()).toBe(empty);
  });

  it('SP0 never moves as SP does', () => {
    const { sysvars, stack } = makeStackWithSysvars();
    const sp0Before = sysvars.getUnsigned('FORTH', 'SP0');
    stack.push(1);
    stack.push(2);
    expect(sysvars.getUnsigned('FORTH', 'SP0')).toBe(sp0Before);
    expect(sysvars.getUnsigned('FORTH', 'SP')).not.toBe(sp0Before);
  });

  it('setPointer() restores a saved getPointer() value — the standard SP@ ... SP! reset idiom', () => {
    const { stack } = makeStackWithSysvars();
    stack.push(1);
    const savedSp = stack.getPointer();
    stack.push(2);
    stack.push(3);
    expect(stack.depth).toBe(3);
    stack.setPointer(savedSp);
    expect(stack.depth).toBe(1);
    expect(stack.peek(0)).toBe(1);
  });

  it('two DataStack instances sharing one Sysvars stay independent via distinct field names', () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const sysvBank = banks.createBank('SYSV', 4096);
    const sysvars = new Sysvars(arena, sysvBank);
    const dstkBank = banks.createBank('DSTK', 16);
    const rstkBank = banks.createBank('RSTK', 16);
    const stack = new DataStack(arena, dstkBank, sysvars, 'SP0', 'SP');
    const rstack = new DataStack(arena, rstkBank, sysvars, 'RP0', 'RP');

    stack.push(42);
    expect(stack.depth).toBe(1);
    expect(rstack.depth).toBe(0);

    rstack.push(7);
    rstack.push(8);
    expect(rstack.depth).toBe(2);
    expect(stack.depth).toBe(1); // unaffected by rstack's own pushes
  });
});
