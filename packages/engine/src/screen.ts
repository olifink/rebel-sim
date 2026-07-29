/**
 * The screen module: one framebuffer, always graphics, with a character
 * grid (the CHAR bank) pushed one-directionally into it on write
 * (docs/SCREEN-MODULE.md §1/§5 in the Rebel-ROM reference — this class
 * mirrors CScreenModule as closely as Rebel-Sim's cell-based sysvars
 * allow: same field names, same wrap-only cursor behavior, same
 * silent-bounds-check-not-throw shape).
 *
 * The engine never touches a canvas directly (packages/engine has zero
 * DOM dependencies) — actual pixel drawing is delegated to a
 * host-supplied ScreenHal, called synchronously on every write-through.
 * Tests (and any headless use) get NULL_SCREEN_HAL for free; the
 * Angular app supplies a real canvas-backed one.
 */

import { Arena } from './arena.js';
import { Bank } from './banks.js';
import { Sysvars } from './sysvars.js';

export interface ScreenHal {
  /** Paints one glyph cell: fill the cell with `paper`, then draw the
   * character's foreground pixels in `ink` (CScreenModule::BlitGlyph). */
  blitGlyph(col: number, row: number, charCode: number, ink: number, paper: number): void;
  /** Clears the whole framebuffer to `paper` (CScreenModule::Cls). */
  clearScreen(paper: number): void;
}

export const NULL_SCREEN_HAL: ScreenHal = {
  blitGlyph(): void {},
  clearScreen(): void {},
};

const SPACE = 32;
const CR = 13;
const LF = 10;

export class Screen {
  readonly cols: number;
  readonly rows: number;

  constructor(
    private readonly arena: Arena,
    private readonly charBank: Bank,
    private readonly sysvars: Sysvars,
    private readonly hal: ScreenHal = NULL_SCREEN_HAL,
  ) {
    // Cached at construction — Rebel-Sim has no runtime mode-change
    // mechanism yet (docs/SCREEN-MODULE.md §9's "mode-change ownership:
    // deferred" applies here too), so these are effectively boot-fixed.
    this.cols = sysvars.get('SCREEN', 'CHAR-COLS');
    this.rows = sysvars.get('SCREEN', 'CHAR-ROWS');
  }

  private charAddress(col: number, row: number): number {
    return this.charBank.base + row * this.cols + col;
  }

  private inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  getCursorCol(): number {
    return this.sysvars.get('CORE', 'CURSOR-X');
  }

  getCursorRow(): number {
    return this.sysvars.get('CORE', 'CURSOR-Y');
  }

  /** No bounds-checking, matching CScreenModule::SetCursor — an
   * out-of-range cursor self-corrects on the next emit() via
   * advanceCursor()'s wrap. */
  setCursor(col: number, row: number): void {
    this.sysvars.set('CORE', 'CURSOR-X', col);
    this.sysvars.set('CORE', 'CURSOR-Y', row);
  }

  getInk(): number {
    return this.sysvars.get('SCREEN', 'INK');
  }

  setInk(color: number): void {
    this.sysvars.set('SCREEN', 'INK', color);
  }

  getPaper(): number {
    return this.sysvars.get('SCREEN', 'PAPER');
  }

  setPaper(color: number): void {
    this.sysvars.set('SCREEN', 'PAPER', color);
  }

  /** CHAR! — writes the CHAR bank cell and blits the glyph. Out-of-range
   * coordinates are silently ignored (matches WriteChar). */
  writeChar(
    col: number,
    row: number,
    charCode: number,
    ink: number = this.getInk(),
    paper: number = this.getPaper(),
  ): void {
    if (!this.inBounds(col, row)) {
      return;
    }
    const code = charCode & 0xff;
    this.arena.writeByte(this.charAddress(col, row), code);
    this.hal.blitGlyph(col, row, code, ink, paper);
  }

  /** CHAR@ — reads the CHAR bank directly, no framebuffer involved.
   * Out-of-range coordinates return a space (matches ReadChar). */
  readChar(col: number, row: number): number {
    if (!this.inBounds(col, row)) {
      return SPACE;
    }
    return this.arena.readByte(this.charAddress(col, row));
  }

  private advanceCursor(): void {
    let col = this.getCursorCol() + 1;
    let row = this.getCursorRow();
    if (col >= this.cols) {
      col = 0;
      row++;
    }
    // Wrap only, no scroll (docs/SCREEN-MODULE.md §7): bottom row wraps
    // back to row 0, overwriting existing content.
    if (row >= this.rows) {
      row = 0;
    }
    this.setCursor(col, row);
  }

  /** EMIT — streams one raw character code. \r/\n are handled as cursor
   * control here (matching CScreenModule::Emit exactly), not blitted as
   * glyphs; anything else is written at the cursor and advances it. */
  emit(charCode: number): void {
    const code = charCode & 0xff;

    if (code === CR) {
      this.setCursor(0, this.getCursorRow());
      return;
    }
    if (code === LF) {
      let row = this.getCursorRow() + 1;
      if (row >= this.rows) {
        row = 0;
      }
      this.setCursor(0, row);
      return;
    }

    this.writeChar(this.getCursorCol(), this.getCursorRow(), code);
    this.advanceCursor();
  }

  /** CLS — fills the CHAR bank with spaces, clears the framebuffer to
   * the current PAPER, resets the cursor to 0,0. */
  cls(): void {
    for (let i = 0; i < this.charBank.size; i++) {
      this.arena.writeByte(this.charBank.base + i, SPACE);
    }
    this.setCursor(0, 0);
    this.hal.clearScreen(this.getPaper());
  }

  /** Reads one row as a plain string — a diagnostics/test convenience,
   * not something Rebel-ROM exposes (no string type at this layer). */
  readRowText(row: number): string {
    let s = '';
    for (let col = 0; col < this.cols; col++) {
      s += String.fromCharCode(this.readChar(col, row));
    }
    return s;
  }
}
