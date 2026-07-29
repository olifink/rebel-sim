/**
 * Thin accessors over the SYSV bank's FORTH group (FORTH-ARCHITECTURE.md
 * §4). Forth words only ever read/write sysvars through @ / ! — this
 * class is that boundary for the engine's own internal use (e.g. the
 * outer interpreter reading BASE/STATE), not a new mechanism.
 */

import { Arena } from './arena.js';
import { Bank } from './banks.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const FORTH = opcodes.sysvarGroups.FORTH;

export class Sysvars {
  constructor(
    private readonly arena: Arena,
    private readonly sysvBank: Bank,
  ) {}

  private offset(field: keyof typeof FORTH.fields): number {
    return this.sysvBank.base + FORTH.baseOffset + FORTH.fields[field].offset;
  }

  getBase(): number {
    return this.arena.readCell(this.offset('BASE'));
  }

  setBase(value: number): void {
    this.arena.writeCell(this.offset('BASE'), value);
  }

  getState(): number {
    return this.arena.readCell(this.offset('STATE'));
  }

  setState(value: number): void {
    this.arena.writeCell(this.offset('STATE'), value);
  }
}
