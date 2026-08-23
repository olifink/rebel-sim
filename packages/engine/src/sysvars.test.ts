import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { Sysvars, listSysvars } from './sysvars.js';

function makeSysvars() {
  const arena = new Arena(1 << 16);
  const banks = new BankTable(arena);
  const sysvBank = banks.createBank('SYSV', 4096);
  const sysvars = new Sysvars(arena, sysvBank);
  sysvars.initHeader();
  return sysvars;
}

describe('Sysvars project name (spec/03-SYSVARS.md §10)', () => {
  it('is empty (unnamed project) on a fresh SYSV bank', () => {
    const sysvars = makeSysvars();
    expect(sysvars.getProjectName()).toBe('');
  });

  it('round-trips an 8-char name exactly', () => {
    const sysvars = makeSysvars();
    sysvars.setProjectName('REBELDEF');
    expect(sysvars.getProjectName()).toBe('REBELDEF');
  });

  it('round-trips a short name without trailing garbage', () => {
    const sysvars = makeSysvars();
    sysvars.setProjectName('FOO');
    expect(sysvars.getProjectName()).toBe('FOO');
  });

  it('truncates a name longer than 8 characters', () => {
    const sysvars = makeSysvars();
    sysvars.setProjectName('WAYTOOLONGNAME');
    expect(sysvars.getProjectName()).toBe('WAYTOOLO');
  });

  it('overwriting with a shorter name clears the old trailing bytes', () => {
    const sysvars = makeSysvars();
    sysvars.setProjectName('REBELDEF');
    sysvars.setProjectName('AB');
    expect(sysvars.getProjectName()).toBe('AB');
  });

  it('is individually addressable across both backing cells', () => {
    const sysvars = makeSysvars();
    sysvars.setProjectName('ABCDEFGH');
    expect(sysvars.getUnsigned('STORAGE', 'PROJECT-NAME-0')).toBe(
      ('A'.charCodeAt(0) | ('B'.charCodeAt(0) << 8) | ('C'.charCodeAt(0) << 16) | ('D'.charCodeAt(0) << 24)) >>> 0,
    );
    expect(sysvars.getUnsigned('STORAGE', 'PROJECT-NAME-1')).toBe(
      ('E'.charCodeAt(0) | ('F'.charCodeAt(0) << 8) | ('G'.charCodeAt(0) << 16) | ('H'.charCodeAt(0) << 24)) >>> 0,
    );
  });
});

describe('listSysvars (web-only monitor-panel support)', () => {
  it('lists only fields opcodes.json actually defines, skipping reserved/empty groups', () => {
    const sysvars = makeSysvars();
    const entries = listSysvars(sysvars);

    // FORTH.STATE is a real, populated field.
    expect(entries.some((e) => e.group === 'FORTH' && e.field === 'STATE')).toBe(true);
    // FONT.FONT-BASE is real now too (M59) — SPRITE is still reserved
    // with no fields yet (rebel-opcodes.json).
    expect(entries.some((e) => e.group === 'FONT' && e.field === 'FONT-BASE')).toBe(true);
    expect(entries.some((e) => e.group === 'SPRITE')).toBe(false);
  });

  it('reads each field\'s live current value, not a cached snapshot', () => {
    const sysvars = makeSysvars();
    sysvars.setBase(16);

    const entries = listSysvars(sysvars);

    const base = entries.find((e) => e.group === 'FORTH' && e.field === 'BASE');
    expect(base?.value).toBe(16);
  });

  it('carries each field\'s rebel-opcodes.json note through for a tooltip', () => {
    const sysvars = makeSysvars();
    const entries = listSysvars(sysvars);

    const state = entries.find((e) => e.group === 'FORTH' && e.field === 'STATE');
    expect(state?.note).toContain('compiling');
  });
});
