/**
 * A cell stack against any bank (DSTK or RSTK — same growth/bounds rules
 * for both, FORTH-ARCHITECTURE.md §3). Grows down within its own bank,
 * bounds-checked against that bank's own size. `sp` starts at
 * `bank.base + bank.size` (empty) and decreases toward `bank.base` as
 * cells are pushed.
 *
 * DEVELOPING.md §21: the live pointer lives in a `FORTH` sysvar cell
 * (`liveField`), not a private field — `Sysvars` is the one real place
 * this state lives, the same "no engine-side copy" rule `HERE`/`LATEST`/
 * `BASE`/`STATE` already follow. `baseField` (`SP0`/`RP0`) holds the
 * constant empty-stack address, written once here and never mutated
 * again.
 */

import { Arena, CELL_SIZE as CELL } from './arena.js';
import { Bank } from './banks.js';
import { Sysvars } from './sysvars.js';

export class StackUnderflowError extends Error {}
export class StackOverflowError extends Error {}

export class DataStack {
  constructor(
    private readonly arena: Arena,
    private readonly bank: Bank,
    private readonly sysvars: Sysvars,
    private readonly baseField: 'SP0' | 'RP0',
    private readonly liveField: 'SP' | 'RP',
  ) {
    const empty = bank.base + bank.size;
    sysvars.setUnsigned('FORTH', baseField, empty);
    sysvars.setUnsigned('FORTH', liveField, empty);
  }

  private get sp(): number {
    return this.sysvars.getUnsigned('FORTH', this.liveField);
  }

  private set sp(value: number) {
    this.sysvars.setUnsigned('FORTH', this.liveField, value);
  }

  /** DEVELOPING.md §21: the only way outside code (SP@/RP@'s
   * primitives) reaches the live pointer — `sp` itself stays private. */
  getPointer(): number {
    return this.sp;
  }

  setPointer(addr: number): void {
    this.sp = addr;
  }

  get depth(): number {
    return (this.bank.base + this.bank.size - this.sp) / CELL;
  }

  /** DEVELOPING.md §9, M17: empties the stack — `ABORT`'s own effect,
   * and `replLoop`'s recovery from any uncaught error (both data stack
   * and, separately, `rstack` — the same fix, applied to whichever
   * `DataStack` instance it's called on). Doesn't touch the underlying
   * arena bytes, only `sp` — same "popped values aren't cleared, just
   * abandoned" contract `pop()` already has. */
  clear(): void {
    this.sp = this.bank.base + this.bank.size;
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
