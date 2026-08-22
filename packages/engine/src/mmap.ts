/**
 * MMAP — arena-resident bank table (DEVELOPING.md §11/§14, M19/M22).
 * Always bank 0, absolute base 0, ahead of every other bank — harmless,
 * since addresses are always per-arena offsets (FORTH-ARCHITECTURE.md)
 * and nothing in this codebase hardcodes a bank's absolute base.
 *
 * The real source of truth (M22) — `BankTable`'s own reads
 * (`getAllBanks()`/`findBank()`/`findBankByName()`) and allocations
 * (`createBank()`) both go through this module now, not a private TS
 * array/counter. No cursor state is cached anywhere: which slot is
 * free and what memory address is free are both derived by scanning
 * all `MMAP_MAX_SLOTS` fixed slots and checking each one's own
 * `ACTIVE` flag, every time — nothing to keep in sync, nothing that
 * can drift. `ACTIVE` is pure per-slot occupancy (a slot with it set
 * is a real, in-use bank; unset means available) — not a
 * flush-safety detail; async-flush-safety is explicitly out of scope
 * for this design (`DEVELOPING.md` §14).
 *
 * Slot byte layout is proposed, not finalized cross-target — see
 * `DEVELOPING.md` §11/§14 and `rebel-rom/CHANGES.md` for the open
 * question around matching this to a real `CBank` C++ layout later.
 */

import { Arena } from './arena.js';

export const MMAP_TAG = 'MMAP';

/** Matches rebel-rom's real BANK_TABLE_MAX_BANKS (src/membank.h) — not
 * a separately-chosen number, so both sides start aligned. */
export const MMAP_MAX_SLOTS = 64;

const TAG_SIZE = 4;
// Matches banks.ts's BANK_NAME_LEN — not imported, to avoid a circular
// banks.ts <-> mmap.ts dependency (banks.ts imports MemoryMap; this
// only needs the numeric value, not anything else from that module).
const NAME_SIZE = 8;

// magic('M','M') + version + reserved, mirroring Sysvars.initHeader()'s
// established sanity-header pattern. No cursor cells (M22) — occupancy
// lives entirely in each slot's own ACTIVE flag.
const HEADER_MAGIC_0 = 'M'.charCodeAt(0);
const HEADER_MAGIC_1 = 'M'.charCodeAt(0);
const HEADER_VERSION = 1;

// DEVELOPING.md §20, M27: three more header cells, arena-bookkeeping
// that belongs with MMAP itself rather than in SYSV — genuinely
// necessary persistent state (unlike M22's removed cursor cells,
// which were *derivable* by scanning slots and so didn't belong
// anywhere), available from the very first line of BankTable's own
// constructor, before Sysvars exists at all.
const NEXT_BANK_OFFSET = 4; // MemoryMap.nextBankSerial()'s counter
const ARENA_SIZE_OFFSET = 8; // moved out of the old CORE.ARENA-SIZE sysvar
const ARENA_ID_OFFSET = 12; // reserved, always 0 today — future
// multi-arena bookkeeping (a counter on the arena-creation side,
// analogous to NEXT-BANK), no consumer yet, not decided further
const HEADER_SIZE = 16;

// tag(4) + name(8) + base(4-cell) + size(4-cell) + flags(4-cell).
const SLOT_SIZE = TAG_SIZE + NAME_SIZE + 4 + 4 + 4;
const SLOT_BASE_OFFSET = TAG_SIZE + NAME_SIZE;
const SLOT_SIZE_OFFSET = SLOT_BASE_OFFSET + 4;
const SLOT_FLAGS_OFFSET = SLOT_SIZE_OFFSET + 4;

/** Raw content requirement — header + all slots — before size-class
 * rounding. Not exported: nothing outside this module needs the
 * pre-rounded figure, only the actual declared bank size below. */
const MMAP_RAW_SIZE = HEADER_SIZE + MMAP_MAX_SLOTS * SLOT_SIZE;

/** [Revised, spec/02-MEMORY-MODEL.md §5.3] MMAP used to be the one
 * carved bank exempted from size-class rounding, declaring its exact
 * raw byte count (1552, with the default 64 slots) as its size. That
 * exemption is gone — MMAP now conforms to the same size-class rule
 * (§4.3) as every other bank, for consistency, at the cost of a real,
 * accepted breaking change for any already-saved project (no real
 * project data exists yet to migrate). 4096 (`MIN_BANK_SIZE` in
 * banks.ts, M55 — not imported here, same avoid-a-circular-dependency
 * reason as NAME_SIZE above) comfortably covers the 64-slot default's
 * 1552-byte raw requirement; a build with a much larger MAX_SLOTS
 * would need to round to a bigger class instead — this constant is
 * asserted against the raw requirement below specifically so a future
 * MAX_SLOTS change can't silently outgrow it. */
export const MMAP_SIZE = 4096;

if (MMAP_RAW_SIZE > MMAP_SIZE) {
  throw new Error(
    `MMAP's raw content requirement (${MMAP_RAW_SIZE} bytes) no longer fits its declared size class (${MMAP_SIZE} bytes) — MAX_SLOTS grew too far; round MMAP_SIZE up to the next size class.`,
  );
}

/** Matches rebel-rom's real TBankFlags (src/membank.h) bit-for-bit for
 * the first four; ACTIVE (DEVELOPING.md §11/§14, M19/M22) is a
 * Rebel-Sim-first addition, next free bit after DIRTY, and the one
 * `MemoryMap` itself now depends on natively (occupancy). Owned here
 * rather than in banks.ts specifically so `mmap.ts` can check ACTIVE
 * without importing back from `banks.ts` — banks.ts re-exports these
 * for its own existing public surface. RESIDENT/EXTERNAL/SWAPPABLE/
 * DIRTY all stay exactly as reserved/inert as they are on both sides —
 * this doesn't wire any of them up. */
export const BankFlagResident = 1 << 0;
export const BankFlagExternal = 1 << 1;
export const BankFlagSwappable = 1 << 2; // reserved, inert
export const BankFlagDirty = 1 << 3; // reserved, inert — DEVELOPING.md §11
export const BankFlagActive = 1 << 4; // DEVELOPING.md §11/§14, M19/M22

export interface MMapSlot {
  readonly tag: string;
  readonly name: string;
  readonly base: number;
  readonly size: number;
  readonly flags: number;
}

export class MemoryMap {
  constructor(
    private readonly arena: Arena,
    readonly base: number,
  ) {}

  initHeader(): void {
    const b = this.base;
    this.arena.writeByte(b + 0, HEADER_MAGIC_0);
    this.arena.writeByte(b + 1, HEADER_MAGIC_1);
    this.arena.writeByte(b + 2, HEADER_VERSION);
    this.arena.writeByte(b + 3, 0); // reserved
    this.arena.writeCellUnsigned(b + NEXT_BANK_OFFSET, 0);
    this.arena.writeCellUnsigned(b + ARENA_SIZE_OFFSET, this.arena.sizeBytes);
    this.arena.writeCellUnsigned(b + ARENA_ID_OFFSET, 0); // reserved, DEVELOPING.md §20
  }

  /** DEVELOPING.md §20, M27: the shared bank-naming counter — both
   * `BankTable`'s own auto-serial fallback (when no name is given)
   * and the `CREATE-BANK` primitive draw from this single
   * arena-resident cell, so two independently-created anonymous
   * banks (one host-side, one Forth-side) can never collide on
   * name. Returns the value *before* incrementing (matches the old
   * private `nextSerial++` field's exact semantics). */
  nextBankSerial(): number {
    const offset = this.base + NEXT_BANK_OFFSET;
    const n = this.arena.readCellUnsigned(offset);
    this.arena.writeCellUnsigned(offset, n + 1);
    return n;
  }

  private slotOffset(index: number): number {
    return this.base + HEADER_SIZE + index * SLOT_SIZE;
  }

  private writeFixedString(offset: number, text: string, size: number): void {
    for (let i = 0; i < size; i++) {
      this.arena.writeByte(offset + i, i < text.length ? text.charCodeAt(i) : 0);
    }
  }

  private readFixedString(offset: number, size: number): string {
    let out = '';
    for (let i = 0; i < size; i++) {
      const code = this.arena.readByte(offset + i);
      if (code === 0) break;
      out += String.fromCharCode(code);
    }
    return out;
  }

  getSlot(index: number): MMapSlot {
    if (index < 0 || index >= MMAP_MAX_SLOTS) {
      throw new RangeError(`MMAP slot ${index} out of range`);
    }
    const offset = this.slotOffset(index);
    return {
      tag: this.readFixedString(offset, TAG_SIZE),
      name: this.readFixedString(offset + TAG_SIZE, NAME_SIZE),
      base: this.arena.readCellUnsigned(offset + SLOT_BASE_OFFSET),
      size: this.arena.readCellUnsigned(offset + SLOT_SIZE_OFFSET),
      flags: this.arena.readCellUnsigned(offset + SLOT_FLAGS_OFFSET),
    };
  }

  /** Every slot currently active, in slot order (which matches
   * creation order today, since allocation always picks the lowest
   * available slot and nothing ever deactivates a real bank yet) —
   * mirrors `BankTable.getAllBanks()`'s own "for UI/debugging/
   * verification" scope, not a hot path. */
  getAllSlots(): MMapSlot[] {
    const out: MMapSlot[] = [];
    for (let i = 0; i < MMAP_MAX_SLOTS; i++) {
      const slot = this.getSlot(i);
      if (slot.flags & BankFlagActive) {
        out.push(slot);
      }
    }
    return out;
  }

  /** The slot index of the active bank named `name`, or `undefined` if
   * none matches — `getAllSlots()`'s read-only scan returns descriptors
   * with no notion of "which slot," which `setSlotSize()` below needs to
   * target the right cell. */
  findSlotIndex(name: string): number | undefined {
    for (let i = 0; i < MMAP_MAX_SLOTS; i++) {
      const slot = this.getSlot(i);
      if (slot.flags & BankFlagActive && slot.name === name) {
        return i;
      }
    }
    return undefined;
  }

  /** M54 (spec/02-MEMORY-MODEL.md §7): overwrites just one slot's `size`
   * cell in place — no other slot moves, no arena bytes beyond this one
   * cell are touched. `BankTable.resizeBank()` is the only caller; see
   * its own comment for why this is deliberately inert for the
   * currently-running `Machine` and only takes effect across a
   * save/restart cycle. */
  setSlotSize(index: number, newSize: number): void {
    if (index < 0 || index >= MMAP_MAX_SLOTS) {
      throw new RangeError(`MMAP slot ${index} out of range`);
    }
    this.arena.writeCellUnsigned(this.slotOffset(index) + SLOT_SIZE_OFFSET, newSize);
  }

  /** DEVELOPING.md §14, M22: the real allocator — no cached cursor of
   * any kind. Finds the first inactive slot and the real free memory
   * address (`max(base + size)` over every currently-active slot) in
   * one pass, writes the descriptor into that slot, then activates it
   * last ("prepare it, then switch it on") — the slot is already
   * inactive (that's why it was chosen), so occupancy only ever
   * becomes true once the descriptor is fully written.
   *
   * The computed free-cursor position is then rounded up to the next
   * 4 KiB boundary (spec/02-MEMORY-MODEL.md §4.4) before anything gets
   * placed there — every size class is itself already a multiple of
   * 4 KiB, and (since MMAP itself became size-class-rounded too, spec
   * §5.3) so is MMAP now, so in practice no placement ever needs real
   * rounding — every bank already lands pre-aligned regardless. Applied
   * unconditionally anyway, including for `MMAP`'s own self-registration
   * (`BankTable`'s constructor) — harmless there since offset 0 is
   * already aligned, and it's what keeps this the one place base
   * alignment is enforced rather than something each caller must
   * remember (a future non-class-sized bank, should one ever exist
   * again, would need it to actually do something).
   *
   * Returns the actual stored descriptor (`ACTIVE` always forced on,
   * regardless of what `flags` requested) rather than just the new
   * `base` — a caller building its own return value from the raw
   * `flags` parameter instead would silently disagree with what this
   * method actually persisted whenever `flags` omitted `ACTIVE`. */
  allocate(tag: string, name: string, size: number, flags: number): MMapSlot {
    let freeSlot = -1;
    let base = 0;
    for (let i = 0; i < MMAP_MAX_SLOTS; i++) {
      const slot = this.getSlot(i);
      if (slot.flags & BankFlagActive) {
        base = Math.max(base, slot.base + slot.size);
      } else if (freeSlot === -1) {
        freeSlot = i;
      }
    }
    if (freeSlot === -1) {
      throw new RangeError(`MMAP is full (${MMAP_MAX_SLOTS} slots)`);
    }
    const alignedBase = (base + 4095) & ~4095;

    const activeFlags = flags | BankFlagActive;
    const offset = this.slotOffset(freeSlot);
    this.writeFixedString(offset, tag, TAG_SIZE);
    this.writeFixedString(offset + TAG_SIZE, name, NAME_SIZE);
    this.arena.writeCellUnsigned(offset + SLOT_BASE_OFFSET, alignedBase);
    this.arena.writeCellUnsigned(offset + SLOT_SIZE_OFFSET, size);
    this.arena.writeCellUnsigned(offset + SLOT_FLAGS_OFFSET, activeFlags);

    return this.getSlot(freeSlot);
  }
}
