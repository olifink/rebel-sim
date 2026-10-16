/**
 * The host-supplied half of the screen module (FORTH-ARCHITECTURE.md
 * §7's HAL boundary): the engine's Screen class (packages/engine)
 * decides *what* to draw and calls this on every write-through; this
 * class is the only place that actually touches a <canvas>. Mirrors
 * Rebel-ROM's CScreenModule::BlitGlyph/Cls pixel-for-pixel — fill the
 * cell in `paper`, then draw the glyph's set pixels in `ink`.
 *
 * M59: glyph data is read from the arena's FONT bank (via the FONT
 * sysvar group's FONT-BASE field, spec/03-SYSVARS.md §8) instead of a
 * compiled-in font-zxspectrum.ts array — `attach()` supplies the
 * `Arena`/`Sysvars` references this class can't have at construction
 * time (it's built before the `Machine` that owns them; see app.ts's
 * `constructMachine()`). Geometry (8x8, 256 chars, 1 byte/row) stays a
 * local constant — no concrete need yet to sysvar-ize it.
 */

import { Arena, ScreenHal, Sysvars, blitSpriteRgba } from '@rebel-sim/engine';

const FONT_WIDTH = 8;
const FONT_HEIGHT = 8;
const FONT_FIRST_CHAR = 0x00;
const FONT_LAST_CHAR = 0xff;

function toCssColor(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

export class CanvasScreenHal implements ScreenHal {
  private arena: Arena | undefined;
  private sysvars: Sysvars | undefined;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  /** Called once, right after the owning `Machine` is constructed (and
   * therefore after its FONT bank/FONT-BASE sysvar exist) — before
   * anything can possibly call blitGlyph(). See app.ts's
   * `constructMachine()`. */
  attach(arena: Arena, sysvars: Sysvars): void {
    this.arena = arena;
    this.sysvars = sysvars;
  }

  blitGlyph(col: number, row: number, charCode: number, ink: number, paper: number): void {
    const x = col * FONT_WIDTH;
    const y = row * FONT_HEIGHT;

    this.ctx.fillStyle = toCssColor(paper);
    this.ctx.fillRect(x, y, FONT_WIDTH, FONT_HEIGHT);

    if (charCode < FONT_FIRST_CHAR || charCode > FONT_LAST_CHAR || !this.arena || !this.sysvars) {
      return; // outside the font's range (including space) — blank cell
    }

    const fontBase = this.sysvars.get('FONT', 'FONT-BASE');
    const glyphOffset = fontBase + (charCode - FONT_FIRST_CHAR) * FONT_HEIGHT;

    this.ctx.fillStyle = toCssColor(ink);
    for (let ry = 0; ry < FONT_HEIGHT; ry++) {
      const bits = this.arena.readByte(glyphOffset + ry);
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

  drawPixel(x: number, y: number, color: number): void {
    this.ctx.fillStyle = toCssColor(color);
    this.ctx.fillRect(x, y, 1, 1);
  }

  readPixel(x: number, y: number): number {
    const [r, g, b] = this.ctx.getImageData(x, y, 1, 1).data;
    return (r << 16) | (g << 8) | b;
  }

  /** spec/01-HAL.md §3.8's `hal_blit_sprite` (M84): reads back only the
   * clipped destination rectangle, draws into it with the engine's
   * reference blitter (transparency, flips), and writes it back. */
  blitSprite(
    x: number,
    y: number,
    pixels: Uint8Array,
    width: number,
    height: number,
    palette: Uint32Array,
    flags: number,
  ): void {
    const { width: w, height: h } = this.ctx.canvas;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(w, x + width);
    const y1 = Math.min(h, y + height);
    if (x0 >= x1 || y0 >= y1) return;
    const image = this.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    blitSpriteRgba(image.data, x1 - x0, y1 - y0, x - x0, y - y0, pixels, width, height, palette, flags);
    this.ctx.putImageData(image, x0, y0);
  }
}
