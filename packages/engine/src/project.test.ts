import { describe, expect, it, vi } from 'vitest';
import { Machine } from './repl.js';
import { StorageHal } from './storage.js';
import { ScreenHal } from './screen.js';
import { listDictionaryEntries } from './dictionary.js';

/** A real (not no-op) in-memory StorageHal — same role as
 * storage.test.ts's memoryHal(). Synchronous (M33: StorageHal dropped
 * Promises when the real backend moved from OPFS to localStorage). */
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

describe('PROJECT / SAVE / RESTORE (spec/01-HAL.md §6, M29; synchronous primitives since M33)', () => {
  it('PROJECT sets the current project name sysvar', () => {
    const m = new Machine({ storageHal: memoryHal() });
    m.interpret('PROJECT MYPROJ');
    expect(m.sysvars.getProjectName()).toBe('MYPROJ');
  });

  it('SAVE with no project name set throws a clear error, and the REPL keeps working afterward', () => {
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret('SAVE')).toThrow(/no project name set/);
    // Not left stuck — a following line still works.
    m.interpret('2 3 +');
    expect(m.stack.toArray()).toEqual([5]);
  });

  it('SAVE persists every bank synchronously, within a single interpret() call', () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.interpret('PROJECT RNDTRIP SAVE'); // PROJECT-NAME is 8 chars max

    const written = hal.readFile('/PROJECTS/RNDTRIP/MMAP.MAP');
    expect(written).toBeDefined();
  });

  it('RESTORE loads a previously-saved project into a fresh Machine, dictionary and all', () => {
    const hal = memoryHal();

    const m1 = new Machine({ storageHal: hal });
    m1.interpret(': DOUBLE DUP + ;');
    m1.interpret('PROJECT RTPROJ SAVE');

    const m2 = new Machine({ storageHal: hal });
    m2.interpret('RESTORE RTPROJ');

    // RESTORE sets PROJECT-NAME as a side effect.
    expect(m2.sysvars.getProjectName()).toBe('RTPROJ');

    m2.interpret('21 DOUBLE');
    expect(m2.stack.pop()).toBe(42);
  });

  it('RESTORE on a project that was never saved throws a clear error, not a silent no-op', () => {
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret('RESTORE NOSUCHPRJ')).toThrow(/project 'NOSUCHPRJ' not found/);
    // Not left stuck — a following line still works.
    m.interpret('4 5 +');
    expect(m.stack.toArray()).toEqual([9]);
  });

  it('RESTORE repaints the screen from the restored CHAR bank (redrawAll actually fires)', () => {
    const hal = memoryHal();

    const m1 = new Machine({ storageHal: hal });
    m1.interpret('72 EMIT'); // 'H' at (0,0)
    m1.interpret('PROJECT SCRNPROJ SAVE');

    const screenHal: ScreenHal & { blitGlyph: ReturnType<typeof vi.fn> } = {
      blitGlyph: vi.fn(),
      clearScreen: vi.fn(),
      drawPixel: vi.fn(),
      readPixel: vi.fn(() => -1),
    };
    const m2 = new Machine({ storageHal: hal, screenHal });
    screenHal.blitGlyph.mockClear();
    m2.interpret('RESTORE SCRNPROJ');

    expect(m2.screen.readRowText(0).trimStart()[0]).toBe('H');
    // Not just that CHAR content matches — that redrawAll() genuinely
    // repainted the (now-stale) framebuffer through the HAL, since
    // RESTORE overwrote CHAR bytes directly, bypassing writeChar()'s
    // usual write-through.
    expect(screenHal.blitGlyph).toHaveBeenCalledWith(0, 0, 72, expect.anything(), expect.anything());
  });

  it('PAL and ATTR round-trip through SAVE/RESTORE like any other bank (spec/02-MEMORY-MODEL.md §4.6)', () => {
    const hal = memoryHal();

    const m1 = new Machine({ storageHal: hal });
    m1.screen.setPaletteBase(m1.banks.findBank('PAL')!.base);
    m1.interpret('4 INK 0 PAPER 65 EMIT'); // green (4) on black (0), ATTR = 0x40
    m1.interpret('PROJECT PALPROJ SAVE');

    const m2 = new Machine({ storageHal: hal });
    m2.interpret('RESTORE PALPROJ');

    const attrBank = m2.banks.findBank('ATTR')!;
    const palBank = m2.banks.findBank('PAL')!;
    expect(m2.arena.readByte(attrBank.base)).toBe(0x40);
    expect(m2.arena.readCell(palBank.base + 4 * 4)).toBe(0x00ff00); // slot 4 (green) intact
  });

  it('a storage failure surfaces through interpret() like any other line error, not silently', () => {
    const brokenHal: StorageHal = {
      ensureDir(): void {},
      listFiles(): string[] {
        return [];
      },
      listDirs(): string[] {
        return [];
      },
      readFile(): Uint8Array | undefined {
        return undefined;
      },
      writeFile(): void {
        throw new Error('disk is full');
      },
    };
    const m = new Machine({ storageHal: brokenHal });
    expect(() => m.interpret('PROJECT BROKEN SAVE')).toThrow(/disk is full/);
  });

  it('SAVE takes no name-parsing argument, so it is fully usable compiled or via EXECUTE (M33)', () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.interpret('PROJECT CDPROJ');
    // Real primitive now that storage is synchronous — no more
    // outer-loop-only special syntax, so compiling a call to SAVE works
    // exactly like compiling a call to any other word (SAVE itself
    // parses no further input, unlike PROJECT/RESTORE/BSAVE/BLOAD below,
    // so it has none of their shared "only resolves its argument when
    // interpreted directly" caveat).
    expect(() => m.interpret(': BACKUP SAVE ;')).not.toThrow();
    m.interpret('BACKUP');
    expect(hal.readFile('/PROJECTS/CDPROJ/MMAP.MAP')).toBeDefined();

    // Also reachable via ' / EXECUTE now, proving it's a genuine
    // dictionary entry, not special outer-loop syntax `'` could never
    // resolve before M33.
    m.interpret("' SAVE EXECUTE");
  });

  it('PROJECT and RESTORE are now genuine dictionary entries (found by tick, listed by listDictionaryEntries) — M33', () => {
    // PROJECT/RESTORE still consume their name via nextInputToken(), the
    // same "resolves the raw text immediately following it in the
    // *currently interpreted* line" shape BANK@/CREATE-BANK/tick already
    // have — that only behaves sensibly typed directly (proven by the
    // tests above/below), not compiled with a following literal (the
    // compiler would try to resolve that literal as a word of its own
    // first). What genuinely changed at M33 isn't that shape — it's that
    // these are dictionary entries at all now: findable by name and
    // listed, HIDE/FORGET-able, unlike the old special outer-loop syntax
    // `'`/WORDS could never see (repl.ts's own former rejection test for
    // this, now flipped, is exactly what motivated this test).
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret("' PROJECT DROP")).not.toThrow();
    expect(() => m.interpret("' RESTORE DROP")).not.toThrow();
    const names = listDictionaryEntries(m).map((e) => e.name);
    expect(names).toContain('PROJECT');
    expect(names).toContain('RESTORE');
  });
});

describe('BSAVE / BLOAD (DEVELOPING.md\'s storage section, M33)', () => {
  it('BSAVE with no project name set throws a clear error', () => {
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret('BSAVE DATA')).toThrow(/no project name set/);
  });

  it('BSAVE writes only the named bank, not the whole project', () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.interpret('PROJECT ONEBANK');
    m.interpret('BSAVE DICT');

    // DICT is a boot-time bank created with no explicit name
    // (repl.ts's constructor), so its real .name is an auto-generated
    // serial, not the literal tag "DICT" — the asset filename is keyed
    // by name, not tag (storage.ts's own contract), so resolve the
    // actual bank rather than assume the two coincide.
    const dictBank = m.banks.requireBank('DICT');
    expect(hal.readFile(`/PROJECTS/ONEBANK/${dictBank.name}.DCT`)).toBeDefined();
    expect(hal.readFile('/PROJECTS/ONEBANK/MMAP.MAP')).toBeUndefined();
  });

  it('BSAVE throws for an unknown bank tag', () => {
    const m = new Machine({ storageHal: memoryHal() });
    m.interpret('PROJECT P');
    expect(() => m.interpret('BSAVE NOSUCH')).toThrow(/not found/);
  });

  it('BLOAD refreshes an existing bank in place from a previous BSAVE', () => {
    const hal = memoryHal();

    // CREATE-BANK has no name argument (only size + tag) — its
    // auto-generated serial name is deterministic per otherwise-fresh
    // Machine (mmap.ts's own header counter, same assumption
    // storage.test.ts's MMAP-restore test already relies on), so m1's
    // and m2's first CREATE-BANK call each produce the same name and
    // BLOAD can find m1's saved file by tag alone.
    const m1 = new Machine({ storageHal: hal });
    m1.interpret('64 CREATE-BANK DATA');
    const addr1 = m1.stack.pop();
    m1.arena.writeByte(addr1, 99);
    m1.interpret('PROJECT SHAREDPRJ');
    m1.interpret('BSAVE DATA');

    const m2 = new Machine({ storageHal: hal });
    m2.interpret('64 CREATE-BANK DATA'); // fresh/zeroed content
    const addr2 = m2.stack.pop();
    expect(m2.arena.readByte(addr2)).toBe(0);
    m2.interpret('PROJECT SHAREDPRJ');
    m2.interpret('BLOAD DATA');
    expect(m2.arena.readByte(addr2)).toBe(99);
  });

  it('BLOAD throws a clear error when nothing was ever BSAVEd for that bank', () => {
    const m = new Machine({ storageHal: memoryHal() });
    m.interpret('PROJECT P');
    expect(() => m.interpret('BLOAD DICT')).toThrow(/no saved asset/);
  });

  it('BSAVE and BLOAD are now genuine dictionary entries (found by tick, listed by listDictionaryEntries) — M33', () => {
    // Same shared "parses its tag argument from the currently-
    // interpreted line, not a following compiled literal" shape as
    // PROJECT/RESTORE above (and BANK@/CREATE-BANK/tick before them) —
    // proven working when interpreted directly by the tests above. What
    // this test actually checks is the real, new capability: existing
    // as dictionary entries at all, where before M33 there was no
    // BSAVE/BLOAD mechanism of any shape.
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret("' BSAVE DROP")).not.toThrow();
    expect(() => m.interpret("' BLOAD DROP")).not.toThrow();
    const names = listDictionaryEntries(m).map((e) => e.name);
    expect(names).toContain('BSAVE');
    expect(names).toContain('BLOAD');
  });
});

describe('PROJECTS (rebel-opcodes.json 145, M51)', () => {
  function screenText(m: Machine): string {
    const rows: string[] = [];
    for (let r = 0; r < m.screen.rows; r++) {
      rows.push(m.screen.readRowText(r));
    }
    return rows.join('');
  }

  it('lists every saved project name, space separated', () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.interpret('PROJECT ALPHA');
    m.interpret('SAVE');
    m.interpret('PROJECT BETA');
    m.interpret('SAVE');

    m.interpret('PROJECTS');
    const listed = screenText(m);
    expect(listed).toContain('ALPHA');
    expect(listed).toContain('BETA');
  });

  it('prints nothing when no project has ever been saved', () => {
    const m = new Machine({ storageHal: memoryHal() });
    m.interpret('PROJECTS');
    expect(screenText(m).trim()).toBe('');
  });

  it('is a real dictionary entry, found by tick', () => {
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret("' PROJECTS DROP")).not.toThrow();
  });
});
