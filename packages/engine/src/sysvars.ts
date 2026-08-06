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

  /** DEVELOPING.md §8: the raw arena address of a sysvar cell — public
   * so a primitive like LATEST-ADDR can expose it to Forth for direct
   * @/! manipulation (VOCABULARY/USE), the same way real Forth systems
   * usually treat HERE/LATEST/STATE/BASE as ordinary variables rather
   * than read-only accessors. */
  fieldOffset(group: GroupName, field: string): number {
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

  /** The current project's 8-char name (`spec/03-SYSVARS.md` §10),
   * NUL-padded ASCII packed 4-per-cell across `PROJECT-NAME-0/1` — the
   * same in-arena convention `mmap.ts` uses for bank `tag`/`name`, not
   * Rebel-ROM's on-disk space-padded FAT-8.3 convention (a different
   * layer). Empty string = unnamed project (all-zero cells, the fresh-
   * boot default). */
  getProjectName(): string {
    const c0 = this.getUnsigned('STORAGE', 'PROJECT-NAME-0');
    const c1 = this.getUnsigned('STORAGE', 'PROJECT-NAME-1');
    let out = '';
    for (const cell of [c0, c1]) {
      for (let i = 0; i < 4; i++) {
        const code = (cell >>> (i * 8)) & 0xff;
        if (code === 0) return out;
        out += String.fromCharCode(code);
      }
    }
    return out;
  }

  setProjectName(name: string): void {
    const truncated = name.slice(0, 8);
    const cells = [0, 0];
    for (let i = 0; i < truncated.length; i++) {
      const cellIndex = i < 4 ? 0 : 1;
      const byteIndex = i % 4;
      cells[cellIndex] |= truncated.charCodeAt(i) << (byteIndex * 8);
    }
    this.setUnsigned('STORAGE', 'PROJECT-NAME-0', cells[0] >>> 0);
    this.setUnsigned('STORAGE', 'PROJECT-NAME-1', cells[1] >>> 0);
  }
}
