/**
 * Accessors over the SYSV bank's grouped sysvar layout
 * (FORTH-ARCHITECTURE.md §4, matching src/sysvars.h's real group
 * offsets — see rebel-opcodes.json's header note). Forth words only
 * ever read/write sysvars through @ / ! — this class is that boundary
 * for the engine's own internal use (e.g. the outer interpreter reading
 * BASE/STATE), not a new mechanism.
 *
 * One deliberate divergence from Rebel-ROM: every field here is a full
 * 4-byte cell, not a packed byte/u16 C struct — so group-level offsets
 * match src/sysvars.h, field-level offsets within a group don't.
 */

import { Arena } from './arena.js';
import { Bank } from './banks.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

type SysvarGroups = typeof opcodes.sysvarGroups;
type GroupName = keyof SysvarGroups;

// Matches src/sysvars.h's TSysVarsHeader: 'S','V', version 1, reserved.
const HEADER_MAGIC_0 = 'S'.charCodeAt(0);
const HEADER_MAGIC_1 = 'V'.charCodeAt(0);
const HEADER_VERSION = 1;

export class Sysvars {
  constructor(
    private readonly arena: Arena,
    private readonly sysvBank: Bank,
  ) {}

  /** Writes the SYSV bank's sanity-check header (src/sysvars.h's
   * TSysVarsHeader) — a human/tooling-readable signature, not runtime
   * migration logic. Call once at boot. */
  initHeader(): void {
    const base = this.sysvBank.base;
    this.arena.writeByte(base + 0, HEADER_MAGIC_0);
    this.arena.writeByte(base + 1, HEADER_MAGIC_1);
    this.arena.writeByte(base + 2, HEADER_VERSION);
    this.arena.writeByte(base + 3, 0);
  }

  private fieldOffset(group: GroupName, field: string): number {
    const g = opcodes.sysvarGroups[group] as {
      baseOffset: number;
      fields: Record<string, { offset: number }>;
    };
    const f = g.fields[field];
    if (!f) {
      throw new Error(`unknown sysvar ${String(group)}.${field}`);
    }
    return this.sysvBank.base + g.baseOffset + f.offset;
  }

  get(group: GroupName, field: string): number {
    return this.arena.readCell(this.fieldOffset(group, field));
  }

  set(group: GroupName, field: string, value: number): void {
    this.arena.writeCell(this.fieldOffset(group, field), value);
  }

  getUnsigned(group: GroupName, field: string): number {
    return this.arena.readCellUnsigned(this.fieldOffset(group, field));
  }

  setUnsigned(group: GroupName, field: string, value: number): void {
    this.arena.writeCellUnsigned(this.fieldOffset(group, field), value);
  }

  getBase(): number {
    return this.get('FORTH', 'BASE');
  }

  setBase(value: number): void {
    this.set('FORTH', 'BASE', value);
  }

  getState(): number {
    return this.get('FORTH', 'STATE');
  }

  setState(value: number): void {
    this.set('FORTH', 'STATE', value);
  }

  getHere(): number {
    return this.getUnsigned('FORTH', 'HERE');
  }

  setHere(value: number): void {
    this.setUnsigned('FORTH', 'HERE', value);
  }

  getLatest(): number {
    return this.getUnsigned('FORTH', 'LATEST');
  }

  setLatest(value: number): void {
    this.setUnsigned('FORTH', 'LATEST', value);
  }
}
