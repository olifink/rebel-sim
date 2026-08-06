import { describe, expect, it, vi } from 'vitest';
import { Machine, StepStatus } from './repl.js';
import { StorageHal } from './storage.js';
import { ScreenHal } from './screen.js';

/** A real (not no-op) in-memory StorageHal — same role as
 * storage.test.ts's memoryHal(). */
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

/** Drives one line the same way app.ts's tick() loop does: keep
 * stepping, awaiting runPendingStorage() whenever step() pauses on
 * 'storage', until the session actually finishes. */
async function runLine(m: Machine, line: string): Promise<StepStatus> {
  m.beginLine(line);
  let status = m.step(1000);
  while (status === 'storage') {
    await m.runPendingStorage();
    status = m.step(1000);
  }
  return status;
}

describe('PROJECT / SAVE / RESTORE (spec/01-HAL.md §6, M29)', () => {
  it('PROJECT sets the current project name sysvar', async () => {
    const m = new Machine({ storageHal: memoryHal() });
    await runLine(m, 'PROJECT MYPROJ');
    expect(m.sysvars.getProjectName()).toBe('MYPROJ');
  });

  it('SAVE with no project name set throws a clear error, and the REPL keeps working afterward', async () => {
    const m = new Machine({ storageHal: memoryHal() });
    await expect(runLine(m, 'SAVE')).rejects.toThrow(/no project name set/);
    // Not left stuck — a following line still works.
    m.interpret('2 3 +');
    expect(m.stack.toArray()).toEqual([5]);
  });

  it('SAVE pauses step() on \'storage\', persists every bank, and resumes idle', async () => {
    const hal = memoryHal();
    const m = new Machine({ storageHal: hal });
    m.beginLine('PROJECT RNDTRIP SAVE'); // PROJECT-NAME is 8 chars max
    let status = m.step(1000);
    expect(status).toBe('storage'); // paused right after SAVE, before the real I/O ran
    await m.runPendingStorage();
    status = m.step(1000);
    expect(status).toBe('idle');

    const written = await hal.readFile('/PROJECTS/RNDTRIP/MMAP.MAP');
    expect(written).toBeDefined();
  });

  it('RESTORE loads a previously-saved project into a fresh Machine, dictionary and all', async () => {
    const hal = memoryHal();

    const m1 = new Machine({ storageHal: hal });
    await runLine(m1, ': DOUBLE DUP + ;');
    await runLine(m1, 'PROJECT RTPROJ SAVE');

    const m2 = new Machine({ storageHal: hal });
    await runLine(m2, 'RESTORE RTPROJ');

    // RESTORE sets PROJECT-NAME as a side effect.
    expect(m2.sysvars.getProjectName()).toBe('RTPROJ');

    m2.interpret('21 DOUBLE');
    expect(m2.stack.pop()).toBe(42);
  });

  it('RESTORE on a project that was never saved throws a clear error, not a silent no-op', async () => {
    const m = new Machine({ storageHal: memoryHal() });
    await expect(runLine(m, 'RESTORE NOSUCHPRJ')).rejects.toThrow(/project 'NOSUCHPRJ' not found/);
    // Not left stuck — a following line still works.
    m.interpret('4 5 +');
    expect(m.stack.toArray()).toEqual([9]);
  });

  it('RESTORE repaints the screen from the restored CHAR bank (redrawAll actually fires)', async () => {
    const hal = memoryHal();

    const m1 = new Machine({ storageHal: hal });
    m1.interpret('72 EMIT'); // 'H' at (0,0)
    await runLine(m1, 'PROJECT SCRNPROJ SAVE');

    const screenHal: ScreenHal & { blitGlyph: ReturnType<typeof vi.fn> } = {
      blitGlyph: vi.fn(),
      clearScreen: vi.fn(),
    };
    const m2 = new Machine({ storageHal: hal, screenHal });
    screenHal.blitGlyph.mockClear();
    await runLine(m2, 'RESTORE SCRNPROJ');

    expect(m2.screen.readRowText(0).trimStart()[0]).toBe('H');
    // Not just that CHAR content matches — that redrawAll() genuinely
    // repainted the (now-stale) framebuffer through the HAL, since
    // RESTORE overwrote CHAR bytes directly, bypassing writeChar()'s
    // usual write-through.
    expect(screenHal.blitGlyph).toHaveBeenCalledWith(0, 0, 72, expect.anything(), expect.anything());
  });

  it('a storage failure surfaces through step() like any other line error, not silently', async () => {
    const brokenHal: StorageHal = {
      async ensureDir(): Promise<void> {},
      async listFiles(): Promise<string[]> {
        return [];
      },
      async readFile(): Promise<Uint8Array | undefined> {
        return undefined;
      },
      async writeFile(): Promise<void> {
        throw new Error('disk is full');
      },
    };
    const m = new Machine({ storageHal: brokenHal });
    m.beginLine('PROJECT BROKEN SAVE');
    expect(m.step(1000)).toBe('storage');
    await m.runPendingStorage(); // never rejects — captures the error instead
    expect(() => m.step(1000)).toThrow(/disk is full/);
  });

  it('PROJECT/SAVE/RESTORE are rejected inside a colon-definition, like any non-dictionary syntax', () => {
    const m = new Machine({ storageHal: memoryHal() });
    expect(() => m.interpret(': BAD PROJECT FOO ;')).toThrow(/unrecognized word/);
    const m2 = new Machine({ storageHal: memoryHal() });
    expect(() => m2.interpret(': BAD2 SAVE ;')).toThrow(/unrecognized word/);
  });
});
