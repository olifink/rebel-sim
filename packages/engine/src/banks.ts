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
  PersonalityFlagHeadless,
  type Personality,
  DEFAULT_PERSONALITY,
} from './mmap.js';

// Re-exported for this module's own existing public surface
// (index.ts/primitives.ts import these from banks.ts today) — owned by
// mmap.ts now, DEVELOPING.md §14, M22.
export { BankFlagResident, BankFlagExternal, BankFlagSwappable, BankFlagDirty, BankFlagActive };
export { PersonalityFlagHeadless, DEFAULT_PERSONALITY };
export type { Personality };

export const BANK_NAME_LEN = 8;

const DEFAULT_FLAGS = BankFlagResident | BankFlagActive;

/** M55 (spec/02-MEMORY-MODEL.md §4.3): a bank's size class is the next
 * power of two, floored at `MIN_BANK_SIZE` and capped at `MAX_BANK_SIZE`
 * (needing more than that takes multiple banks, not one bigger one).
 * Replaces the earlier six *named* classes (`XS`..`XXL`, each 4x the
 * previous, Oliver: "the jumps we have are a bit big and unpredictable")
 * — doubling instead of quadrupling halves worst-case rounding waste
 * (under 2x instead of under 4x) while dropping the maintained lookup
 * table and its per-class names entirely: a bank's size class is simply
 * its own rounded byte count, nothing else names it. Every bank size
 * chosen before that change (4096/65536/...) was already a power of two
 * under the old 4x-per-step ladder too (the old classes were exactly
 * the *even* powers of two — this just fills in the odd ones between
 * them), so no existing bank's actual byte size changed there; only
 * new, in-between requests rounded more tightly.
 *
 * M58 (Oliver: "align on 2K banks as the smallest size"): the floor
 * itself dropped one more step, 4 KiB → 2 KiB, once several boot banks
 * (`MMAP`, `KMAP`, `WORK`, `SYSV`) turned out to use well under half of
 * their old 4 KiB floor. 4 KiB was always ARM's native page size
 * adopted as a nod to alignment, never an MMU-paging requirement this
 * model actually has (§4.4) — nothing structural stopped it dropping
 * further. The bump allocator's own alignment (`mmap.ts`) now derives
 * from this constant rather than a hardcoded 4 KiB, so every size class
 * stays a multiple of the alignment and the "no rounding step ever
 * pads" property holds at the new floor too. */
export const MIN_BANK_SIZE = 2 * 1024;
export const MAX_BANK_SIZE = 4 * 1024 * 1024;

/** FORTH-ARCHITECTURE.md §7: the fixed unit `hal_block_read`/
 * `hal_block_write` (primitives.ts's `(BLOCK-READ)`/`(BLOCK-WRITE)`, 140/
 * 141) move — classic Forth's 1024-byte "screen" size, not something any
 * target gets to pick independently. Lives here (not repl.ts, which
 * creates the `BLKS` bank sized from it) so primitives.ts can import it
 * too without a repl.ts<->primitives.ts circular dependency. */
export const BLOCK_SIZE = 1024;

/** Rounds up to the smallest size class that fits `bytes` — used when a
 * bank's size comes from a loaded file rather than a compile-time
 * constant (docs/STORAGE.md §5). Returns undefined if nothing fits
 * (`CStorageModule::LoadAssetFile` skips such a file rather than
 * crashing — same contract here). */
export function roundToSizeClass(bytes: number): number | undefined {
  if (bytes > MAX_BANK_SIZE) {
    return undefined;
  }
  let size = MIN_BANK_SIZE;
  while (size < bytes) {
    size *= 2;
  }
  return size;
}

export interface Bank {
  readonly tag: string;
  readonly name: string;
  readonly base: number;
  readonly size: number;
  readonly flags: number;
}

export class BankTable {
  /** DEVELOPING.md §11/§14, M19/M22: the real source of truth for this
   * table now — reads and allocation both go through it. Public so
   * tests/tooling can inspect it directly. */
  readonly mmap: MemoryMap;

  constructor(arena: Arena, personality?: Personality) {
    // MMAP is always bank 0 — reserve its fixed space via the same
    // allocate() path every other bank uses (it naturally finds the
    // first inactive slot — slot 0, on a fresh arena — and computes
    // base 0, since no slot is active yet to push it forward).
    this.mmap = new MemoryMap(arena, 0);
    this.mmap.initHeader(personality);
    this.mmap.allocate(MMAP_TAG, MMAP_TAG, MMAP_SIZE, DEFAULT_FLAGS);
  }

  /** DEVELOPING.md §20, M27: draws from MMAP's own header cell now, not
   * a private field — the same counter CREATE-BANK's primitive uses
   * directly, so this and Forth-side creation can never collide on an
   * auto-generated name. */
  private generateSerialName(): string {
    return String(this.mmap.nextBankSerial()).padStart(BANK_NAME_LEN, '0');
  }

  /** `size` is a *requested* byte count, not the bank's actual size —
   * every carved bank MUST occupy exactly one power-of-two size class
   * (spec/02-MEMORY-MODEL.md §4.3), so this rounds `size` up to the
   * smallest class that fits before carving anything, uniformly for
   * every caller (host-side creation here, and the Forth-level
   * `CREATE-BANK` primitive, which routes through this same method —
   * §4.3 names both explicitly: "this rule applies uniformly to every
   * source of a bank-size request"). `MMAP` itself is never created
   * through this method — only via `mmap.allocate()` directly
   * (`BankTable`'s own constructor) — but not because it's exempt from
   * size-class rounding: §5.3 (M34) closed that old exemption, so
   * `MMAP_SIZE` (mmap.ts) is itself already a fixed, asserted-correct
   * `MIN_BANK_SIZE`-class constant, computed the same way this method
   * would round it if it went through here. */
  createBank(tag: string, size: number, name?: string, flags = DEFAULT_FLAGS): Bank {
    const roundedSize = roundToSizeClass(size);
    if (roundedSize === undefined) {
      throw new Error(`requested bank size ${size} exceeds the maximum bank size (${MAX_BANK_SIZE} bytes)`);
    }
    const bankName = (name ?? this.generateSerialName()).slice(0, BANK_NAME_LEN);
    if (this.findBankByName(bankName)) {
      throw new Error(`bank name ${bankName} already exists`);
    }
    // The returned descriptor, not a locally-built one — MMapSlot and
    // Bank are structurally identical, and allocate() always forces
    // ACTIVE on internally, so this stays consistent with what's
    // actually stored even when a caller's `flags` omitted it.
    return this.mmap.allocate(tag, bankName, roundedSize, flags);
  }

  /** M54 (spec/02-MEMORY-MODEL.md §7): overwrites an existing bank's own
   * `size` field in MMAP with a new, size-class-rounded value — no bytes
   * moved, no other bank touched, this bank's own `base` unchanged.
   * `MMAP` itself can never be resized (its size is a fixed, asserted
   * cross-target layout constant, `mmap.ts`'s `MMAP_SIZE`).
   *
   * Deliberately does *not* take effect for the currently-running
   * `Machine`: every consumer holding this bank's descriptor
   * (`DataStack`, `dictionary.ts`'s HERE-overflow check, `Screen`,
   * `Keyboard`, ...) captured an immutable snapshot at construction
   * time, and a bigger claimed region here would physically overlap
   * whichever bank happens to sit right after it in memory today, since
   * nothing shifts. The resize becomes real only across a save/restart
   * cycle — `SAVE` (127) persists this MMAP edit, and a `RESTORE` (128)
   * that finds a saved size differing from what's live now triggers a
   * fresh `Machine` construction (`Inner`'s `'restart-project'`
   * `StepSignal`, mirroring `COLD`'s own "throw this one away, build a
   * fresh one" shape), which re-derives every bank's base from these
   * (possibly-edited) sizes via the normal bump allocator — the only
   * point a resize can safely relocate whatever comes after it. */
  resizeBank(name: string, size: number): Bank {
    if (name === MMAP_TAG) {
      throw new Error('MMAP itself cannot be resized — its size is a fixed cross-target layout constant');
    }
    const roundedSize = roundToSizeClass(size);
    if (roundedSize === undefined) {
      throw new Error(`requested bank size ${size} exceeds the maximum bank size (${MAX_BANK_SIZE} bytes)`);
    }
    const index = this.mmap.findSlotIndex(name);
    if (index === undefined) {
      throw new Error(`unknown bank: ${name}`);
    }
    this.mmap.setSlotSize(index, roundedSize);
    return this.mmap.getSlot(index);
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
