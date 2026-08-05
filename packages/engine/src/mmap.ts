/**
 * MMAP — arena-resident bank table (DEVELOPING.md §11, M19). Always
 * bank 0, absolute base 0, ahead of every other bank — harmless, since
 * addresses are always per-arena offsets (FORTH-ARCHITECTURE.md) and
 * nothing in this codebase hardcodes a bank's absolute base.
 *
 * This is a **mirror**, not yet the source of truth: `BankTable`'s own
 * host-side `banks` array stays the real read path for
 * `findBank()`/`getAllBanks()` (unchanged) — every bank it creates,
 * including `MMAP` itself, additionally gets written here so a memory
 * snapshot or (eventually) Forth source can read the same layout
 * directly, without asking the host. Making `MMAP` the actual source of
 * truth, and letting Forth create banks by writing it directly, is real
 * follow-on work, not done here (`DEVELOPING.md` §11's own scope cuts).
 *
 * Slot byte layout is proposed, not finalized cross-target — see
 * `DEVELOPING.md` §11 and `rebel-rom/CHANGES.md` for the open question
 * around matching this to a real `CBank` C++ layout later.
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
// established sanity-header pattern, plus two cells: next-free offset
// and slot count in use — the arena-resident equivalent of BankTable's
// own private nextFree/banks.length.
const HEADER_MAGIC_0 = 'M'.charCodeAt(0);
const HEADER_MAGIC_1 = 'M'.charCodeAt(0);
const HEADER_VERSION = 1;
const HEADER_SIZE = 4 + 4 + 4; // magic+version+reserved(4), nextFree(4), slotCount(4)
const NEXT_FREE_OFFSET = 4;
const SLOT_COUNT_OFFSET = 8;

// tag(4) + name(8) + base(4-cell) + size(4-cell) + flags(4-cell).
const SLOT_SIZE = TAG_SIZE + NAME_SIZE + 4 + 4 + 4;
const SLOT_BASE_OFFSET = TAG_SIZE + NAME_SIZE;
const SLOT_SIZE_OFFSET = SLOT_BASE_OFFSET + 4;
const SLOT_FLAGS_OFFSET = SLOT_SIZE_OFFSET + 4;

/** Total size MMAP itself reserves, header + all slots — not a size
 * class (like CHAR's bank, MMAP's size is a computed constant, not a
 * requested one). */
export const MMAP_SIZE = HEADER_SIZE + MMAP_MAX_SLOTS * SLOT_SIZE;

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
    this.arena.writeByte(b + 3, 0);
    this.arena.writeCellUnsigned(b + NEXT_FREE_OFFSET, 0);
    this.arena.writeCellUnsigned(b + SLOT_COUNT_OFFSET, 0);
  }

  getNextFree(): number {
    return this.arena.readCellUnsigned(this.base + NEXT_FREE_OFFSET);
  }

  private setNextFree(value: number): void {
    this.arena.writeCellUnsigned(this.base + NEXT_FREE_OFFSET, value);
  }

  getSlotCount(): number {
    return this.arena.readCellUnsigned(this.base + SLOT_COUNT_OFFSET);
  }

  private setSlotCount(value: number): void {
    this.arena.writeCellUnsigned(this.base + SLOT_COUNT_OFFSET, value);
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

  /** Appends one bank's descriptor to the next free slot. Doesn't
   * perform allocation itself — `base`/`size` are handed in by
   * `BankTable`, which already decided them; this just mirrors that
   * decision into arena bytes. */
  addBank(tag: string, name: string, base: number, size: number, flags: number): void {
    const count = this.getSlotCount();
    if (count >= MMAP_MAX_SLOTS) {
      throw new RangeError(`MMAP is full (${MMAP_MAX_SLOTS} slots)`);
    }
    const offset = this.slotOffset(count);
    this.writeFixedString(offset, tag, TAG_SIZE);
    this.writeFixedString(offset + TAG_SIZE, name, NAME_SIZE);
    this.arena.writeCellUnsigned(offset + SLOT_BASE_OFFSET, base);
    this.arena.writeCellUnsigned(offset + SLOT_SIZE_OFFSET, size);
    this.arena.writeCellUnsigned(offset + SLOT_FLAGS_OFFSET, flags);
    this.setSlotCount(count + 1);
    this.setNextFree(base + size);
  }

  getSlot(index: number): MMapSlot {
    if (index < 0 || index >= this.getSlotCount()) {
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

  /** Every slot in use, in creation order — mirrors
   * `BankTable.getAllBanks()`'s own "for UI/debugging/verification"
   * scope, not a hot path. */
  getAllSlots(): MMapSlot[] {
    const out: MMapSlot[] = [];
    const count = this.getSlotCount();
    for (let i = 0; i < count; i++) {
      out.push(this.getSlot(i));
    }
    return out;
  }

  /** DEVELOPING.md §12: BANK@'s real lookup path — the first slot's
   * base address whose tag matches, `undefined` if none. Slots are
   * always in creation order, so this matches
   * `BankTable.findBank(tag)`'s own "first bank of this type"
   * semantics exactly, reading arena bytes instead of the host array. */
  findBankAddr(tag: string): number | undefined {
    const count = this.getSlotCount();
    for (let i = 0; i < count; i++) {
      const slot = this.getSlot(i);
      if (slot.tag === tag) {
        return slot.base;
      }
    }
    return undefined;
  }
}
