import { describe, expect, it, vi } from 'vitest';
import { Machine } from './repl.js';
import { StorageHal } from './storage.js';
import { ScreenHal } from './screen.js';
import { listDictionaryEntries } from './dictionary.js';
import { BankFlagRemoved } from './banks.js';

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
    m1.interpret('4 INK ! 0 PAPER ! 65 EMIT'); // green (4) on black (0), ATTR = 0x40
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
    // parses no further input, unlike PROJECT/RESTORE/BANK-SAVE/BANK-LOAD below,
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
    // *currently interpreted* line" shape BANK@/BANK-CREATE/tick already
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

/** Writes `texts` into a fresh host-created scratch bank and pushes
 * each one's `addr len` — name-on-the-stack arguments for the
 * parenthesized bank words, without S" (one shared PAD, so two S"s on
 * one line would overwrite each other). */
function pushStrings(m: Machine, ...texts: string[]): void {
  const scratch = m.banks.createBank('DATA', 256);
  let at = scratch.base;
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) m.arena.writeByte(at + i, text.charCodeAt(i));
    m.stack.push(at);
    m.stack.push(text.length);
    at += text.length;
  }
}

describe('BANK-SAVE / BANK-LOAD (M33 as BSAVE/BLOAD; renamed and resolved by name, M73, spec/04-FORTH-CORE.md §6.14)', () => {
  it('BANK-SAVE with no project name set throws a clear error', () => {
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret('BANK-SAVE DICT')).toThrow(/no project name set/);
  });

  it('BANK-SAVE writes only the named bank, not the whole project', () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.interpret('PROJECT ONEBANK');
    m.interpret('BANK-SAVE dict'); // names fold to upper case
    expect(hal.readFile('/PROJECTS/ONEBANK/DICT.DCT')).toBeDefined();
    expect(hal.readFile('/PROJECTS/ONEBANK/MMAP.MAP')).toBeUndefined();
  });

  it('BANK-SAVE resolves by name, not tag', () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.banks.createBank('DATA', 64, 'LEVEL1');
    m.interpret('PROJECT P');
    expect(() => m.interpret('BANK-SAVE DATA')).toThrow(/unknown bank: DATA/);
    m.interpret('BANK-SAVE LEVEL1');
    expect(hal.readFile('/PROJECTS/P/LEVEL1.DAT')).toBeDefined();
  });

  it('BANK-LOAD refreshes a resident bank in place, zero-padding a short payload', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    const a = m1.banks.createBank('DATA', 64, 'SHARED');
    m1.arena.writeByte(a.base, 99);
    m1.interpret('PROJECT SHAREDPRJ');
    m1.interpret('BANK-SAVE SHARED');

    const m2 = new Machine({ storageHal: hal });
    const b = m2.banks.createBank('DATA', 64, 'SHARED');
    m2.arena.writeByte(b.base + 1, 77); // stale byte the load must clear
    m2.interpret('PROJECT SHAREDPRJ');
    m2.interpret('BANK-LOAD SHARED');
    expect(m2.arena.readByte(b.base)).toBe(99);
    expect(m2.arena.readByte(b.base + 1)).toBe(0);
  });

  it('BANK-LOAD creates the bank, tag from the file extension, when it is not resident', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    const a = m1.banks.createBank('DATA', 64, 'LEVEL1');
    m1.arena.writeByte(a.base + 3, 42);
    m1.interpret('PROJECT GAME');
    m1.interpret('BANK-SAVE LEVEL1');

    const m2 = new Machine({ storageHal: hal });
    m2.interpret('PROJECT GAME');
    m2.interpret('BANK-LOAD level1');
    const loaded = m2.banks.findBankByName('LEVEL1')!;
    expect(loaded.tag).toBe('DATA');
    expect(m2.arena.readByte(loaded.base + 3)).toBe(42);
  });

  it('BANK-LOAD throws a clear error when the project has no such asset', () => {
    const m = new Machine({ storageHal: memoryHal() });
    m.interpret('PROJECT P');
    expect(() => m.interpret('BANK-LOAD DICT')).toThrow(/no loadable asset DICT/);
  });

  it('the old names CREATE-BANK, BSAVE and BLOAD are gone', () => {
    const names = listDictionaryEntries(new Machine()).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['BANK-CREATE', 'BANK-SAVE', 'BANK-LOAD']));
    for (const old of ['CREATE-BANK', 'BSAVE', 'BLOAD']) {
      expect(names).not.toContain(old);
    }
  });
});

describe('(BANK-CREATE) / (BANK-SAVE) / (BANK-LOAD) — name on the stack, 0 on failure (M73, spec/04-FORTH-CORE.md §6.14)', () => {
  it('(BANK-CREATE) creates a named, zeroed bank and returns its MMAP slot', () => {
    const m = new Machine({ storageHal: memoryHal() });
    // Scribble where the next bank will land, to prove it gets zeroed.
    const top = Math.max(...m.banks.getAllBanks().map((b) => b.base + b.size));
    pushStrings(m, 'sprites', 'sprt');
    const scratchEnd = Math.max(...m.banks.getAllBanks().map((b) => b.base + b.size));
    expect(scratchEnd).toBeGreaterThan(top);
    m.arena.writeByte(scratchEnd, 0xaa);
    m.stack.push(100);
    m.interpret('(BANK-CREATE)');
    const slot = m.stack.pop();
    const bank = m.banks.findBankByName('SPRITES')!;
    expect(slot).toBe(m.banks.slotAddress('SPRITES'));
    expect(bank.tag).toBe('SPRT');
    expect(m.arena.readCell(slot + 12)).toBe(bank.base);
    expect(m.arena.readCell(slot + 16)).toBe(2048);
    expect(m.arena.readByte(bank.base)).toBe(0);
  });

  it('(BANK-CREATE) with an empty name assigns the next serial name', () => {
    const m = new Machine();
    pushStrings(m, '', 'DATA');
    m.stack.push(64);
    m.interpret('(BANK-CREATE)');
    const slot = m.stack.pop();
    expect(slot).not.toBe(0);
    const name = m.banks.getAllBanks().find((b) => m.banks.slotAddress(b.name) === slot)!.name;
    expect(name).toMatch(/^\d{8}$/);
  });

  it.each([
    ['a duplicate name', 'DICT', 'DATA', 64],
    ['a name over 8 characters', 'NINECHARS', 'DATA', 64],
    ['an empty tag', 'OKNAME', '', 64],
    ['a tag over 4 characters', 'OKNAME', 'TOOLONG', 64],
    ['size 0', 'OKNAME', 'DATA', 0],
    ['a size over the largest class', 'OKNAME', 'DATA', 0x7fffffff],
  ])('(BANK-CREATE) returns 0 and changes nothing for %s', (_why, name, tag, size) => {
    const m = new Machine();
    pushStrings(m, name, tag);
    const before = m.banks.getAllBanks().length;
    m.stack.push(size);
    m.interpret('(BANK-CREATE)');
    expect(m.stack.toArray()).toEqual([0]);
    expect(m.banks.getAllBanks().length).toBe(before);
  });

  it('(BANK-SAVE) / (BANK-LOAD) round-trip and report failure as FALSE / 0', () => {
    const m = new Machine({ storageHal: memoryHal() });
    const call = (word: string, name: string): number => {
      pushStrings(m, name);
      m.interpret(word);
      return m.stack.pop();
    };

    expect(call('(BANK-SAVE)', 'CHAR')).toBe(0); // no project open yet
    m.interpret('PROJECT RT');
    expect(call('(BANK-SAVE)', 'NOSUCH')).toBe(0);
    expect(call('(BANK-SAVE)', 'char')).toBe(-1);
    expect(call('(BANK-LOAD)', 'CHAR')).toBe(m.banks.slotAddress('CHAR'));
    expect(call('(BANK-LOAD)', 'NOSUCH')).toBe(0);
    expect(m.stack.toArray()).toEqual([]);
  });
});

/** Sets REMOVED (flags bit 5) on a bank's MMAP slot directly — what
 * system.fth's (BANK-REMOVE) does, without needing a booted Machine. */
function markRemoved(m: Machine, name: string): void {
  const flags = m.banks.slotAddress(name)! + 20;
  m.arena.writeCell(flags, m.arena.readCell(flags) | BankFlagRemoved);
}

describe('REMOVED banks (M74, spec/02-MEMORY-MODEL.md §4.9, 01-HAL.md §6.3)', () => {
  it('a REMOVED bank is unchanged for the rest of the session', () => {
    const m = new Machine({ storageHal: memoryHal() });
    const bank = m.banks.createBank('DATA', 64, 'GONE');
    m.arena.writeByte(bank.base, 7);
    markRemoved(m, 'GONE');
    expect(m.banks.findBankByName('GONE')?.base).toBe(bank.base);
    m.interpret('BANK@ GONE');
    expect(m.stack.pop()).toBe(bank.base);
    expect(m.arena.readByte(bank.base)).toBe(7);
    expect(() => m.banks.createBank('DATA', 64, 'GONE')).toThrow(/already exists/);
  });

  it('SAVE skips a REMOVED bank and blanks its existing asset; BANK-SAVE refuses it', () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.banks.createBank('DATA', 64, 'GONE');
    m.interpret('PROJECT RMP');
    m.interpret('SAVE');
    expect(hal.readFile('/PROJECTS/RMP/GONE.DAT')!.length).toBeGreaterThan(0);

    markRemoved(m, 'GONE');
    m.interpret('SAVE');
    expect(hal.readFile('/PROJECTS/RMP/GONE.DAT')!.length).toBe(0);
    expect(() => m.interpret('BANK-SAVE GONE')).toThrow(/marked for removal/);
  });

  it('a later restore does not reconstruct it; its slot and name are free again', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.banks.createBank('DATA', 64, 'KEEP');
    m1.banks.createBank('DATA', 64, 'GONE');
    markRemoved(m1, 'GONE');
    m1.interpret('PROJECT RMP');
    m1.interpret('SAVE');

    const m2 = new Machine({ storageHal: hal });
    m2.interpret('RESTORE RMP');
    expect(m2.banks.findBankByName('KEEP')).toBeDefined();
    expect(m2.banks.findBankByName('GONE')).toBeUndefined();
    expect(() => m2.banks.createBank('DATA', 64, 'GONE')).not.toThrow();
  });

  it('a project saved without its MMAP cannot bring a REMOVED bank back either (blanked asset)', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.banks.createBank('DATA', 64, 'GONE');
    m1.interpret('PROJECT RMP');
    m1.interpret('SAVE'); // a real asset first ...
    markRemoved(m1, 'GONE');
    m1.interpret('SAVE'); // ... then blanked

    // Only the blanked asset: with no MMAP.MAP every file takes the
    // fresh-create fallback, which can only be exercised on its own here.
    const noMmap = memoryHal();
    noMmap.writeFile('/PROJECTS/RMP/GONE.DAT', hal.readFile('/PROJECTS/RMP/GONE.DAT')!);
    const m2 = new Machine({ storageHal: noMmap });
    m2.storage.openProject('RMP');
    expect(m2.banks.findBankByName('GONE')).toBeUndefined();
  });

  it('a relayout load skips the asset of a slot the saved MMAP marks REMOVED', () => {
    const hal = memoryHal();
    const m1 = new Machine({ storageHal: hal });
    m1.banks.createBank('DATA', 64, 'GONE');
    m1.interpret('PROJECT RMP');
    m1.interpret('BANK-SAVE GONE'); // a live, non-blank asset
    markRemoved(m1, 'GONE');
    m1.interpret('BANK-SAVE MMAP'); // only the table records the removal

    const m2 = new Machine({ storageHal: hal });
    m2.storage.openProject('RMP', true); // skipLayoutRestore, as bootProject does
    expect(m2.banks.findBankByName('GONE')).toBeUndefined();
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
