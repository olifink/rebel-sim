import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable, BankFlagResident, BankFlagActive, BankFlagExternal } from './banks.js';
import { MMAP_MAX_SLOTS, MMAP_SIZE, MMAP_TAG } from './mmap.js';
import { Machine } from './repl.js';

describe('MMAP (DEVELOPING.md §11, M19) — mirror only, not yet the source of truth', () => {
  it('is created automatically as bank 0, absolute base 0', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const mmapBank = banks.findBank(MMAP_TAG)!;
    expect(mmapBank.base).toBe(0);
    expect(mmapBank.size).toBe(MMAP_SIZE);
    expect(mmapBank.flags).toBe(BankFlagResident | BankFlagActive);
  });

  it("registers itself as its own slot 0 — describes itself, no implicit exception", () => {
    const banks = new BankTable(new Arena(1 << 16));
    expect(banks.mmap.getSlotCount()).toBe(1);
    const slot0 = banks.mmap.getSlot(0);
    expect(slot0).toEqual({
      tag: MMAP_TAG,
      name: MMAP_TAG,
      base: 0,
      size: MMAP_SIZE,
      flags: BankFlagResident | BankFlagActive,
    });
  });

  it('header next-free tracks the real allocation cursor as banks are created', () => {
    const banks = new BankTable(new Arena(1 << 16));
    expect(banks.mmap.getNextFree()).toBe(MMAP_SIZE);

    const a = banks.createBank('DSTK', 64);
    expect(banks.mmap.getNextFree()).toBe(a.base + a.size);

    const b = banks.createBank('RSTK', 128);
    expect(banks.mmap.getNextFree()).toBe(b.base + b.size);
  });

  it('mirrors every created bank into a slot, in creation order, matching getAllBanks() exactly', () => {
    const banks = new BankTable(new Arena(1 << 16));
    banks.createBank('DSTK', 64, 'ASTACK');
    banks.createBank('RSTK', 64, 'RSTACK');
    banks.createBank('DATA', 32);

    const real = banks.getAllBanks();
    const mirrored = banks.mmap.getAllSlots();
    expect(mirrored).toHaveLength(real.length);
    for (let i = 0; i < real.length; i++) {
      expect(mirrored[i]).toEqual({
        tag: real[i].tag,
        name: real[i].name,
        base: real[i].base,
        size: real[i].size,
        flags: real[i].flags,
      });
    }
  });

  it('respects a caller-supplied flags value, both host-side and mirrored', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const bank = banks.createBank('SCRN', 64, 'EXTBANK', BankFlagExternal);
    expect(bank.flags).toBe(BankFlagExternal);
    expect(banks.mmap.getSlot(1).flags).toBe(BankFlagExternal);
  });

  it('throws once all 64 slots are used, same as the real slot-full case', () => {
    const banks = new BankTable(new Arena(1 << 20));
    // Slot 0 is MMAP itself — 63 more banks exactly fill the table.
    for (let i = 0; i < MMAP_MAX_SLOTS - 1; i++) {
      banks.createBank('DATA', 64);
    }
    expect(banks.mmap.getSlotCount()).toBe(MMAP_MAX_SLOTS);
    expect(() => banks.createBank('DATA', 64)).toThrow(/MMAP is full/);
  });

  it('every bank Machine itself creates ends up mirrored correctly, including MMAP', () => {
    const m = new Machine();
    const real = m.banks.getAllBanks();
    const mirrored = m.banks.mmap.getAllSlots();
    expect(mirrored).toHaveLength(real.length);
    expect(mirrored[0].tag).toBe(MMAP_TAG);
    for (let i = 0; i < real.length; i++) {
      expect(mirrored[i].tag).toBe(real[i].tag);
      expect(mirrored[i].base).toBe(real[i].base);
      expect(mirrored[i].size).toBe(real[i].size);
    }
  });

  it('a slot is readable directly via raw @ from Forth source, matching BANK@ for the same bank', () => {
    const m = new Machine();
    const dict = m.banks.findBank('DICT')!;
    // MMAP's own layout: header(12) + slotIndex*24, then tag(4)+name(8)
    // lead into base at +12, size at +16, flags at +20 within a slot.
    const dictSlotIndex = m.banks.getAllBanks().findIndex((b) => b.tag === 'DICT');
    const slotAddr = 12 + dictSlotIndex * 24;

    m.interpret(`${slotAddr} 12 + @`); // base
    expect(m.stack.pop()).toBe(dict.base);
    m.interpret(`${slotAddr} 16 + @`); // size
    expect(m.stack.pop()).toBe(dict.size);
  });
});
