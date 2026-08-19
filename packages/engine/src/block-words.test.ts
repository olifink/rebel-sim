import { describe, expect, it } from 'vitest';
import { bootMachine } from './test-support.js';
import { BLOCK_SIZE } from './banks.js';

describe('BLOCK / BUFFER / UPDATE / FLUSH (system.fth, FORTH-ARCHITECTURE.md §7 follow-up)', () => {
  it('BLOCK returns the same address on a repeated call for the same block (cache hit)', () => {
    const m = bootMachine();
    m.interpret('3 BLOCK');
    const first = m.stack.pop();
    m.interpret('3 BLOCK');
    const second = m.stack.pop();
    expect(second).toBe(first);
  });

  it('BLOCK returns distinct addresses for distinct blocks', () => {
    const m = bootMachine();
    m.interpret('0 BLOCK');
    const a = m.stack.pop();
    m.interpret('1 BLOCK');
    const b = m.stack.pop();
    expect(a).not.toBe(b);
  });

  it('a byte written into a BLOCK buffer is readable through a later BLOCK call for the same block, before any FLUSH', () => {
    const m = bootMachine();
    m.interpret('2 BLOCK');
    const addr = m.stack.pop();
    m.arena.writeByte(addr, 0x42);

    m.interpret('2 BLOCK');
    const addr2 = m.stack.pop();
    expect(m.arena.readByte(addr2)).toBe(0x42);
  });

  it('UPDATE + FLUSH persists a modified buffer into the resident BLKS bank', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');

    m.interpret('4 BLOCK');
    const addr = m.stack.pop();
    m.arena.writeByte(addr, 0x99);
    // Before UPDATE/FLUSH, BLKS's own bytes for block 4 are untouched —
    // still the space (32) every screen is natively blank-filled with,
    // not a raw zero byte (Screen Editor follow-up, repl.ts).
    expect(m.arena.readByte(blks.base + 4 * BLOCK_SIZE)).toBe(32);

    m.interpret('UPDATE FLUSH');
    expect(m.arena.readByte(blks.base + 4 * BLOCK_SIZE)).toBe(0x99);
  });

  it('without UPDATE, FLUSH does not persist a buffer change (no dirty flag set)', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');

    m.interpret('5 BLOCK');
    const addr = m.stack.pop();
    m.arena.writeByte(addr, 0x77);
    m.interpret('FLUSH');

    expect(m.arena.readByte(blks.base + 5 * BLOCK_SIZE)).toBe(32);
  });

  it('BLOCK loads real BLKS content on a genuine miss (round-trips through the native primitives)', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');
    m.arena.writeByte(blks.base + 6 * BLOCK_SIZE, 0x55);

    m.interpret('6 BLOCK');
    const addr = m.stack.pop();
    expect(m.arena.readByte(addr)).toBe(0x55);
  });

  it('BUFFER does not require a real BLKS read: writing straight into it and FLUSHing round-trips correctly regardless of prior BLKS content', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');
    m.arena.writeByte(blks.base + 7 * BLOCK_SIZE, 0xff); // stale/irrelevant prior content

    m.interpret('7 BUFFER');
    const addr = m.stack.pop();
    m.arena.writeByte(addr, 0x11);
    m.interpret('UPDATE FLUSH');

    expect(m.arena.readByte(blks.base + 7 * BLOCK_SIZE)).toBe(0x11);
  });

  it('a fresh FLUSH with nothing ever touched is a safe no-op', () => {
    const m = bootMachine();
    expect(() => m.interpret('FLUSH')).not.toThrow();
  });

  it('round-robin eviction: the 5th distinct block reuses the oldest slot and flushes it first if dirty', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');

    // Fill all 4 buffer slots with blocks 0-3, dirtying each.
    for (let n = 0; n < 4; n++) {
      m.interpret(`${n} BLOCK`);
      const addr = m.stack.pop();
      m.arena.writeByte(addr, 0x10 + n);
      m.interpret('UPDATE');
    }

    // A 5th distinct block (8) forces eviction of slot 0 (block 0, the
    // oldest-assigned, round-robin) -- its dirty content must be written
    // back automatically, without an explicit FLUSH.
    m.interpret('8 BLOCK');
    m.stack.pop();

    expect(m.arena.readByte(blks.base + 0 * BLOCK_SIZE)).toBe(0x10);
    // Blocks 1-3 are still buffered (never evicted), so BLKS itself is
    // still untouched for them until an explicit FLUSH — still the
    // native space-fill, not a raw zero byte.
    expect(m.arena.readByte(blks.base + 1 * BLOCK_SIZE)).toBe(32);
  });

  it('BLOCK on an out-of-range block number throws via the underlying native bounds check', () => {
    const m = bootMachine();
    expect(() => m.interpret('16 BLOCK')).toThrow(/block 16 out of range \(0\.\.15\)/);
  });

  it('internal plumbing words are hidden from WORDS/FIND, but BLOCK/BUFFER/UPDATE/FLUSH are not', () => {
    const m = bootMachine();
    expect(() => m.interpret("' BUF-BLOCK#")).toThrow(/unrecognized word/i);
    expect(() => m.interpret("' EVICT-SLOT")).toThrow(/unrecognized word/i);
    expect(() => m.interpret("' BLOCK")).not.toThrow();
    expect(() => m.interpret("' BUFFER")).not.toThrow();
    expect(() => m.interpret("' UPDATE")).not.toThrow();
    expect(() => m.interpret("' FLUSH")).not.toThrow();
  });
});
