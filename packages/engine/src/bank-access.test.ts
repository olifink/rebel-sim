import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('BANK@ (DEVELOPING.md §10, M18)', () => {
  it('resolves a known bank tag to the same base address findBank() reports', () => {
    const m = new Machine();
    const sysv = m.banks.findBank('SYSV')!;

    m.interpret('BANK@ SYSV');
    expect(m.stack.toArray()).toEqual([sysv.base]);
  });

  it('is case-insensitive, matching findWord/CREATE convention', () => {
    const m = new Machine();
    const dict = m.banks.findBank('DICT')!;

    m.interpret('BANK@ dict');
    expect(m.stack.toArray()).toEqual([dict.base]);
  });

  it('reaches every bank tag Machine creates, not just a subset', () => {
    for (const bank of new Machine().banks.getAllBanks()) {
      const m = new Machine();
      m.interpret(`BANK@ ${bank.tag}`);
      expect(m.stack.toArray()).toEqual([bank.base]);
    }
  });

  it('throws on an unknown tag, same convention as \' on an unrecognized word', () => {
    const m = new Machine();
    expect(() => m.interpret('BANK@ NOPE')).toThrow('? unknown bank: NOPE');
  });

  it('resolves the first-created bank when a tag repeats, matching findBank(tag) semantics', () => {
    const m = new Machine();
    m.banks.createBank('DATA', 4096, 'FIRST');
    m.banks.createBank('DATA', 4096, 'SECOND');
    const first = m.banks.findBank('DATA')!;

    m.interpret('BANK@ DATA');
    expect(m.stack.toArray()).toEqual([first.base]);
    expect(first.name).toBe('FIRST');
  });

  it('reaches a sysvar cell via its known bank base + group/field offset, from pure Forth source', () => {
    const m = new Machine();
    const stateAddr = m.sysvars.fieldOffset('FORTH', 'STATE');
    const sysv = m.banks.findBank('SYSV')!;
    const offset = stateAddr - sysv.base;

    m.interpret(`BANK@ SYSV ${offset} + @`);
    expect(m.stack.toArray()).toEqual([m.sysvars.getState()]);
  });

  it('CORE.ARENA-SIZE reports the real arena size, reachable the same way', () => {
    const m = new Machine();
    const arenaSizeAddr = m.sysvars.fieldOffset('CORE', 'ARENA-SIZE');
    const sysv = m.banks.findBank('SYSV')!;
    const offset = arenaSizeAddr - sysv.base;

    m.interpret(`BANK@ SYSV ${offset} + @`);
    expect(m.stack.toArray()).toEqual([m.arena.sizeBytes]);
  });
});
