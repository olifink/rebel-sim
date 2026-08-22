import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { StorageHal } from './storage.js';
import { roundToSizeClass } from './banks.js';

// DICT boots at 65536 (repl.ts's DICT_BANK_SIZE); resizing to 70000
// rounds up to the next power-of-two class above it (M55's doubling
// ladder), not the requested value itself.
const DICT_DEFAULT_SIZE = 65536;
const DICT_RESIZED = roundToSizeClass(70000)!;

/** Same in-memory StorageHal shape as storage.test.ts's memoryHal() —
 * duplicated rather than shared/exported, matching that file's own
 * "small local test double" precedent. */
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

// M54 (Oliver's idea): BANK-RESIZE (146) edits a bank's own MMAP size
// field only — inert for the currently-running Machine — and a
// resize-triggered RESTORE (128) reboots into a fresh Machine
// (Inner's 'restart-project' StepSignal, mirroring COLD) that re-derives
// every bank's base from the saved sizes instead.
describe('BANK-RESIZE (146)', () => {
  it('rounds up to a size class and is visible immediately via a fresh BANK-SIZE query', () => {
    const m = new Machine();
    expect(m.banks.findBank('DICT')!.size).toBe(DICT_DEFAULT_SIZE);
    m.interpret('70000 BANK-RESIZE DICT');
    m.interpret('BANK-SIZE DICT');
    expect(m.stack.pop()).toBe(DICT_RESIZED);
  });

  it('does not move the bank’s own base', () => {
    const m = new Machine();
    const before = m.banks.findBank('DICT')!.base;
    m.interpret('70000 BANK-RESIZE DICT');
    expect(m.banks.findBank('DICT')!.base).toBe(before);
  });

  it('throws on an unknown name, same convention as BANK@/BANK-SIZE', () => {
    const m = new Machine();
    expect(() => m.interpret('4096 BANK-RESIZE NOPE')).toThrow('unknown bank: NOPE');
  });

  it('refuses to resize MMAP itself', () => {
    const m = new Machine();
    expect(() => m.interpret('8192 BANK-RESIZE MMAP')).toThrow(/MMAP itself cannot be resized/);
  });

  it('is inert for the currently-running Machine: DICT still overflows at its old boundary', () => {
    // dictionary.ts's HERE-overflow check reads Machine.dictBank, a
    // snapshot captured once at construction — BANK-RESIZE editing MMAP's
    // live slot doesn't touch that snapshot, so compiling into the "now
    // bigger" DICT still throws at the size the Machine actually booted
    // with, proving the resize took no immediate effect.
    const m = new Machine();
    const dict = m.banks.findBank('DICT')!;
    m.interpret('70000 BANK-RESIZE DICT');
    m.sysvars.setHere(dict.base + dict.size - 2); // 2 bytes of real headroom left
    expect(() => m.interpret(': TOO-BIG 1 2 3 4 5 6 7 8 9 10 ;')).toThrow(/dictionary (overflow|full)|out of/i);
  });
});

describe('RESTORE (128) with no pending resize — unchanged in-place behavior', () => {
  it('restores in place, preserving live stack contents exactly (no restart triggered)', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.interpret(': FOO 42 ;');
    m1.interpret('11 22 33');
    m1.interpret('PROJECT PLAINPRJ');
    m1.interpret('SAVE');

    m1.beginLine('RESTORE PLAINPRJ');
    const status = m1.step(1000);

    expect(status).not.toBe('restart-project');
    expect(m1.stack.toArray()).toEqual([33, 22, 11]);
    m1.interpret('FOO');
    expect(m1.stack.pop()).toBe(42);
  });

  it('still throws "project not found" for a project that was never saved', () => {
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret('RESTORE GHOST')).toThrow(/not found/);
  });
});

describe('resize-triggered restart (Inner’s ‘restart-project’ StepSignal, M54)', () => {
  it('RESTORE reports ‘restart-project’ once a resize was SAVEd, and never touches the live Machine', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.interpret('70000 BANK-RESIZE DICT');
    m1.interpret('PROJECT RESIZEBK');
    m1.interpret('SAVE');

    const dictBefore = m1.banks.findBank('DICT')!;
    m1.beginLine('RESTORE RESIZEBK');
    const status = m1.step(1000);

    expect(status).toBe('restart-project');
    expect(m1.pendingRestartProject()).toBe('RESIZEBK');
    // The live Machine itself is untouched — same bank table as before
    // the RESTORE attempt, no in-place patching happened.
    expect(m1.banks.findBank('DICT')).toEqual(dictBefore);
  });

  it('a fresh Machine booted with bootProject re-derives the resized bank at the new size', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.interpret(': FOO 42 ;');
    m1.interpret('70000 BANK-RESIZE DICT');
    m1.interpret('PROJECT RESIZEBK');
    m1.interpret('SAVE');
    m1.beginLine('RESTORE RESIZEBK');
    m1.step(1000);
    const project = m1.pendingRestartProject()!;

    const m2 = new Machine({ storageHal: hal, bootProject: project });

    expect(m2.banks.findBank('DICT')!.size).toBe(DICT_RESIZED);
    // Content restored: FOO, defined before the resize, still works.
    m2.interpret('FOO');
    expect(m2.stack.pop()).toBe(42);
    // And the resize now actually holds: compiling well past the old
    // (64 KiB) boundary no longer overflows.
    expect(() => m2.interpret(': BIGGER 1 2 3 ;')).not.toThrow();
  });

  it('shifts every later bank’s base by the grown amount, same bump-allocator order as a fresh boot', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    const dstkBefore = m1.banks.findBank('DSTK')!;
    m1.interpret('70000 BANK-RESIZE DICT');
    m1.interpret('PROJECT RESIZEBK');
    m1.interpret('SAVE');
    m1.beginLine('RESTORE RESIZEBK');
    m1.step(1000);

    const m2 = new Machine({ storageHal: hal, bootProject: m1.pendingRestartProject() });
    const dstkAfter = m2.banks.findBank('DSTK')!;

    expect(dstkAfter.base).toBe(dstkBefore.base + (DICT_RESIZED - DICT_DEFAULT_SIZE));
  });

  it('clears the data/return stacks across the restart, even though only DICT (not DSTK) was resized', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.interpret('11 22 33'); // real, live stack contents at SAVE time
    m1.interpret('70000 BANK-RESIZE DICT');
    m1.interpret('PROJECT RESIZEBK');
    m1.interpret('SAVE');
    m1.beginLine('RESTORE RESIZEBK');
    m1.step(1000);

    const m2 = new Machine({ storageHal: hal, bootProject: m1.pendingRestartProject() });

    expect(m2.stack.toArray()).toEqual([]);
    expect(m2.rstack.toArray()).toEqual([]);
  });

  it('a dynamic CREATE-BANKd bank survives the restart too, at a freshly-placed base', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.interpret('70000 BANK-RESIZE DICT');
    m1.interpret('64 CREATE-BANK DATA');
    const extraAddr = m1.stack.pop();
    m1.arena.writeByte(extraAddr, 77);
    const extraName = m1.banks.getAllBanks().find((b) => b.base === extraAddr)!.name;
    m1.interpret('PROJECT RESIZEBK');
    m1.interpret('SAVE');
    m1.beginLine('RESTORE RESIZEBK');
    m1.step(1000);

    const m2 = new Machine({ storageHal: hal, bootProject: m1.pendingRestartProject() });
    const extra = m2.banks.findBankByName(extraName);

    expect(extra).toBeDefined();
    expect(m2.arena.readByte(extra!.base)).toBe(77);
  });

  it('a bootProject with nothing actually saved boots exactly like an empty Machine', () => {
    const m = new Machine({ storageHal: memoryHal(), bootProject: 'NOSAVE' });
    expect(m.banks.findBank('DICT')!.size).toBe(DICT_DEFAULT_SIZE);
    m.interpret('1 2 +');
    expect(m.stack.pop()).toBe(3);
  });
});
