import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
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
    const bank = banks.createBank('SYSV', 64);
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
