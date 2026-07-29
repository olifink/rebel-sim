/**
 * Data stack against the DSTK bank. Grows down within its own bank,
 * bounds-checked against that bank's own size (FORTH-ARCHITECTURE.md §3).
 * `sp` starts at `bank.base + bank.size` (empty) and decreases toward
 * `bank.base` as cells are pushed.
 */

import { Arena } from './arena.js';
import { Bank } from './banks.js';

export class StackUnderflowError extends Error {}
export class StackOverflowError extends Error {}

const CELL = 4;

export class DataStack {
  private sp: number;

  constructor(
    private readonly arena: Arena,
    private readonly bank: Bank,
  ) {
    this.sp = bank.base + bank.size;
  }

  get depth(): number {
    return (this.bank.base + this.bank.size - this.sp) / CELL;
  }

  push(value: number): void {
    const next = this.sp - CELL;
    if (next < this.bank.base) {
      throw new StackOverflowError('data stack overflow');
    }
    this.sp = next;
    this.arena.writeCell(this.sp, value);
  }

  pop(): number {
    if (this.sp + CELL > this.bank.base + this.bank.size) {
      throw new StackUnderflowError('data stack underflow');
    }
    const value = this.arena.readCell(this.sp);
    this.sp += CELL;
    return value;
  }

  peek(depthFromTop = 0): number {
    const addr = this.sp + depthFromTop * CELL;
    if (addr + CELL > this.bank.base + this.bank.size) {
      throw new StackUnderflowError('data stack underflow');
    }
    return this.arena.readCell(addr);
  }

  /** Snapshot top-to-bottom, for UI/debugging use only. */
  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.depth; i++) {
      out.push(this.peek(i));
    }
    return out;
  }
}
