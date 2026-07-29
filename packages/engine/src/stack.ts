/**
 * A cell stack against any bank (DSTK or RSTK — same growth/bounds rules
 * for both, FORTH-ARCHITECTURE.md §3). Grows down within its own bank,
 * bounds-checked against that bank's own size. `sp` starts at
 * `bank.base + bank.size` (empty) and decreases toward `bank.base` as
 * cells are pushed.
 */

import { Arena, CELL_SIZE as CELL } from './arena.js';
import { Bank } from './banks.js';

export class StackUnderflowError extends Error {}
export class StackOverflowError extends Error {}

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
      throw new StackOverflowError(`${this.bank.tag} stack overflow`);
    }
    this.sp = next;
    this.arena.writeCell(this.sp, value);
  }

  pop(): number {
    if (this.sp + CELL > this.bank.base + this.bank.size) {
      throw new StackUnderflowError(`${this.bank.tag} stack underflow`);
    }
    const value = this.arena.readCell(this.sp);
    this.sp += CELL;
    return value;
  }

  peek(depthFromTop = 0): number {
    const addr = this.sp + depthFromTop * CELL;
    if (addr + CELL > this.bank.base + this.bank.size) {
      throw new StackUnderflowError(`${this.bank.tag} stack underflow`);
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
