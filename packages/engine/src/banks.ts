/**
 * Bank table: named, fixed-size, independently-based regions within one
 * arena (FORTH-ARCHITECTURE.md §3). Handed out in creation order and
 * never relocated once created. Tags come from rebel-opcodes.json's
 * bankTags map (provisional — see that file's header note).
 */

import { Arena } from './arena.js';

export interface Bank {
  readonly tag: string;
  readonly name: string;
  readonly base: number;
  readonly size: number;
}

export class BankTable {
  private readonly banks: Bank[] = [];
  private nextFree = 0;

  constructor(private readonly arena: Arena) {}

  createBank(tag: string, name: string, size: number): Bank {
    if (this.findBank(tag, name)) {
      throw new Error(`bank ${tag}/${name} already exists`);
    }
    if (this.nextFree + size > this.arena.sizeBytes) {
      throw new RangeError(
        `arena out of space: cannot create bank ${tag}/${name} of size ${size}`,
      );
    }
    const bank: Bank = { tag, name, base: this.nextFree, size };
    this.banks.push(bank);
    this.nextFree += size;
    return bank;
  }

  findBank(tag: string, name: string): Bank | undefined {
    return this.banks.find((b) => b.tag === tag && b.name === name);
  }

  requireBank(tag: string, name: string): Bank {
    const bank = this.findBank(tag, name);
    if (!bank) {
      throw new Error(`bank ${tag}/${name} not found`);
    }
    return bank;
  }
}
