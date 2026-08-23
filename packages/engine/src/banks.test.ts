import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable, MIN_BANK_SIZE, MAX_BANK_SIZE, roundToSizeClass } from './banks.js';

// M55 (Oliver): size classes double (was 4 KiB, 8 KiB, 16 KiB, ...;
// 2 KiB, 4 KiB, 8 KiB, ... as of M58's lower floor) instead of
// quadrupling — finer-grained rounding, no more per-class names.
describe('roundToSizeClass', () => {
  it('rounds up to the smallest power-of-two class that fits, floored at MIN_BANK_SIZE', () => {
    expect(roundToSizeClass(1)).toBe(MIN_BANK_SIZE);
    expect(roundToSizeClass(MIN_BANK_SIZE)).toBe(MIN_BANK_SIZE);
    expect(roundToSizeClass(MIN_BANK_SIZE + 1)).toBe(MIN_BANK_SIZE * 2);
    expect(roundToSizeClass(MIN_BANK_SIZE * 2 + 1)).toBe(MIN_BANK_SIZE * 4);
  });

  it('is exactly the doubling ladder from MIN_BANK_SIZE to MAX_BANK_SIZE', () => {
    let expected = MIN_BANK_SIZE;
    while (expected <= MAX_BANK_SIZE) {
      expect(roundToSizeClass(expected)).toBe(expected);
      expected *= 2;
    }
  });

  it('returns undefined once the request exceeds MAX_BANK_SIZE', () => {
    expect(roundToSizeClass(MAX_BANK_SIZE)).toBe(MAX_BANK_SIZE);
    expect(roundToSizeClass(MAX_BANK_SIZE + 1)).toBeUndefined();
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
    // .toEqual, not .toBe: DEVELOPING.md §14, M22 — findBankByName()
    // now decodes a fresh object from MMAP's arena bytes each call, no
    // longer a cached reference, so object identity isn't preserved.
    expect(banks.findBankByName('TESTDATA')).toEqual(bank);
  });

  it('allows multiple banks sharing a tag, distinguished only by name', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const a = banks.createBank('DATA', 64, 'ASSET1');
    const b = banks.createBank('DATA', 64, 'ASSET2');
    expect(banks.findBank('DATA', 'ASSET1')).toEqual(a);
    expect(banks.findBank('DATA', 'ASSET2')).toEqual(b);
    expect(banks.findBank('DATA')).toEqual(a); // "a bank of this type" — first match
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
