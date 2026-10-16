/**
 * Sprites and tiles (spec/13-GAME-LOOP.md §6, 11-SPRITE-BANK.md,
 * 01-HAL.md §3.8; M84).
 *
 * `drawSprite` is the portable layer 01-HAL §3.8 describes: it finds
 * entry `n` of the bank at `SPRITE-BASE`, validates everything, and hands
 * the HAL one resolved bitmap. `blitSpriteRgba` is a reference software
 * implementation of `hal_blit_sprite` itself, over an RGBA pixel buffer,
 * for hosts that draw into one (the app's canvas HAL).
 */

import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { Sysvars } from './sysvars.js';
import { ScreenHal } from './screen.js';

const HEADER = 8; // 'S','P', version, reserved, entry count
const PALETTE = 64; // 16 x 0xRRGGBB
const ENTRY_HEADER = 4; // width, height, flags, reserved

/** Draws entry `n` of the active sprite bank with its top-left corner at
 * pixel `(x, y)`, or nothing at all if there is no active bank, it is not
 * a valid `SPRT` bank, `n` is out of range, or the entry runs past the
 * end of the bank. Entry offsets are computed on each call (a sum over
 * the entries before `n`), never cached, so reloading a sheet into the
 * same bank can never leave them stale (11-SPRITE-BANK.md). */
export function drawSprite(
  arena: Arena,
  banks: BankTable,
  sysvars: Sysvars,
  hal: ScreenHal,
  x: number,
  y: number,
  n: number,
): void {
  if (!hal.blitSprite) return;
  const base = sysvars.getUnsigned('SPRITE', 'SPRITE-BASE');
  if (base === 0) return;
  const bank = banks.getAllBanks().find((b) => b.base === base && b.tag === 'SPRT');
  if (!bank || bank.size < HEADER + PALETTE) return;
  if (arena.readByte(base) !== 0x53 || arena.readByte(base + 1) !== 0x50 || arena.readByte(base + 2) !== 1) return;
  const count = arena.readCell(base + 4);
  if (n < 0 || n >= count) return;
  const end = base + bank.size;
  const entries = base + HEADER + PALETTE;
  if (entries + count * ENTRY_HEADER > end) return;

  let offset = entries + count * ENTRY_HEADER;
  for (let i = 0; i < n; i++) {
    offset += (arena.readByte(entries + i * ENTRY_HEADER) >> 1) * arena.readByte(entries + i * ENTRY_HEADER + 1);
  }
  const width = arena.readByte(entries + n * ENTRY_HEADER);
  const height = arena.readByte(entries + n * ENTRY_HEADER + 1);
  const flags = arena.readByte(entries + n * ENTRY_HEADER + 2) & 3;
  if (width === 0 || height === 0 || width % 8 !== 0 || height % 8 !== 0) return;
  const size = (width >> 1) * height;
  if (offset + size > end) return;

  const palette = new Uint32Array(16);
  for (let i = 0; i < 16; i++) palette[i] = arena.readCellUnsigned(base + HEADER + i * 4) & 0xffffff;
  // A resolved byte span (01-HAL.md §2.1): a view, valid for this call only.
  hal.blitSprite(x, y, new Uint8Array(arena.buffer, offset, size), width, height, palette, flags);
}

/** A software `hal_blit_sprite` (01-HAL.md §3.8) into an RGBA buffer of
 * `targetWidth` x `targetHeight` pixels: 4bpp source, high nibble left;
 * index 0 transparent; H-FLIP (bit 0) and V-FLIP (bit 1) by walking the
 * source in reverse; clipped to the target. */
export function blitSpriteRgba(
  target: Uint8ClampedArray,
  targetWidth: number,
  targetHeight: number,
  x: number,
  y: number,
  pixels: Uint8Array,
  width: number,
  height: number,
  palette: ArrayLike<number>,
  flags: number,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(targetWidth, x + width);
  const y1 = Math.min(targetHeight, y + height);
  const rowBytes = width >> 1;
  for (let dy = y0; dy < y1; dy++) {
    const sy = flags & 2 ? height - 1 - (dy - y) : dy - y;
    for (let dx = x0; dx < x1; dx++) {
      const sx = flags & 1 ? width - 1 - (dx - x) : dx - x;
      const byte = pixels[sy * rowBytes + (sx >> 1)];
      const index = sx & 1 ? byte & 0x0f : byte >> 4;
      if (index === 0) continue;
      const color = palette[index];
      const i = (dy * targetWidth + dx) * 4;
      target[i] = (color >> 16) & 0xff;
      target[i + 1] = (color >> 8) & 0xff;
      target[i + 2] = color & 0xff;
      target[i + 3] = 0xff;
    }
  }
}
