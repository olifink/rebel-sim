import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { BLOCK_SIZE } from './banks.js';
import { StorageHal } from './storage.js';

/** Same in-memory StorageHal shape as project.test.ts's memoryHal(). */
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
    listDirs(path: string): string[] {
      const prefix = path.endsWith('/') ? path : path + '/';
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash > 0) names.add(rest.slice(0, slash));
      }
      return [...names].sort();
    },
    readFile(path: string): Uint8Array | undefined {
      return files.get(path);
    },
    writeFile(path: string, bytes: Uint8Array): void {
      files.set(path, bytes);
    },
  };
}

describe('BLKS bank (FORTH-ARCHITECTURE.md §7, renamed from SCRS 2026-08-18)', () => {
  it('is boot-created as a 16-block (16 KiB) resident bank tagged BLKS, named EDITOR', () => {
    // Tag stays the generic, HAL-level "1024-byte block storage" identity
    // (BANK@/requireBank always resolve by tag) — name is the real,
    // uniqueness-backed per-bank identity, free to say what THIS instance
    // is actually for, since a tag is expected to repeat across banks.
    // Named for its only consumer today, the Screen Editor.
    const m = new Machine();
    const blks = m.banks.requireBank('BLKS');
    expect(blks.name).toBe('EDITOR');
    expect(blks.size).toBe(16 * BLOCK_SIZE);
  });

  it('is reachable via BANK@ like any other bank', () => {
    const m = new Machine();
    const blks = m.banks.requireBank('BLKS');
    m.interpret('BANK@ BLKS');
    expect(m.stack.toArray()).toEqual([blks.base]);
  });
});

/** (BLOCK-READ)/(BLOCK-WRITE)'s `addr` side needs a full 1024-byte
 * resident region — PAD/TIB (128/256 bytes) are too small, so tests use
 * a dedicated scratch bank rather than risk silently overrunning into
 * whatever bank happens to sit next in the arena. */
function scratchBuf(m: Machine): number {
  return m.banks.createBank('DATA', BLOCK_SIZE, 'BLKTEST').base;
}

describe('(BLOCK-READ) / (BLOCK-WRITE) ( addr n -- ) — FORTH-ARCHITECTURE.md §7 hal_block_read/write', () => {
  it('round-trips a full 1024-byte block through RAM and back', () => {
    const m = new Machine();
    const scratch = scratchBuf(m);

    for (let i = 0; i < BLOCK_SIZE; i++) {
      m.arena.writeByte(scratch + i, i & 0xff);
    }
    m.interpret(`${scratch} 3 (BLOCK-WRITE)`);

    // Clobber the scratch region so the read-back can't be a no-op false positive.
    for (let i = 0; i < BLOCK_SIZE; i++) {
      m.arena.writeByte(scratch + i, 0);
    }
    m.interpret(`${scratch} 3 (BLOCK-READ)`);

    for (let i = 0; i < BLOCK_SIZE; i++) {
      expect(m.arena.readByte(scratch + i)).toBe(i & 0xff);
    }
  });

  it('writes land at the correct block offset, leaving neighboring blocks untouched', () => {
    const m = new Machine();
    const blks = m.banks.requireBank('BLKS');
    const scratch = scratchBuf(m);

    for (let i = 0; i < BLOCK_SIZE; i++) {
      m.arena.writeByte(scratch + i, 0xaa);
    }
    m.interpret(`${scratch} 5 (BLOCK-WRITE)`);

    expect(m.arena.readByte(blks.base + 5 * BLOCK_SIZE)).toBe(0xaa);
    expect(m.arena.readByte(blks.base + 5 * BLOCK_SIZE + BLOCK_SIZE - 1)).toBe(0xaa);
    // Block 4's last byte and block 6's first byte are the immediate
    // neighbors — untouched means still the space (32) BLKS is natively
    // filled with at bank creation (repl.ts, Screen Editor follow-up),
    // not a raw zero byte.
    expect(m.arena.readByte(blks.base + 4 * BLOCK_SIZE + BLOCK_SIZE - 1)).toBe(32);
    expect(m.arena.readByte(blks.base + 6 * BLOCK_SIZE)).toBe(32);
  });

  it('reads/writes work at both ends of the 16-block range (0 and 15)', () => {
    const m = new Machine();
    const scratch = scratchBuf(m);

    m.arena.writeByte(scratch, 1);
    m.interpret(`${scratch} 0 (BLOCK-WRITE)`);
    m.arena.writeByte(scratch, 2);
    m.interpret(`${scratch} 15 (BLOCK-WRITE)`);

    m.arena.writeByte(scratch, 0);
    m.interpret(`${scratch} 0 (BLOCK-READ)`);
    expect(m.arena.readByte(scratch)).toBe(1);

    m.arena.writeByte(scratch, 0);
    m.interpret(`${scratch} 15 (BLOCK-READ)`);
    expect(m.arena.readByte(scratch)).toBe(2);
  });

  it('(BLOCK-READ) throws on a block number at or past the 16-block capacity', () => {
    const m = new Machine();
    const scratch = scratchBuf(m);
    expect(() => m.interpret(`${scratch} 16 (BLOCK-READ)`)).toThrow(/block 16 out of range \(0\.\.15\)/);
  });

  it('(BLOCK-WRITE) throws on a negative block number', () => {
    const m = new Machine();
    const scratch = scratchBuf(m);
    expect(() => m.interpret(`${scratch} -1 (BLOCK-WRITE)`)).toThrow(/block -1 out of range \(0\.\.15\)/);
  });

  it('a project SAVE/RESTORE round-trips BLKS content like any other bank', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    const scratch1 = scratchBuf(m1);
    for (let i = 0; i < BLOCK_SIZE; i++) {
      m1.arena.writeByte(scratch1 + i, (i * 7) & 0xff);
    }
    m1.interpret(`${scratch1} 2 (BLOCK-WRITE)`);
    m1.interpret('PROJECT BLKPROJ');
    m1.interpret('SAVE');

    // Asset basename is the bank's name (EDITOR), not its tag (BLKS) —
    // storage.ts's own SAVE writes `${bank.name}.${ext}`.
    expect(hal.readFile('/PROJECTS/BLKPROJ/EDITOR.BLK')).toBeDefined();

    const m2 = new Machine({ storageHal: hal });
    m2.interpret('RESTORE BLKPROJ');
    const blks2 = m2.banks.requireBank('BLKS');
    for (let i = 0; i < BLOCK_SIZE; i++) {
      expect(m2.arena.readByte(blks2.base + 2 * BLOCK_SIZE + i)).toBe((i * 7) & 0xff);
    }
  });
});
