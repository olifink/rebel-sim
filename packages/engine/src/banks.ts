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
 */

import { Arena } from './arena.js';

export const BANK_NAME_LEN = 8;

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
}

export class BankTable {
  private readonly banks: Bank[] = [];
  private nextFree = 0;
  private nextSerial = 0;

  constructor(private readonly arena: Arena) {}

  private generateSerialName(): string {
    return String(this.nextSerial++).padStart(BANK_NAME_LEN, '0');
  }

  createBank(tag: string, size: number, name?: string): Bank {
    const bankName = (name ?? this.generateSerialName()).slice(0, BANK_NAME_LEN);
    if (this.findBankByName(bankName)) {
      throw new Error(`bank name ${bankName} already exists`);
    }
    if (this.nextFree + size > this.arena.sizeBytes) {
      throw new RangeError(
        `arena out of space: cannot create bank ${tag}/${bankName} of size ${size}`,
      );
    }
    const bank: Bank = { tag, name: bankName, base: this.nextFree, size };
    this.banks.push(bank);
    this.nextFree += size;
    return bank;
  }

  /** "A bank of this type" (tags repeat) when called with one argument;
   * "the bank with this tag and name" when called with both. */
  findBank(tag: string, name?: string): Bank | undefined {
    if (name !== undefined) {
      return this.banks.find((b) => b.tag === tag && b.name === name);
    }
    return this.banks.find((b) => b.tag === tag);
  }

  /** Names are unique — the real "the one bank" lookup once more than
   * one bank shares a tag (docs/STORAGE.md needs this to map a loaded
   * file back to its bank). */
  findBankByName(name: string): Bank | undefined {
    return this.banks.find((b) => b.name === name);
  }

  requireBank(tag: string, name?: string): Bank {
    const bank = this.findBank(tag, name);
    if (!bank) {
      throw new Error(`bank ${tag}${name ? '/' + name : ''} not found`);
    }
    return bank;
  }

  /** Every bank in creation order — for UI/debugging use only (e.g. an
   * inspector panel), same spirit as DataStack.toArray(). */
  getAllBanks(): readonly Bank[] {
    return this.banks;
  }
}
