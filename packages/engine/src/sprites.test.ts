import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Machine } from './repl.js';
import { ScreenHal, NULL_SCREEN_HAL } from './screen.js';
import { blitSpriteRgba } from './sprites.js';
import { bootMachine } from './test-support.js';

interface Blit {
  x: number;
  y: number;
  pixels: number[];
  width: number;
  height: number;
  palette: number[];
  flags: number;
}

function recordingHal(): { hal: ScreenHal; blits: Blit[] } {
  const blits: Blit[] = [];
  const hal: ScreenHal = {
    ...NULL_SCREEN_HAL,
    blitSprite(x, y, pixels, width, height, palette, flags) {
      blits.push({ x, y, pixels: [...pixels], width, height, palette: [...palette], flags });
    },
  };
  return { hal, blits };
}

/** Writes a sprite bank: the 'S','P' header, a palette where color i is
 * 0x101010 * i, the entry headers, and each entry's pixels filled with
 * the byte `fill`. Returns its base. */
function sheet(m: Machine, entries: { w: number; h: number; flags?: number; fill: number }[], name = 'SHEET'): number {
  const bank = m.banks.createBank('SPRT', 4096, name);
  const b = bank.base;
  [0x53, 0x50, 1, 0].forEach((v, i) => m.arena.writeByte(b + i, v));
  m.arena.writeCell(b + 4, entries.length);
  for (let i = 0; i < 16; i++) m.arena.writeCell(b + 8 + i * 4, 0x101010 * i);
  let at = b + 72 + entries.length * 4;
  entries.forEach((e, i) => {
    m.arena.writeByte(b + 72 + i * 4, e.w);
    m.arena.writeByte(b + 72 + i * 4 + 1, e.h);
    m.arena.writeByte(b + 72 + i * 4 + 2, e.flags ?? 0);
    for (let k = 0; k < (e.w / 2) * e.h; k++) m.arena.writeByte(at + k, e.fill);
    at += (e.w / 2) * e.h;
  });
  return b;
}

const SPRITE_BASE = (m: Machine): number => m.banks.findBankByName('SYSV')!.base + 256;

describe('SPRITE (M84, spec/13-GAME-LOOP.md §6, 01-HAL.md §3.8)', () => {
  it('draws entry n of the active bank at (x, y), finding it past the earlier entries', () => {
    const { hal, blits } = recordingHal();
    const m = new Machine({ screenHal: hal });
    const base = sheet(m, [
      { w: 8, h: 8, fill: 0x11 },
      { w: 16, h: 8, flags: 3, fill: 0x23 },
    ]);
    m.arena.writeCell(SPRITE_BASE(m), base);
    m.interpret('10 -4 1 SPRITE');
    expect(blits).toHaveLength(1);
    const b = blits[0];
    expect([b.x, b.y, b.width, b.height, b.flags]).toEqual([10, -4, 16, 8, 3]);
    expect(b.pixels).toHaveLength(64); // (16 / 2) * 8
    expect(b.pixels.every((v) => v === 0x23)).toBe(true); // entry 1, not entry 0's 0x11
    expect(b.palette[2]).toBe(0x202020);
  });

  it('draws nothing with no active bank, a non-SPRT bank, a bad header, or an index out of range', () => {
    const { hal, blits } = recordingHal();
    const m = new Machine({ screenHal: hal });
    const base = sheet(m, [{ w: 8, h: 8, fill: 1 }]);
    m.interpret('0 0 0 SPRITE'); // SPRITE-BASE is 0
    m.arena.writeCell(SPRITE_BASE(m), m.banks.findBankByName('DICT')!.base);
    m.interpret('0 0 0 SPRITE'); // not an SPRT bank
    m.arena.writeCell(SPRITE_BASE(m), base);
    m.interpret('0 0 1 SPRITE 0 0 -1 SPRITE'); // past the count, negative
    m.arena.writeByte(base, 0x58); // spoil the magic
    m.interpret('0 0 0 SPRITE');
    expect(blits).toHaveLength(0);
    expect(m.stack.toArray()).toEqual([]);
  });

  it('draws nothing for an entry that would run past the end of its bank', () => {
    const { hal, blits } = recordingHal();
    const m = new Machine({ screenHal: hal });
    const base = sheet(m, [{ w: 8, h: 8, fill: 1 }]);
    m.arena.writeByte(base + 72, 248); // 248 x 248 / 2 bytes cannot fit in 4 KiB
    m.arena.writeByte(base + 73, 248);
    m.arena.writeCell(SPRITE_BASE(m), base);
    m.interpret('0 0 0 SPRITE');
    expect(blits).toHaveLength(0);
  });

  it('TILE draws at a character cell, and SPRITE-BASE is settable from Forth', () => {
    const { hal, blits } = recordingHal();
    const m = bootMachine({ screenHal: hal });
    sheet(m, [{ w: 8, h: 8, fill: 1 }], 'TILES');
    m.interpret('BANK@ TILES SPRITE-BASE ! 3 2 0 TILE');
    expect([blits[0].x, blits[0].y]).toEqual([24, 16]);
  });
});

describe('blitSpriteRgba (the reference hal_blit_sprite)', () => {
  // An 8 x 8 sprite whose first row is indices 1,2,0,0,0,0,0,3 and the
  // rest transparent; color i is (i, i, i).
  const pixels = new Uint8Array(32);
  pixels.set([0x12, 0x00, 0x00, 0x03]);
  const palette = Array.from({ length: 16 }, (_, i) => (i << 16) | (i << 8) | i);
  const red = (buf: Uint8ClampedArray, w: number, x: number, y: number): number => buf[(y * w + x) * 4];

  it('puts the high nibble on the left and leaves index 0 untouched', () => {
    const buf = new Uint8ClampedArray(16 * 16 * 4).fill(99);
    blitSpriteRgba(buf, 16, 16, 2, 3, pixels, 8, 8, palette, 0);
    expect([red(buf, 16, 2, 3), red(buf, 16, 3, 3), red(buf, 16, 4, 3), red(buf, 16, 9, 3)]).toEqual([1, 2, 99, 3]);
    expect(red(buf, 16, 2, 4)).toBe(99); // second row: all transparent
  });

  it('flips horizontally and vertically by walking the source in reverse', () => {
    const buf = new Uint8ClampedArray(8 * 8 * 4);
    blitSpriteRgba(buf, 8, 8, 0, 0, pixels, 8, 8, palette, 1);
    expect([red(buf, 8, 0, 0), red(buf, 8, 6, 0), red(buf, 8, 7, 0)]).toEqual([3, 2, 1]);
    const vbuf = new Uint8ClampedArray(8 * 8 * 4);
    blitSpriteRgba(vbuf, 8, 8, 0, 0, pixels, 8, 8, palette, 2);
    expect([red(vbuf, 8, 0, 7), red(vbuf, 8, 0, 0)]).toEqual([1, 0]);
  });

  it('clips at every edge, including a sprite that starts off screen', () => {
    const buf = new Uint8ClampedArray(4 * 4 * 4);
    blitSpriteRgba(buf, 4, 4, -1, 0, pixels, 8, 8, palette, 0); // column 0 cut off
    expect(red(buf, 4, 0, 0)).toBe(2);
    expect(() => blitSpriteRgba(buf, 4, 4, 100, 100, pixels, 8, 8, palette, 0)).not.toThrow();
  });
});

describe('the reference sprite sheet (rebel-specs/references/rebel_rogue.SPR)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const appCopy = join(here, '../../app/public/rebel_rogue.SPR');
  const specCopy = join(here, '../../../rebel-specs/references/rebel_rogue.SPR');

  it("the app's copy matches the spec reference", () => {
    if (!existsSync(specCopy)) return; // checkout without the rebel-specs submodule
    expect(readFileSync(appCopy).equals(readFileSync(specCopy))).toBe(true);
  });

  it('loads as a SPRT bank and SPRITE draws every one of its 16 entries', () => {
    const file = new Uint8Array(readFileSync(appCopy));
    expect(String.fromCharCode(...file.subarray(0, 6))).toBe('RASPRT'); // project-asset header
    const payload = file.subarray(6);

    const target = new Uint8ClampedArray(64 * 64 * 4);
    const blits: Blit[] = [];
    const hal: ScreenHal = {
      ...NULL_SCREEN_HAL,
      blitSprite(x, y, pixels, width, height, palette, flags) {
        blits.push({ x, y, pixels: [...pixels], width, height, palette: [...palette], flags });
        blitSpriteRgba(target, 64, 64, x, y, pixels, width, height, palette, flags);
      },
    };
    const m = new Machine({ screenHal: hal });
    const bank = m.banks.createBank('SPRT', payload.length, 'ROGUE');
    m.arena.writeBytes(bank.base, payload);
    m.arena.writeCell(SPRITE_BASE(m), bank.base);

    for (let n = 0; n < 16; n++) m.interpret(`0 0 ${n} SPRITE`);
    expect(blits).toHaveLength(16);
    expect(blits.filter((b) => b.width === 16 && b.height === 16)).toHaveLength(9);
    expect(blits.filter((b) => b.width === 8 && b.height === 8)).toHaveLength(7);
    expect(blits[0].palette[1]).toBe(0x5d275d);
    m.interpret('0 0 16 SPRITE'); // one past the count: nothing
    expect(blits).toHaveLength(16);
    expect(target.some((v, i) => i % 4 === 3 && v === 255)).toBe(true); // real pixels drawn
  });
});
