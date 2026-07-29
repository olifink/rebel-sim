import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';

describe('Arena', () => {
  it('round-trips cells as little-endian', () => {
    const arena = new Arena(16);
    arena.writeCell(0, 0x01020304);
    // Little-endian: least-significant byte first.
    expect(arena.readByte(0)).toBe(0x04);
    expect(arena.readByte(1)).toBe(0x03);
    expect(arena.readByte(2)).toBe(0x02);
    expect(arena.readByte(3)).toBe(0x01);
    expect(arena.readCell(0)).toBe(0x01020304);
  });

  it('round-trips negative cells via two-s complement', () => {
    const arena = new Arena(16);
    arena.writeCell(0, -1);
    expect(arena.readCell(0)).toBe(-1);
    expect(arena.readCellUnsigned(0)).toBe(0xffffffff);
  });

  it('rejects sizes above the 32-bit addressable ceiling', () => {
    expect(() => new Arena(0x1_0000_0001)).toThrow(RangeError);
  });
});
