import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable, BankFlagResident, BankFlagActive, BankFlagExternal } from './banks.js';
import { MMAP_MAX_SLOTS, MMAP_SIZE, MMAP_TAG } from './mmap.js';
import { Machine } from './repl.js';

describe('MMAP (DEVELOPING.md §11/§14, M19/M22) — the real source of truth, no cached state', () => {
  it('is created automatically as bank 0, absolute base 0', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const mmapBank = banks.findBank(MMAP_TAG)!;
    expect(mmapBank.base).toBe(0);
    expect(mmapBank.size).toBe(MMAP_SIZE);
    expect(mmapBank.flags).toBe(BankFlagResident | BankFlagActive);
  });

  it('is exactly one 4 KiB size class, no longer an exception to the size-class rule (spec §5.3)', () => {
    // Comfortably covers the default 64-slot table's raw 1552-byte
    // requirement (16-byte header + 64 * 24-byte slots) — the
    // module-load-time assertion in mmap.ts is what actually guards
    // against MAX_SLOTS someday outgrowing this class.
    expect(MMAP_SIZE).toBe(4096);
  });

  it("registers itself as its own slot 0 — describes itself, no implicit exception", () => {
    const banks = new BankTable(new Arena(1 << 16));
    expect(banks.mmap.getAllSlots()).toHaveLength(1);
    const slot0 = banks.mmap.getSlot(0);
    expect(slot0).toEqual({
      tag: MMAP_TAG,
      name: MMAP_TAG,
      base: 0,
      size: MMAP_SIZE,
      flags: BankFlagResident | BankFlagActive,
    });
  });

  it('allocates sequential banks with no gaps and no overlaps, derived fresh each time — no cursor cell involved', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const a = banks.createBank('DSTK', 64);
    // 4 KiB-aligned (spec/02-MEMORY-MODEL.md §4.4) — trivially exact
    // now that MMAP_SIZE (4096, MIN_BANK_SIZE-class, §5.3) is itself already a
    // 4 KiB multiple; the `& ~4095` mask is a no-op here, kept so this
    // assertion still documents the real rule rather than a coincidence.
    expect(a.base).toBe((MMAP_SIZE + 4095) & ~4095);

    const b = banks.createBank('RSTK', 128);
    expect(b.base).toBe(a.base + a.size); // right after a, no gap

    const c = banks.createBank('DATA', 32);
    expect(c.base).toBe(b.base + b.size); // right after b, no gap
  });

  it('the bank-naming serial lives in MMAP\'s own header, genuinely shared between host-side createBank() and CREATE-BANK (DEVELOPING.md §20, M27)', () => {
    const m = new Machine();
    // Interleaved on purpose: host, then Forth, then host again — no
    // collision, because both draw from the exact same MMAP.NEXT-BANK
    // cell, not two independently-incrementing counters that happen
    // not to collide by accident of nothing else calling one of them.
    const a = m.banks.createBank('DATA', 64); // host-side, no name given
    m.interpret('64 CREATE-BANK DATA'); // Forth-side
    const forthAddr = m.stack.pop();
    const b = m.banks.createBank('DATA', 64); // host-side again

    const forthBank = m.banks.getAllBanks().find((bk) => bk.base === forthAddr)!;
    const names = [a.name, forthBank.name, b.name];
    expect(new Set(names).size).toBe(3); // all distinct
    // And genuinely sequential, not just distinct by luck.
    const asNumbers = names.map((n) => Number(n));
    expect(asNumbers[1]).toBe(asNumbers[0] + 1);
    expect(asNumbers[2]).toBe(asNumbers[1] + 1);
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

  it('respects a caller-supplied flags value (ACTIVE always forced on regardless), both host-side and mirrored', () => {
    const banks = new BankTable(new Arena(1 << 16));
    const bank = banks.createBank('SCRN', 64, 'EXTBANK', BankFlagExternal);
    const expectedFlags = BankFlagExternal | BankFlagActive;
    expect(bank.flags).toBe(expectedFlags);
    expect(banks.mmap.getSlot(1).flags).toBe(expectedFlags);
  });

  it('throws once all 64 slots are used, same as the real slot-full case', () => {
    const banks = new BankTable(new Arena(1 << 20));
    // Slot 0 is MMAP itself — 63 more banks exactly fill the table.
    for (let i = 0; i < MMAP_MAX_SLOTS - 1; i++) {
      banks.createBank('DATA', 64);
    }
    expect(banks.mmap.getAllSlots()).toHaveLength(MMAP_MAX_SLOTS);
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
    // MMAP's own layout (M27): header(16) + slotIndex*24, then
    // tag(4)+name(8) lead into base at +12, size at +16, flags at +20
    // within a slot. Header grew from 4 to 16 (M27, DEVELOPING.md §20)
    // — magic+version+reserved(4) + NEXT-BANK(4) + ARENA-SIZE(4) +
    // ARENA-ID(4).
    const dictSlotIndex = m.banks.getAllBanks().findIndex((b) => b.tag === 'DICT');
    const slotAddr = 16 + dictSlotIndex * 24;

    m.interpret(`${slotAddr} 12 + @`); // base
    expect(m.stack.pop()).toBe(dict.base);
    m.interpret(`${slotAddr} 16 + @`); // size
    expect(m.stack.pop()).toBe(dict.size);
  });
});

describe('CREATE-BANK (DEVELOPING.md §13/§14, M21/M22) — Forth-side bank creation, no host round-trip, no cached state', () => {
  // Tags are conventionally exactly 4 characters throughout this
  // codebase (SYSV, DICT, DATA, ...) — the tag field is a fixed 4-byte
  // slot, so a longer tag silently truncates on write. Every tag below
  // is deliberately 4 characters, matching real usage, except the one
  // test that specifically demonstrates the truncation edge case.

  it('creates a bank immediately findable via BANK@, by its real (auto-generated) name', () => {
    // M50: BANK@ resolves by name now, not tag — "DAT1" here is only
    // the tag CREATE-BANK parsed (and, per M27 below, deliberately
    // never what it names the bank), so the real re-lookup has to go
    // through the auto-generated name, same as any caller genuinely
    // would (or, more idiomatically, just keep the address CREATE-BANK
    // already returned).
    const m = new Machine();
    m.interpret('4096 CREATE-BANK DAT1');
    const createdAddr = m.stack.pop();
    const created = m.banks.findBank('DAT1')!;

    m.interpret(`BANK@ ${created.name}`);
    expect(m.stack.pop()).toBe(createdAddr);
  });

  it('places the new bank right after the current highest-extent active slot, derived fresh, not from a cached cursor', () => {
    const m = new Machine();
    const before = m.banks.getAllBanks();
    const expectedBase = Math.max(...before.map((b) => b.base + b.size));

    m.interpret('256 CREATE-BANK SCR1');
    const addr = m.stack.pop();
    expect(addr).toBe(expectedBase);

    // A second creation lands right after the first, no gap — right
    // after SCR1's *rounded* size class (4096), not its raw
    // requested 256 bytes (spec/02-MEMORY-MODEL.md §4.3).
    m.interpret('64 CREATE-BANK SCR2');
    const addr2 = m.stack.pop();
    expect(addr2).toBe(addr + 4096);
  });

  it('the created bank is real, usable memory — @ and ! round-trip at its address', () => {
    const m = new Machine();
    m.interpret('64 CREATE-BANK SCR3');
    const addr = m.stack.pop();

    m.interpret(`42 ${addr} ! ${addr} @`);
    expect(m.stack.pop()).toBe(42);
  });

  it('is now visible to BankTable.getAllBanks()/findBank() too — M22 closes the M21 visibility gap', () => {
    const m = new Machine();
    const before = m.banks.getAllBanks().length;
    m.interpret('128 CREATE-BANK GAP1');
    const addr = m.stack.pop();

    expect(m.banks.getAllBanks().length).toBe(before + 1);
    const bank = m.banks.findBank('GAP1');
    expect(bank).toMatchObject({
      tag: 'GAP1',
      base: addr,
      size: 4096, // rounded up from the requested 128 (spec/02-MEMORY-MODEL.md §4.3)
      flags: BankFlagResident | BankFlagActive,
    });
    // M27, DEVELOPING.md §20: named after an auto-generated serial now,
    // not the tag — see the "names the bank after an auto-generated
    // serial" test below for why.
    expect(bank!.name).toMatch(/^\d{8}$/);
    // M50: BANK@ resolves by that real name now, not the "GAP1" tag —
    // reaching it by tag would only ever work by luck (first-match), the
    // exact ambiguity this change removes.
    m.interpret(`BANK@ ${bank!.name}`);
    expect(m.stack.pop()).toBe(addr);
  });

  it("createBank()'s name-uniqueness check now also catches a Forth-created bank's name (M22/M27)", () => {
    const m = new Machine();
    m.interpret('64 CREATE-BANK DUPE');
    m.stack.pop();
    // M27: the bank's real name is its auto-generated serial, not
    // "DUPE" (that's only its tag) — read it back rather than assume.
    const created = m.banks.findBank('DUPE')!;
    expect(() => m.banks.createBank('DATA', 64, created.name)).toThrow(/already exists/);
  });

  it('names the bank after an auto-generated serial, not the tag — M27 fixes a real name-collision bug', () => {
    const m = new Machine();
    // Deliberately >4 chars, to confirm tag truncation still applies
    // independently of naming (unaffected by this change).
    m.interpret('32 CREATE-BANK LONGNAMETAG');
    const addr = m.stack.pop();
    const first = m.banks.mmap.getAllSlots().find((sl) => sl.base === addr)!;
    expect(first.tag).toBe('LONGNAMETAG'.slice(0, 4)); // TAG_SIZE
    expect(first.name).toMatch(/^\d{8}$/); // serial, not tag-derived

    // DEVELOPING.md §20's real motivating bug, reproduced directly:
    // before M27, two CREATE-BANK calls sharing a tag always got the
    // *same* name too (both derived from the tag), silently colliding.
    m.interpret('16 CREATE-BANK LONGNAMETAG');
    const addr2 = m.stack.pop();
    const second = m.banks.mmap.getAllSlots().find((sl) => sl.base === addr2)!;
    expect(second.name).not.toBe(first.name);
  });

  it('throws once MMAP itself is full, same as any other allocate() caller', () => {
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
