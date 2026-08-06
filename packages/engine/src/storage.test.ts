import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { Machine } from './repl.js';
import { Storage, StorageHal, runStorageSelfTest } from './storage.js';

/** A real (not no-op) in-memory StorageHal — lets these tests exercise
 * actual read-back behavior, the same role vi.fn() spies play for
 * ScreenHal in screen.test.ts, without needing a real OPFS/browser. */
function memoryHal(): StorageHal {
  const files = new Map<string, Uint8Array>();
  return {
    async ensureDir(): Promise<void> {},
    async listFiles(path: string): Promise<string[]> {
      const prefix = path.endsWith('/') ? path : path + '/';
      const names: string[] = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.push(key.slice(prefix.length));
        }
      }
      return names;
    },
    async readFile(path: string): Promise<Uint8Array | undefined> {
      return files.get(path);
    },
    async writeFile(path: string, bytes: Uint8Array): Promise<void> {
      files.set(path, bytes);
    },
  };
}

describe('Storage', () => {
  it('saveAsset then openProject (fresh bank table, same hal) restores identical bytes', async () => {
    const hal = memoryHal();

    const writeArena = new Arena(1 << 16);
    const writeBanks = new BankTable(writeArena);
    const writeStorage = new Storage(writeArena, writeBanks, hal);
    const bank = writeBanks.createBank('DATA', 64, 'MYASSET');
    for (let i = 0; i < bank.size; i++) {
      writeArena.writeByte(bank.base + i, (i * 3) & 0xff);
    }
    await writeStorage.saveAsset('APROJECT', bank);

    const readArena = new Arena(1 << 16);
    const readBanks = new BankTable(readArena);
    const readStorage = new Storage(readArena, readBanks, hal);
    const loaded = await readStorage.openProject('APROJECT');

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

  it('two CREATE-BANK banks sharing a tag no longer collide on save (DEVELOPING.md §20, M27 — the real bug this fixes)', async () => {
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
      await storage.saveAsset('COLLIDEPROJ', bank);
    }

    const readArena = new Arena(1 << 16);
    const readBanks = new BankTable(readArena);
    const readStorage = new Storage(readArena, readBanks, hal);
    const reloaded = await readStorage.openProject('COLLIDEPROJ');

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

  it('skips files with an unrecognized extension rather than throwing', async () => {
    const hal = memoryHal();
    await hal.writeFile('/PROJECTS/P/README.TXT', new Uint8Array([1, 2, 3]));

    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const loaded = await storage.openProject('P');
    expect(loaded).toHaveLength(0);
  });

  it('skips a file too short to hold the asset header rather than throwing', async () => {
    const hal = memoryHal();
    await hal.writeFile('/PROJECTS/P/SHORT.DAT', new Uint8Array([1, 2]));

    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const loaded = await storage.openProject('P');
    expect(loaded).toHaveLength(0);
  });

  it('openProject on a project directory that does not exist returns no banks', async () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, memoryHal());
    const loaded = await storage.openProject('NOPE');
    expect(loaded).toHaveLength(0);
  });

  it('saveAsset writes the 6-byte RA + tag header before the payload', async () => {
    const hal = memoryHal();
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const bank = banks.createBank('DATA', 64, 'HDRTEST');
    await storage.saveAsset('P', bank);

    const written = await hal.readFile('/PROJECTS/P/HDRTEST.DAT');
    expect(written).toBeDefined();
    expect(String.fromCharCode(written![0], written![1])).toBe('RA');
    expect(String.fromCharCode(written![2], written![3], written![4], written![5])).toBe('DATA');
    expect(written!.length).toBe(6 + bank.size);
  });

  it('saveAsset throws for a bank tag with no known file extension', async () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, memoryHal());
    // CART (spec/02-MEMORY-MODEL.md §4.6) is a real bank tag, but not
    // one spec/01-HAL.md §6.3's tag<->extension table maps yet — unlike
    // SYSV/DSTK/RSTK/CHAR/KMAP/MMAP/WORK, which this module's
    // TAG_TO_EXTENSION now covers (M29/M31).
    const bank = banks.createBank('CART', 64);
    await expect(storage.saveAsset('P', bank)).rejects.toThrow(/no known asset file extension/);
  });

  it('cart save/load round-trips an opaque flat binary', async () => {
    const hal = memoryHal();
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    await storage.saveCart('MYCART', bytes);
    const loaded = await storage.loadCart('MYCART');
    expect(loaded).toEqual(bytes);
  });

  it('loadCart returns undefined for a cart that was never saved', async () => {
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, memoryHal());
    expect(await storage.loadCart('NOPE')).toBeUndefined();
  });
});

describe('openProject — MMAP-first two-phase restore (spec/01-HAL.md §6.3.1, M29)', () => {
  it('restores the 8 standard banks plus an extra CREATE-BANKd bank at their exact original bases', async () => {
    const hal = memoryHal();

    const m1 = new Machine({ storageHal: hal });
    m1.interpret(': FOO 42 ;');
    m1.interpret('64 CREATE-BANK DATA');
    const extraAddr = m1.stack.pop();
    m1.arena.writeByte(extraAddr, 77);
    const extraBank = m1.banks.getAllBanks().find((b) => b.tag === 'DATA');
    expect(extraBank).toBeDefined();

    // Mirrors what Machine.runPendingStorage()'s 'save' branch does —
    // every active bank, in MMAP slot order, MMAP included.
    for (const bank of m1.banks.getAllBanks()) {
      await m1.storage.saveAsset('EXACTPRJ', bank);
    }

    const m2 = new Machine({ storageHal: hal });
    const restored = await m2.storage.openProject('EXACTPRJ');

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

  it('falls back to fresh bump-allocated banks when no MMAP.MAP asset is present (today\'s baseline, unchanged)', async () => {
    const hal = memoryHal();
    const arena = new Arena(1 << 16);
    const banks = new BankTable(arena);
    const storage = new Storage(arena, banks, hal);
    const bank = banks.createBank('DATA', 64, 'PLAINBNK'); // BANK_NAME_LEN = 8
    await storage.saveAsset('NOMAP', bank); // MMAP itself never saved

    const readArena = new Arena(1 << 16);
    const readBanks = new BankTable(readArena);
    const readStorage = new Storage(readArena, readBanks, hal);
    const loaded = await readStorage.openProject('NOMAP');

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('PLAINBNK');
    // Bump-allocated fresh (not reusing bank.base — readBanks has no
    // MMAP asset to restore an exact base from).
    expect(loaded[0].size).toBe(4096);
  });
});

describe('runStorageSelfTest', () => {
  it('passes against a working StorageHal', async () => {
    expect(await runStorageSelfTest(memoryHal())).toBe(true);
  });

  it('fails against a HAL that never actually persists anything', async () => {
    const brokenHal: StorageHal = {
      async ensureDir(): Promise<void> {},
      async listFiles(): Promise<string[]> {
        return [];
      },
      async readFile(): Promise<Uint8Array | undefined> {
        return undefined;
      },
      async writeFile(): Promise<void> {}, // silently drops the write
    };
    expect(await runStorageSelfTest(brokenHal)).toBe(false);
  });
});
