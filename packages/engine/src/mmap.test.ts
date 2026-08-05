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

describe('MemoryMap.findBankAddr (DEVELOPING.md §12, M20) — BANK@\'s real lookup path', () => {
  it('resolves a known tag to the same base address findBank() reports', () => {
    const m = new Machine();
    const dict = m.banks.findBank('DICT')!;
    expect(m.banks.mmap.findBankAddr('DICT')).toBe(dict.base);
  });

  it('returns undefined for an unknown tag, not a thrown error', () => {
    const m = new Machine();
    expect(m.banks.mmap.findBankAddr('NOPE')).toBeUndefined();
  });

  it('resolves the first-created bank when a tag repeats, matching findBank(tag) semantics', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const first = banks.createBank('DATA', 64, 'FIRST');
    banks.createBank('DATA', 64, 'SECOND');
    expect(banks.mmap.findBankAddr('DATA')).toBe(first.base);
  });

  it('BANK@ itself now resolves through findBankAddr(), not findBank() — same observable result', () => {
    const m = new Machine();
    const sysv = m.banks.findBank('SYSV')!;
    m.interpret('BANK@ SYSV');
    const result = m.stack.pop();
    expect(result).toBe(sysv.base);
    expect(result).toBe(m.banks.mmap.findBankAddr('SYSV'));
  });
});

describe('CREATE-BANK (DEVELOPING.md §13, M21) — Forth-side bank creation, no host round-trip', () => {
  // Tags are conventionally exactly 4 characters throughout this
  // codebase (SYSV, DICT, DATA, ...) — the tag field is a fixed 4-byte
  // slot, so a longer tag silently truncates on write. Every tag below
  // is deliberately 4 characters, matching real usage, except the one
  // test that specifically demonstrates the truncation edge case.

  it('creates a bank immediately findable via BANK@, at the address CREATE-BANK itself returned', () => {
    const m = new Machine();
    m.interpret('4096 CREATE-BANK DAT1');
    const createdAddr = m.stack.pop();

    m.interpret('BANK@ DAT1');
    expect(m.stack.pop()).toBe(createdAddr);
  });

  it("places the new bank right at MMAP's next-free offset, and advances it by exactly its size", () => {
    const m = new Machine();
    const before = m.banks.mmap.getNextFree();
    m.interpret('256 CREATE-BANK SCR1');
    const addr = m.stack.pop();

    expect(addr).toBe(before);
    expect(m.banks.mmap.getNextFree()).toBe(before + 256);
  });

  it('the created bank is real, usable memory — @ and ! round-trip at its address', () => {
    const m = new Machine();
    m.interpret('64 CREATE-BANK SCR2');
    const addr = m.stack.pop();

    m.interpret(`42 ${addr} ! ${addr} @`);
    expect(m.stack.pop()).toBe(42);
  });

  it('is invisible to BankTable.getAllBanks()/findBank() — the documented gap, not a silent regression', () => {
    const m = new Machine();
    const before = m.banks.getAllBanks().length;
    m.interpret('128 CREATE-BANK GAP1');

    expect(m.banks.getAllBanks().length).toBe(before); // unchanged
    expect(m.banks.findBank('GAP1')).toBeUndefined();
    // ...yet BANK@ (M20, reads MMAP directly) sees it fine.
    expect(() => m.interpret('BANK@ GAP1')).not.toThrow();
  });

  it('names the bank after its (truncated) tag — no auto-serial, matching DEVELOPING.md §13', () => {
    const m = new Machine();
    // Deliberately >4 chars, to demonstrate the truncation edge case
    // directly (not via BANK@, which never truncates its search tag —
    // a >4-char CREATE-BANK tag is only findable by its first 4 chars).
    m.interpret('32 CREATE-BANK LONGNAMETAG');
    const addr = m.stack.pop();

    const slot = m.banks.mmap.getAllSlots().find((sl) => sl.base === addr)!;
    expect(slot.tag).toBe('LONGNAMETAG'.slice(0, 4)); // TAG_SIZE
    expect(slot.name).toBe('LONGNAMETAG'.slice(0, 8)); // BANK_NAME_LEN
  });

  it('throws once MMAP itself is full, same as any other addBank() caller', () => {
    const m = new Machine();
    // Machine already created 9 banks (MMAP + 8); fill the rest.
    const remaining = MMAP_MAX_SLOTS - m.banks.getAllBanks().length;
    for (let i = 0; i < remaining; i++) {
      m.interpret('16 CREATE-BANK FILL');
      m.stack.pop();
    }
    expect(() => m.interpret('16 CREATE-BANK OVER')).toThrow(/MMAP is full/);
  });
});
