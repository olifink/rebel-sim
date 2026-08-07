import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { Machine } from './repl.js';
import { Storage, StorageHal, runStorageSelfTest } from './storage.js';

/** A real (not no-op) in-memory StorageHal — lets these tests exercise
 * actual read-back behavior, the same role vi.fn() spies play for
 * ScreenHal in screen.test.ts, without needing a real browser. Synchronous
 * now (M33: StorageHal dropped Promises when the real backend moved from
 * OPFS to localStorage), matching the interface it implements. */
function memoryHal(): StorageHal {
  const files = new Map<string, Uint8Array>();
  return {
    ensureDir(): void {},
    listFiles(path: string): string[] {
      const prefix = path.endsWith('/') ? path : path + '/';
      const names: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.push(key.slice(prefix.length));
        }
      }
      return names;
    },
    readFile(path: string): Uint8Array | undefined {
      return files.get(path);
    },
    writeFile(path: string, bytes: Uint8Array): void {
      files.set(path, bytes);
    },
  };
}

describe('Storage', () => {
  it('saveAsset then openProject (fresh bank table, same hal) restores identical bytes', () => {
    const hal = memoryHal();

    const writeArena = new Arena(1 << 16);
    const writeBanks = new BankTable(writeArena);
    const writeStorage = new Storage(writeArena, writeBanks, hal);
    const bank = writeBanks.createBank('DATA', 64, 'MYASSET');
    for (let i = 0; i < bank.size; i++) {
      writeArena.writeByte(bank.base + i, (i * 3) & 0xff);
    }
    writeStorage.saveAsset('APROJECT', bank);

    const readArena = new Arena(1 << 16);
    const readBanks = new BankTable(readArena);
    const readStorage = new Storage(readArena, readBanks, hal);
    const loaded = readStorage.openProject('APROJECT');

    expect(loaded).toHaveLength(1);
    expect(loaded[0].tag).toBe('DATA');
    expect(loaded[0].name).toBe('MYASSET');
    // The reloaded bank is rounded up to a size class (XS, 4 KiB) — only
    // the original 64-byte payload should match; the rest is legitimate
    // zero-filled slack, not part of the round-trip contract.
    expect(loaded[0].size).toBe(4096);
    for (let i = 0; i < bank.size; i++) {
      expect(readArena.readByte(loaded[0].base + i)).toBe((i * 3) & 0xff);
    }
  });

  it('two CREATE-BANK banks sharing a tag no longer collide on save (DEVELOPING.md §20, M27 — the real bug this fixes)', () => {
    const hal = memoryHal();
    const m = new Machine();
    const storage = new Storage(m.arena, m.banks, hal);

    m.interpret('64 CREATE-BANK DATA');
    const addr1 = m.stack.pop();
    m.interpret('64 CREATE-BANK DATA');
    const addr2 = m.stack.pop();
    m.arena.writeByte(addr1, 111);
    m.arena.writeByte(addr2, 222);

    const created = m.banks.getAllBanks().filter((b) => b.tag === 'DATA');
    expect(created).toHaveLength(2);
    expect(created[0].name).not.toBe(created[1].name); // the actual fix

    for (const bank of created) {
      storage.saveAsset('COLLIDEPROJ', bank);
    }

    const readArena = new Arena(1 << 16);
    const readBanks = new BankTable(readArena);
    const readStorage = new Storage(readArena, readBanks, hal);
    const reloaded = readStorage.openProject('COLLIDEPROJ');

    // Before M27, both banks shared name "DATA" — reproduced directly
    // while reviewing this: the second saveAsset() silently clobbered
    // the first's file, and openProject() threw "bank name DATA
    // already exists" and aborted the whole project load. Now: two
    // distinct files, both banks recovered, both original byte values
    // intact.
    expect(reloaded).toHaveLength(2);
    const bytes = reloaded.map((b) => readArena.readByte(b.base)).sort();
    expect(bytes).toEqual([111, 222]);
  });

  it('skips files with an unrecognized extension rather than throwing', () => {
    const hal = memoryHal();
    hal.writeFile('/PROJECTS/P/README.TXT', new Uint8Array([1, 2, 3]));

    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const loaded = storage.openProject('P');
    expect(loaded).toHaveLength(0);
  });

  it('skips a file too short to hold the asset header rather than throwing', () => {
    const hal = memoryHal();
    hal.writeFile('/PROJECTS/P/SHORT.DAT', new Uint8Array([1, 2]));

    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const loaded = storage.openProject('P');
    expect(loaded).toHaveLength(0);
  });

  it('openProject on a project directory that does not exist returns no banks', () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, memoryHal());
    const loaded = storage.openProject('NOPE');
    expect(loaded).toHaveLength(0);
  });

  it('saveAsset writes the 6-byte RA + tag header before the payload', () => {
    const hal = memoryHal();
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const bank = banks.createBank('DATA', 64, 'HDRTEST');
    storage.saveAsset('P', bank);

    const written = hal.readFile('/PROJECTS/P/HDRTEST.DAT');
    expect(written).toBeDefined();
    expect(String.fromCharCode(written![0], written![1])).toBe('RA');
    expect(String.fromCharCode(written![2], written![3], written![4], written![5])).toBe('DATA');
    expect(written!.length).toBe(6 + bank.size);
  });

  it('saveAsset throws for a bank tag with no known file extension', () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, memoryHal());
    // CART (spec/02-MEMORY-MODEL.md §4.6) is a real bank tag, but not
    // one spec/01-HAL.md §6.3's tag<->extension table maps yet — unlike
    // SYSV/DSTK/RSTK/CHAR/KMAP/MMAP/WORK, which this module's
    // TAG_TO_EXTENSION now covers (M29/M31).
    const bank = banks.createBank('CART', 64);
    expect(() => storage.saveAsset('P', bank)).toThrow(/no known asset file extension/);
  });

  it('loadAsset overwrites an already-existing bank in place from its saved asset', () => {
    const hal = memoryHal();

    const writeArena = new Arena(1 << 16);
    const writeBanks = new BankTable(writeArena);
    const writeStorage = new Storage(writeArena, writeBanks, hal);
    const bank = writeBanks.createBank('DATA', 64, 'REFRESH');
    for (let i = 0; i < bank.size; i++) {
      writeArena.writeByte(bank.base + i, 1);
    }
    writeStorage.saveAsset('BPROJ', bank);

    // A fresh bank, same identity, different content — loadAsset should
    // overwrite it in place, not create/return a new Bank.
    const readArena = new Arena(1 << 16);
    const readBanks = new BankTable(readArena);
    const readStorage = new Storage(readArena, readBanks, hal);
    const freshBank = readBanks.createBank('DATA', 64, 'REFRESH');
    expect(readStorage.loadAsset('BPROJ', freshBank)).toBe(true);
    for (let i = 0; i < bank.size; i++) {
      expect(readArena.readByte(freshBank.base + i)).toBe(1);
    }
  });

  it('loadAsset returns false, changing nothing, when no asset was ever saved', () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, memoryHal());
    const bank = banks.createBank('DATA', 64, 'NEVERSVD');
    arena.writeByte(bank.base, 42);
    expect(storage.loadAsset('NOPROJ', bank)).toBe(false);
    expect(arena.readByte(bank.base)).toBe(42); // untouched
  });

  it('loadAsset throws for a saved payload too large for the current bank, rather than silently truncating', () => {
    const hal = memoryHal();
    const bigArena = new Arena(1 << 20);
    const bigBanks = new BankTable(bigArena);
    const bigStorage = new Storage(bigArena, bigBanks, hal);
    const bigBank = bigBanks.createBank('DATA', 16 * 1024, 'BIGONE'); // S class
    bigStorage.saveAsset('P', bigBank);

    const smallArena = new Arena(1 << 16);
    const smallBanks = new BankTable(smallArena);
    const smallStorage = new Storage(smallArena, smallBanks, hal);
    const smallBank = smallBanks.createBank('DATA', 4096, 'BIGONE'); // XS class — too small
    expect(() => smallStorage.loadAsset('P', smallBank)).toThrow(/too large/);
  });

  it('cart save/load round-trips an opaque flat binary', () => {
    const hal = memoryHal();
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    storage.saveCart('MYCART', bytes);
    const loaded = storage.loadCart('MYCART');
    expect(loaded).toEqual(bytes);
  });

  it('loadCart returns undefined for a cart that was never saved', () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, memoryHal());
    expect(storage.loadCart('NOPE')).toBeUndefined();
  });
});

describe('openProject — MMAP-first two-phase restore (spec/01-HAL.md §6.3.1, M29)', () => {
  it('restores the 8 standard banks plus an extra CREATE-BANKd bank at their exact original bases', () => {
    const hal = memoryHal();

    const m1 = new Machine({ storageHal: hal });
    m1.interpret(': FOO 42 ;');
    m1.interpret('64 CREATE-BANK DATA');
    const extraAddr = m1.stack.pop();
    m1.arena.writeByte(extraAddr, 77);
    const extraBank = m1.banks.getAllBanks().find((b) => b.tag === 'DATA');
    expect(extraBank).toBeDefined();

    // Mirrors what the SAVE primitive itself does — every active bank,
    // in MMAP slot order, MMAP included.
    for (const bank of m1.banks.getAllBanks()) {
      m1.storage.saveAsset('EXACTPRJ', bank);
    }

    const m2 = new Machine({ storageHal: hal });
    const restored = m2.storage.openProject('EXACTPRJ');

    // Every standard bank's base is unchanged (deterministic given the
    // same boot constants — restoring MMAP's bytes reproduces values
    // m2 already had), and the extra bank now exists at m1's exact
    // recorded base, not a freshly bump-allocated one.
    const m2Extra = m2.banks.findBankByName(extraBank!.name);
    expect(m2Extra).toBeDefined();
    expect(m2Extra!.base).toBe(extraBank!.base);
    expect(m2Extra!.tag).toBe('DATA');
    expect(m2.arena.readByte(m2Extra!.base)).toBe(77);

    for (const tag of ['SYSV', 'DSTK', 'RSTK', 'DICT', 'CHAR', 'KMAP', 'WORK', 'MMAP']) {
      const original = m1.banks.findBank(tag);
      const reloaded = m2.banks.findBank(tag);
      expect(reloaded!.base).toBe(original!.base);
      expect(reloaded!.size).toBe(original!.size);
    }

    // The dictionary content itself round-tripped — FOO is callable on
    // the fresh machine without ever being defined there directly.
    m2.interpret('FOO');
    expect(m2.stack.pop()).toBe(42);

    expect(restored.length).toBeGreaterThan(0);
  });

  it('falls back to fresh bump-allocated banks when no MMAP.MAP asset is present (today\'s baseline, unchanged)', () => {
    const hal = memoryHal();
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const bank = banks.createBank('DATA', 64, 'PLAINBNK'); // BANK_NAME_LEN = 8
    storage.saveAsset('NOMAP', bank); // MMAP itself never saved

    const readArena = new Arena(1 << 16);
    const readBanks = new BankTable(readArena);
    const readStorage = new Storage(readArena, readBanks, hal);
    const loaded = readStorage.openProject('NOMAP');

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('PLAINBNK');
    // Bump-allocated fresh (not reusing bank.base — readBanks has no
    // MMAP asset to restore an exact base from).
    expect(loaded[0].size).toBe(4096);
  });
});

describe('runStorageSelfTest', () => {
  it('passes against a working StorageHal', () => {
    expect(runStorageSelfTest(memoryHal())).toBe(true);
  });

  it('fails against a HAL that never actually persists anything', () => {
    const brokenHal: StorageHal = {
      ensureDir(): void {},
      listFiles(): string[] {
        return [];
      },
      readFile(): Uint8Array | undefined {
        return undefined;
      },
      writeFile(): void {}, // silently drops the write
    };
    expect(runStorageSelfTest(brokenHal)).toBe(false);
  });
});
