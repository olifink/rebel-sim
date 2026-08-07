/**
 * The storage module: Rebel-ROM's real **projects/carts** model
 * (docs/STORAGE.md, Phase 9 — done, hardware-verified), not the older
 * raw-numbered-block framing FORTH-ARCHITECTURE.md's own §7 explicitly
 * says that design superseded. Two fixed, flat directories:
 *
 *   /PROJECTS/<name>/   one folder per project, one file per bank asset
 *   /CARTS/<name>.CRT   one flat baked binary per cart
 *
 * Each asset file's extension declares its bank tag (`.DAT` <-> `DATA`,
 * etc. — docs/STORAGE.md §4's tag<->extension table), and its basename
 * *is* the bank's own `name` field (§4a) — there's no separate mapping
 * to keep in sync between "what a bank is called" and "what file
 * represents it." A 6-byte header (magic 'R','A' + the 4-char tag,
 * docs/STORAGE.md §8) precedes the payload in every asset file, as a
 * lightweight sanity net; a short/missing read aborts loading that file,
 * but a magic/tag mismatch is a future diagnostic hook only, not a load
 * failure — the extension stays the primary signal.
 *
 * Persistence happens at project open/close time, not per Forth memory
 * access (FORTH-ARCHITECTURE.md §7's porting note for `hal_block_read`/
 * `write`) — Forth-visible words only ever read/write a resident bank
 * directly. This class is plain synchronous TypeScript, same as every
 * other engine module — matching real hardware's own storage access
 * (Rebel-ROM's `CStorageModule`, bare-metal blocking FAT/USB I/O, no
 * async concept at all) rather than the Promise-based shape an earlier
 * OPFS-backed `StorageHal` once forced onto this class and, from there,
 * into the engine's core execution model (`repl.ts` used to carry a
 * dedicated `'storage'` `StepStatus` just so a running Forth line could
 * suspend itself around a real disk write). `PROJECT`/`SAVE`/`RESTORE`/
 * `BSAVE`/`BLOAD` are ordinary `primitives.ts` dispatch cases now,
 * calling straight into this class like any other primitive calls into
 * `banks`/`screen`/`sysvars` — see `DEVELOPING.md`'s storage section.
 *
 * Automatic per-write DIRTY-flag tracking (docs/STORAGE.md §6 — "closing
 * a project writes back only banks marked dirty") is deliberately not
 * implemented: nothing in Rebel-Sim yet writes into a generic project
 * asset bank at the Forth level (no Phase-11-equivalent block/editor
 * words exist), so there's no real write path to hook. `saveAsset()`
 * always persists whatever bank you hand it — add real dirty tracking
 * once something actually mutates a resident asset bank (same deferral
 * shape as M3's `hal_draw_*`).
 */

import { Arena } from './arena.js';
import { Bank, BankTable, roundToSizeClass } from './banks.js';
import { MMAP_TAG } from './mmap.js';

const PROJECTS_ROOT = '/PROJECTS';
const CARTS_ROOT = '/CARTS';

const ASSET_MAGIC_0 = 'R'.charCodeAt(0);
const ASSET_MAGIC_1 = 'A'.charCodeAt(0);
const ASSET_HEADER_SIZE = 6; // magic(2) + tag(4)

// spec/01-HAL.md §6.3's full tag<->extension table — every bank tag
// spec/02-MEMORY-MODEL.md §4.6 defines gets an entry, not just the
// "ordinary content asset" ones (SCRN/FONT/SPRT/DICT/DATA): CHAR/KMAP/
// SYSV/DSTK/RSTK are live session state, and MMAP/WORK are included
// for uniformity of the mechanism (§6.3's own reasoning) even though
// their content isn't normally meaningful to reload on its own — MMAP
// specifically is what makes the two-phase restore below possible at
// all (§6.3.1). WORK (M31) replaces the earlier separate TIB/PAD
// tags — both were small, transient, per-line scratch text, now one
// bank at fixed sub-offsets instead of two independently-rounded ones.
const TAG_TO_EXTENSION: Readonly<Record<string, string>> = {
  SCRN: 'SCR',
  FONT: 'FNT',
  SPRT: 'SPR',
  DICT: 'DCT',
  DATA: 'DAT',
  CHAR: 'CHR',
  KMAP: 'KMP',
  SYSV: 'SYS',
  DSTK: 'DST',
  RSTK: 'RST',
  MMAP: 'MAP',
  WORK: 'WRK',
};
const EXTENSION_TO_TAG: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TAG_TO_EXTENSION).map(([tag, ext]) => [ext, tag]),
);

/** Host-supplied file I/O (localStorage in Rebel-Sim's case,
 * `local-storage-storage-hal.ts` — synchronous, same reasoning as this
 * whole module's own header comment above) — the engine has zero direct
 * filesystem/DOM dependencies, same boundary shape as ScreenHal/keyboard
 * host wiring. Paths are POSIX-style, always absolute, e.g.
 * `/PROJECTS/REBELDEF/00000000.DAT`. Synchronous throughout, matching
 * real hardware's own blocking storage access — a host implementation is
 * free to throw synchronously (a real quota-exceeded error, say) and let
 * it propagate like any other primitive's error. */
export interface StorageHal {
  ensureDir(path: string): void;
  /** Filenames only (not subdirectories), empty array if the directory
   * doesn't exist. */
  listFiles(path: string): string[];
  /** Immediate subdirectory names only (not nested further, not files),
   * empty array if the directory doesn't exist — `listFiles`'s
   * counterpart, needed for e.g. listing every project under
   * `/PROJECTS/` without knowing any of their names ahead of time. */
  listDirs(path: string): string[];
  /** undefined if the file doesn't exist. */
  readFile(path: string): Uint8Array | undefined;
  writeFile(path: string, bytes: Uint8Array): void;
}

export const NULL_STORAGE_HAL: StorageHal = {
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
  writeFile(): void {},
};

export class Storage {
  constructor(
    private readonly arena: Arena,
    private readonly banks: BankTable,
    private readonly hal: StorageHal = NULL_STORAGE_HAL,
  ) {}

  private projectDir(projectName: string): string {
    return `${PROJECTS_ROOT}/${projectName}`;
  }

  private cartPath(cartName: string): string {
    return `${CARTS_ROOT}/${cartName}.CRT`;
  }

  /** Every project currently under `/PROJECTS/`, sorted — the UI-facing
   * "what's actually saved" question `openProject`/`saveAsset` alone
   * can't answer without already knowing a name to ask about. Read-only,
   * touches no arena/bank state (unlike `openProject`, which loads). */
  listProjects(): string[] {
    return this.hal.listDirs(PROJECTS_ROOT);
  }

  /** One project's saved banks, by tag/name/payload size — read-only,
   * same "introspect without loading" reasoning as `listProjects()`.
   * Mirrors `openProject()`'s own per-file tag/basename parsing exactly
   * (`DEVELOPING.md`'s storage section), but never touches the arena or
   * creates/overwrites a single bank; a file skipped there (unrecognized
   * extension, too short to hold the asset header) is skipped here too,
   * for the same reasons. */
  listProjectAssets(projectName: string): { tag: string; name: string; size: number }[] {
    const dir = this.projectDir(projectName);
    const assets: { tag: string; name: string; size: number }[] = [];
    for (const file of this.hal.listFiles(dir)) {
      const dot = file.lastIndexOf('.');
      if (dot < 0) continue;
      const tag = EXTENSION_TO_TAG[file.slice(dot + 1).toUpperCase()];
      if (!tag) continue;
      const bytes = this.hal.readFile(`${dir}/${file}`);
      if (!bytes || bytes.length < ASSET_HEADER_SIZE) continue;
      assets.push({ tag, name: file.slice(0, dot).toUpperCase(), size: bytes.length - ASSET_HEADER_SIZE });
    }
    return assets;
  }

  /** Every raw file currently saved under one project's directory,
   * filename and exact on-disk bytes (header included) — a faithful
   * copy for e.g. exporting/downloading a whole project, unlike
   * `listProjectAssets()`: nothing here is parsed or filtered by tag/
   * header validity, since the point is "what's actually in the
   * directory," not "what the engine would load as a bank." A file
   * `listFiles()` reports but that vanishes before its `readFile()`
   * call (a real race in a multi-writer environment, not something
   * this synchronous single-writer engine can hit itself) is silently
   * skipped rather than represented as a hole. */
  listProjectFiles(projectName: string): { filename: string; bytes: Uint8Array }[] {
    const dir = this.projectDir(projectName);
    const files: { filename: string; bytes: Uint8Array }[] = [];
    for (const filename of this.hal.listFiles(dir)) {
      const bytes = this.hal.readFile(`${dir}/${filename}`);
      if (bytes) {
        files.push({ filename, bytes });
      }
    }
    return files;
  }

  /** Scans /PROJECTS/<name>/ and loads every recognized asset file.
   * Two-phase whenever an MMAP.MAP asset is present (spec/01-HAL.md
   * §6.3.1 — MMAP is the arena's own bank table, so restoring it
   * *first* reconstructs the exact original layout, bases and all,
   * rather than a plausible-looking one re-derived from whichever
   * files happen to be present):
   *
   *   1. Layout restore: overwrite the live MMAP bank's raw bytes with
   *      the asset's payload. `MemoryMap` (mmap.ts) caches nothing —
   *      every subsequent lookup immediately reflects the restored
   *      table, so no separate bump-allocator-bypass primitive is
   *      needed. This also reactivates any extra (e.g. CREATE-BANK'd)
   *      banks the original project had at their exact recorded bases,
   *      content still pending until phase 2.
   *   2. Content restore: every other recognized file is matched by
   *      (tag, basename) against the just-restored table
   *      (`findBankByName`) and written directly into that bank's
   *      already-fixed location (zero-padded if short; skipped, not
   *      fatal, if too large for the recorded slot). A file with no
   *      match — no MMAP.MAP was present at all, or this file isn't
   *      covered by the one that was (an older or partial save) —
   *      falls back to creating a fresh bank, bump-allocated, sized
   *      from the payload: today's baseline behavior, unchanged.
   *
   * Files with an unrecognized extension, or a payload too large for
   * any size class in the fresh-create fallback, are skipped rather
   * than aborting the whole open (matches `LoadAssetFile`). Returns
   * every bank it created or restored, MMAP first when restored. */
  openProject(projectName: string): Bank[] {
    const dir = this.projectDir(projectName);
    const files = this.hal.listFiles(dir);
    const loaded: Bank[] = [];

    const mmapExt = TAG_TO_EXTENSION[MMAP_TAG];
    const mmapFile = files.find((f) => f.toUpperCase() === `${MMAP_TAG}.${mmapExt}`);
    const mmapBank = mmapFile ? this.banks.findBank(MMAP_TAG, MMAP_TAG) : undefined;
    let mmapRestored = false;

    if (mmapFile && mmapBank) {
      const bytes = this.hal.readFile(`${dir}/${mmapFile}`);
      if (bytes && bytes.length >= ASSET_HEADER_SIZE) {
        const payload = bytes.subarray(ASSET_HEADER_SIZE);
        if (payload.length <= mmapBank.size) {
          for (let i = 0; i < mmapBank.size; i++) {
            this.arena.writeByte(mmapBank.base + i, i < payload.length ? payload[i] : 0);
          }
          mmapRestored = true;
          loaded.push(mmapBank);
        }
      }
    }

    for (const file of files) {
      if (file === mmapFile) continue; // MMAP itself: handled above, phase 1

      const dot = file.lastIndexOf('.');
      if (dot < 0) continue;
      const tag = EXTENSION_TO_TAG[file.slice(dot + 1).toUpperCase()];
      if (!tag) continue; // unrecognized extension — not this module's concern

      const bytes = this.hal.readFile(`${dir}/${file}`);
      if (!bytes || bytes.length < ASSET_HEADER_SIZE) continue; // short/missing read aborts this file
      const payload = bytes.subarray(ASSET_HEADER_SIZE);
      const basename = file.slice(0, dot).toUpperCase();

      if (mmapRestored) {
        const bank = this.banks.findBankByName(basename);
        if (bank) {
          if (payload.length > bank.size) continue; // too large for the recorded slot — skip, not fatal
          for (let i = 0; i < bank.size; i++) {
            this.arena.writeByte(bank.base + i, i < payload.length ? payload[i] : 0);
          }
          loaded.push(bank);
          continue;
        }
        // No matching slot in the restored table (older/partial save) —
        // fall through to the fresh-create fallback below.
      }

      const size = roundToSizeClass(payload.length);
      if (size === undefined) continue; // larger than any size class — skip, don't crash
      const bank = this.banks.createBank(tag, size, basename);
      for (let i = 0; i < payload.length; i++) {
        this.arena.writeByte(bank.base + i, payload[i]);
      }
      loaded.push(bank);
    }

    return loaded;
  }

  /** Writes one bank out as a project asset file, creating the project
   * directory first if needed (docs/STORAGE.md §4/§4a) — unlike
   * openProject(), a missing directory here is not an error. The bank's
   * own `name` becomes the file's basename; `tag` maps to the
   * extension. */
  saveAsset(projectName: string, bank: Bank): void {
    const ext = TAG_TO_EXTENSION[bank.tag];
    if (!ext) {
      throw new Error(`no known asset file extension for bank tag ${bank.tag}`);
    }

    const dir = this.projectDir(projectName);
    this.hal.ensureDir(dir);

    const bytes = new Uint8Array(ASSET_HEADER_SIZE + bank.size);
    bytes[0] = ASSET_MAGIC_0;
    bytes[1] = ASSET_MAGIC_1;
    for (let i = 0; i < 4; i++) {
      bytes[2 + i] = bank.tag.charCodeAt(i) ?? 0;
    }
    for (let i = 0; i < bank.size; i++) {
      bytes[ASSET_HEADER_SIZE + i] = this.arena.readByte(bank.base + i);
    }

    this.hal.writeFile(`${dir}/${bank.name}.${ext}`, bytes);
  }

  /** Reads one bank's previously-saved asset file back into that bank's
   * own, already-existing memory region, in place — the single-bank
   * counterpart to `openProject()`'s whole-directory restore, for
   * `BLOAD` (`DEVELOPING.md` §8.6-adjacent storage section, M33). Unlike
   * `openProject()`'s phase-2 tolerance (silently skip a payload too
   * large for its recorded slot, among many files), a too-large payload
   * here throws — a single explicit named request deserves a clear
   * error over a silent partial load. Zero-pads if the saved payload is
   * shorter than the bank's current size. Returns `false`, changing
   * nothing, if no asset file exists yet for this bank in this project —
   * a `BLOAD` before any matching `BSAVE`, not treated as an error here
   * so the primitive calling this can phrase its own message. */
  loadAsset(projectName: string, bank: Bank): boolean {
    const ext = TAG_TO_EXTENSION[bank.tag];
    if (!ext) {
      throw new Error(`no known asset file extension for bank tag ${bank.tag}`);
    }
    const dir = this.projectDir(projectName);
    const bytes = this.hal.readFile(`${dir}/${bank.name}.${ext}`);
    if (!bytes || bytes.length < ASSET_HEADER_SIZE) {
      return false;
    }
    const payload = bytes.subarray(ASSET_HEADER_SIZE);
    if (payload.length > bank.size) {
      throw new Error(
        `saved asset for ${bank.tag}/${bank.name} is ${payload.length} bytes, too large for its ${bank.size}-byte bank`,
      );
    }
    for (let i = 0; i < bank.size; i++) {
      this.arena.writeByte(bank.base + i, i < payload.length ? payload[i] : 0);
    }
    return true;
  }

  /** Opaque cart file I/O (docs/STORAGE.md §6) — "read this one file
   * in"/"here's where a finished one gets written," nothing more. A
   * cart's internal layout is Phase 11 territory, not this module's. */
  loadCart(cartName: string): Uint8Array | undefined {
    return this.hal.readFile(this.cartPath(cartName));
  }

  saveCart(cartName: string, bytes: Uint8Array): void {
    this.hal.ensureDir(CARTS_ROOT);
    this.hal.writeFile(this.cartPath(cartName), bytes);
  }
}

/** Round-trips a synthetic DATA bank through the real save/open path and
 * confirms the bytes come back unchanged — the same end-to-end proof
 * `CKernel::RunStorageSelfTest` runs on real hardware on every mount
 * (docs/STORAGE.md §8), ported here as a standalone function rather than
 * something wired into `Machine` permanently, since Rebel-Sim has no
 * boot-time hardware-mount event to hang it off of — the host calls this
 * once, explicitly, when it wants the proof (e.g. app startup,
 * PORTING-WEB.md §5's "storage layer that round-trips" bar).
 *
 * Uses its own private arena/bank-table/Storage internally — twice, one
 * per "boot" — rather than touching the caller's actual Machine state.
 * Real hardware's own self-test writes on the *first* boot with a given
 * stick and verifies on every *subsequent* one (two different processes,
 * so the bank name never collides); reusing the caller's live bank table
 * for both halves in a single call would hit exactly the same-process
 * name-collision case docs/STORAGE.md §8 already flags as a harmless but
 * real limitation — simulating two separate "boots" here sidesteps it
 * rather than reproducing it. */
export function runStorageSelfTest(hal: StorageHal, projectName = 'REBELDEF'): boolean {
  const size = roundToSizeClass(256)!;

  const writeArena = new Arena(1 << 16);
  const writeBanks = new BankTable(writeArena);
  const writeStorage = new Storage(writeArena, writeBanks, hal);
  const written = writeBanks.createBank('DATA', size, 'TESTDATA');
  for (let i = 0; i < written.size; i++) {
    writeArena.writeByte(written.base + i, i & 0xff);
  }
  writeStorage.saveAsset(projectName, written);

  const readArena = new Arena(1 << 16);
  const readBanks = new BankTable(readArena);
  const readStorage = new Storage(readArena, readBanks, hal);
  const reloaded = readStorage.openProject(projectName);
  const roundTripped = reloaded.find((b) => b.name === 'TESTDATA');
  if (!roundTripped) {
    return false;
  }

  for (let i = 0; i < roundTripped.size; i++) {
    if (readArena.readByte(roundTripped.base + i) !== (i & 0xff)) {
      return false;
    }
  }
  return true;
}
