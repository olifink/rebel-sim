import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable, BankSizeXS, BankSizeS, BankSizeM, roundToSizeClass } from './banks.js';

describe('roundToSizeClass', () => {
  it('rounds up to the smallest class that fits', () => {
    expect(roundToSizeClass(1)).toBe(BankSizeXS);
    expect(roundToSizeClass(BankSizeXS)).toBe(BankSizeXS);
    expect(roundToSizeClass(BankSizeXS + 1)).toBe(BankSizeS);
    expect(roundToSizeClass(BankSizeS + 1)).toBe(BankSizeM);
  });

  it('returns undefined when nothing fits', () => {
    expect(roundToSizeClass(Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });
});

describe('BankTable', () => {
  it('auto-generates a unique 8-digit zero-padded serial name when none is given', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const a = banks.createBank('DATA', 64);
    const b = banks.createBank('DATA', 64);
    expect(a.name).toBe('00000000');
    expect(b.name).toBe('00000001');
  });

  it('accepts an explicit name and finds it by name alone', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const bank = banks.createBank('DATA', 64, 'TESTDATA');
    expect(bank.name).toBe('TESTDATA');
    expect(banks.findBankByName('TESTDATA')).toBe(bank);
  });

  it('allows multiple banks sharing a tag, distinguished only by name', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const a = banks.createBank('DATA', 64, 'ASSET1');
    const b = banks.createBank('DATA', 64, 'ASSET2');
    expect(banks.findBank('DATA', 'ASSET1')).toBe(a);
    expect(banks.findBank('DATA', 'ASSET2')).toBe(b);
    expect(banks.findBank('DATA')).toBe(a); // "a bank of this type" — first match
  });

  it('rejects a duplicate name even across different tags', () => {
    const banks = new BankTable(new Arena(1 << 16));
    banks.createBank('DATA', 64, 'DUPLICAT');
    expect(() => banks.createBank('SCRN', 64, 'DUPLICAT')).toThrow(/already exists/);
  });

  it('requireBank throws for a name that was never created', () => {
    const banks = new BankTable(new Arena(1 << 16));
    expect(() => banks.requireBank('DATA', 'MISSING')).toThrow(/not found/);
  });

  it('getAllBanks lists every bank in creation order, MMAP always first', () => {
    // DEVELOPING.md §11, M19: MMAP is bank 0, created automatically by
    // BankTable itself — never an empty table, even before any
    // deliberate createBank() call.
    const banks = new BankTable(new Arena(1 << 16));
    const initial = banks.getAllBanks();
    expect(initial).toHaveLength(1);
    expect(initial[0].tag).toBe('MMAP');

    const a = banks.createBank('DSTK', 64);
    const b = banks.createBank('RSTK', 64);
    expect(banks.getAllBanks()).toEqual([initial[0], a, b]);
  });
});
