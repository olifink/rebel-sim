/**
 * The host-supplied half of the screen module (FORTH-ARCHITECTURE.md
 * §7's HAL boundary): the engine's Screen class (packages/engine)
 * decides *what* to draw and calls this on every write-through; this
 * class is the only place that actually touches a <canvas>. Mirrors
 * Rebel-ROM's CScreenModule::BlitGlyph/Cls pixel-for-pixel — fill the
 * cell in `paper`, then draw the glyph's set pixels in `ink` — using the
 * ZX Spectrum font bitmap ported in font-zxspectrum.ts.
 */

import { ScreenHal } from '@rebel-sim/engine';
import { FONT_HEIGHT, FONT_WIDTH, glyphRows } from './font-zxspectrum.js';

function toCssColor(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

export class CanvasScreenHal implements ScreenHal {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  blitGlyph(col: number, row: number, charCode: number, ink: number, paper: number): void {
    const x = col * FONT_WIDTH;
    const y = row * FONT_HEIGHT;

    this.ctx.fillStyle = toCssColor(paper);
    this.ctx.fillRect(x, y, FONT_WIDTH, FONT_HEIGHT);

    const rows = glyphRows(charCode);
    if (!rows) {
      return; // outside the font's range (including space) — blank cell
    }

    this.ctx.fillStyle = toCssColor(ink);
    for (let ry = 0; ry < FONT_HEIGHT; ry++) {
      const bits = rows[ry];
      for (let rx = 0; rx < FONT_WIDTH; rx++) {
        if (bits & (0x80 >> rx)) {
          this.ctx.fillRect(x + rx, y + ry, 1, 1);
        }
      }
    }
  }

  clearScreen(paper: number): void {
    this.ctx.fillStyle = toCssColor(paper);
    this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
  }
}
