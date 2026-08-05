/**
 * Bank table: named, fixed-size, independently-based regions within one
 * arena (FORTH-ARCHITECTURE.md §3). Handed out in creation order and
 * never relocated once created. Tags come from rebel-opcodes.json's
 * bankTags map (provisional — see that file's header note).
 *
 * `name` (docs/MEMORY-MODEL.md §3.2.1, src/membank.h) is a bank's own
 * identity, distinct from `tag` (what *kind* of bank) — what makes
 * multiple simultaneously-created banks of the same tag (several
 * `DATA`-tagged project assets, M5/storage.ts) distinguishable, and what
 * doubles directly as a saved asset file's basename. Uniqueness is
 * enforced on `name` alone (matching `CBankTable::CreateBank`'s Phase 9
 * change from tag-uniqueness) — tags are expected to repeat. A caller
 * that doesn't care about a stable name (every bank M1-M4 created) omits
 * it and gets an auto-generated 8-digit zero-padded serial, exactly like
 * `CBankTable::GenerateSerialName`.
 *
 * DEVELOPING.md §14, M22: reads (`getAllBanks()`/`findBank()`/
 * `findBankByName()`) and allocation (`createBank()`) both go through
 * `MemoryMap` (`mmap.ts`) now, not a private array/counter — no cached
 * state to drift out of sync with what Forth-side `CREATE-BANK` (M21)
 * does directly. No out-of-space validation either, matching
 * `CREATE-BANK`'s own precedent — relies on `DataView`'s bounds
 * checking at first real access, not a check here.
 */

import { Arena } from './arena.js';
import {
  MemoryMap,
  MMAP_SIZE,
  MMAP_TAG,
  BankFlagResident,
  BankFlagExternal,
  BankFlagSwappable,
  BankFlagDirty,
  BankFlagActive,
} from './mmap.js';

// Re-exported for this module's own existing public surface
// (index.ts/primitives.ts import these from banks.ts today) — owned by
// mmap.ts now, DEVELOPING.md §14, M22.
export { BankFlagResident, BankFlagExternal, BankFlagSwappable, BankFlagDirty, BankFlagActive };

export const BANK_NAME_LEN = 8;

const DEFAULT_FLAGS = BankFlagResident | BankFlagActive;

/** Standard bank size classes (docs/MEMORY-MODEL.md §3.1): each 4x the
 * previous. XS matches ARM's native page size — a nod to alignment, not
 * an MMU-paging requirement. */
export const BankSizeXS = 4 * 1024;
export const BankSizeS = 16 * 1024;
export const BankSizeM = 64 * 1024;
export const BankSizeL = 256 * 1024;
export const BankSizeXL = 1024 * 1024;
export const BankSizeXXL = 4096 * 1024;

const SIZE_CLASSES = [BankSizeXS, BankSizeS, BankSizeM, BankSizeL, BankSizeXL, BankSizeXXL];

/** Rounds up to the smallest size class that fits `bytes` — used when a
 * bank's size comes from a loaded file rather than a compile-time
 * constant (docs/STORAGE.md §5). Returns undefined if nothing fits
 * (`CStorageModule::LoadAssetFile` skips such a file rather than
 * crashing — same contract here). */
export function roundToSizeClass(bytes: number): number | undefined {
  return SIZE_CLASSES.find((size) => bytes <= size);
}

export interface Bank {
  readonly tag: string;
  readonly name: string;
  readonly base: number;
  readonly size: number;
  readonly flags: number;
}

export class BankTable {
  private nextSerial = 0;

  /** DEVELOPING.md §11/§14, M19/M22: the real source of truth for this
   * table now — reads and allocation both go through it. Public so
   * tests/tooling can inspect it directly. */
  readonly mmap: MemoryMap;

  constructor(arena: Arena) {
    // MMAP is always bank 0 — reserve its fixed space via the same
    // allocate() path every other bank uses (it naturally finds the
    // first inactive slot — slot 0, on a fresh arena — and computes
    // base 0, since no slot is active yet to push it forward).
    this.mmap = new MemoryMap(arena, 0);
    this.mmap.initHeader();
    this.mmap.allocate(MMAP_TAG, MMAP_TAG, MMAP_SIZE, DEFAULT_FLAGS);
  }

  private generateSerialName(): string {
    return String(this.nextSerial++).padStart(BANK_NAME_LEN, '0');
  }

  createBank(tag: string, size: number, name?: string, flags = DEFAULT_FLAGS): Bank {
    const bankName = (name ?? this.generateSerialName()).slice(0, BANK_NAME_LEN);
    if (this.findBankByName(bankName)) {
      throw new Error(`bank name ${bankName} already exists`);
    }
    // The returned descriptor, not a locally-built one — MMapSlot and
    // Bank are structurally identical, and allocate() always forces
    // ACTIVE on internally, so this stays consistent with what's
    // actually stored even when a caller's `flags` omitted it.
    return this.mmap.allocate(tag, bankName, size, flags);
  }

  /** "A bank of this type" (tags repeat) when called with one argument;
   * "the bank with this tag and name" when called with both. */
  findBank(tag: string, name?: string): Bank | undefined {
    if (name !== undefined) {
      return this.mmap.getAllSlots().find((b) => b.tag === tag && b.name === name);
    }
    return this.mmap.getAllSlots().find((b) => b.tag === tag);
  }

  /** Names are unique — the real "the one bank" lookup once more than
   * one bank shares a tag (docs/STORAGE.md needs this to map a loaded
   * file back to its bank). */
  findBankByName(name: string): Bank | undefined {
    return this.mmap.getAllSlots().find((b) => b.name === name);
  }

  requireBank(tag: string, name?: string): Bank {
    const bank = this.findBank(tag, name);
    if (!bank) {
      throw new Error(`bank ${tag}${name ? '/' + name : ''} not found`);
    }
    return bank;
  }

  /** Every active bank, in creation order — for UI/debugging use only
   * (e.g. an inspector panel), same spirit as DataStack.toArray(). */
  getAllBanks(): readonly Bank[] {
    return this.mmap.getAllSlots();
  }
}
