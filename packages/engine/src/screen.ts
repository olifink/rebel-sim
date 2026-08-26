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

import { Arena, CELL_SIZE } from './arena.js';
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

// HAL boolean convention (FORTH-ARCHITECTURE.md §7): TRUE = -1, FALSE = 0.
const TRUE = -1;
const FALSE = 0;

export class Screen {
  readonly cols: number;
  readonly rows: number;

  constructor(
    private readonly arena: Arena,
    private readonly charBank: Bank,
    private readonly attrBank: Bank,
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

  /** Same addressing stride as charAddress() — ATTR is sized and laid
   * out exactly like CHAR (spec/02-MEMORY-MODEL.md §4.6). */
  private attrAddress(col: number, row: number): number {
    return this.attrBank.base + row * this.cols + col;
  }

  private inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  /** spec/01-HAL.md §3.6's color-resolution rule, the one rule both
   * write-side ink/paper resolution and ATTR decoding key off. `0` means
   * disabled (today's unmodified literal-RGB-only behavior); a target
   * with no palette concept simply never sets it away from that boot
   * default. */
  getPaletteBase(): number {
    return this.sysvars.get('SCREEN', 'PALETTE-BASE');
  }

  setPaletteBase(addr: number): void {
    this.sysvars.set('SCREEN', 'PALETTE-BASE', addr);
  }

  /** When `paletteBase` is non-zero and `v` is a valid index (0-15), the
   * real color is the 32-bit 0xRRGGBB cell at `paletteBase + v*4`.
   * Otherwise `v` is used directly as a literal color — exactly today's
   * unmodified behavior (spec/01-HAL.md §3.6). */
  private resolveColor(v: number, paletteBase: number): number {
    if (paletteBase !== 0 && v >= 0 && v <= 15) {
      return this.arena.readCell(paletteBase + v * CELL_SIZE);
    }
    return v;
  }

  getCursorCol(): number {
    return this.sysvars.get('CORE', 'CURSOR-X');
  }

  getCursorRow(): number {
    return this.sysvars.get('CORE', 'CURSOR-Y');
  }

  /** No bounds-checking, matching CScreenModule::SetCursor — an
   * out-of-range cursor self-corrects on the next emit() via
   * advanceCursor()'s wrap. DEVELOPING.md §17, M25: also the single
   * choke-point every cursor-movement path (AT-XY, EMIT's
   * auto-advance/CR/LF) already routes through, so the visible-cursor
   * redraw hooks in here once rather than at each call site.
   *
   * `redrawOldCell` (default true): skip only from advanceCursor(),
   * which calls this right after writeChar() already painted the cell
   * the cursor is leaving in its correct, normal colors. Redrawing it
   * again here from ATTR would be redundant at best, and — while a
   * palette is active — actively wrong for a literal RGB ink/paper
   * ATTR's 4-bit nibbles can't durably store (spec/01-HAL.md §3.6's
   * accepted limitation): it renders correctly via writeChar()'s direct
   * HAL call, then gets its low nibble reread back through the palette
   * on this very next tick, turning e.g. white into whatever color
   * happens to sit at that nibble's palette index. AT-XY and EMIT's
   * CR/LF, by contrast, move the cursor *without* writing first, so the
   * cell they're leaving genuinely is still showing its last redraw and
   * needs the normal un-invert. */
  setCursor(col: number, row: number, redrawOldCell = true): void {
    const oldCol = this.getCursorCol();
    const oldRow = this.getCursorRow();
    this.sysvars.set('CORE', 'CURSOR-X', col);
    this.sysvars.set('CORE', 'CURSOR-Y', row);
    if (this.isCursorVisible()) {
      if (redrawOldCell) {
        this.redrawCursorAt(oldCol, oldRow, false);
      }
      this.redrawCursorAt(col, row, true);
    }
  }

  private isCursorVisible(): boolean {
    return this.sysvars.get('SCREEN', 'CURSOR-VISIBLE') !== FALSE;
  }

  /** Re-blits a cell purely from its already-stored CHAR-bank content,
   * ink/paper swapped if `inverted` — never touches CHAR itself (this
   * is a redraw, not a write), matching CScreenModule::Redraw()'s own
   * "CHAR content is always enough to redraw correctly" precedent
   * (screenmodule.h). Silently no-ops out of range, same convention
   * writeChar()/readChar() already use.
   *
   * spec/01-HAL.md §3.6's redraw-path fix: while a palette is active,
   * the cell's real colors come from its own stored ATTR byte, not the
   * current global INK/PAPER — closing the gap DEVELOPING.md's M25 note
   * flagged ahead of time (this always reapplied the global colors,
   * never what a cell was actually written with). Both ATTR nibbles are
   * always 0-15 by construction, so resolveColor() always takes the
   * palette-lookup branch here. Palette inactive: unchanged, global
   * ink/paper, ATTR not read. */
  private redrawCursorAt(col: number, row: number, inverted: boolean): void {
    if (!this.inBounds(col, row)) {
      return;
    }
    const code = this.readChar(col, row);
    const paletteBase = this.getPaletteBase();
    let ink: number;
    let paper: number;
    if (paletteBase !== 0) {
      const attr = this.arena.readByte(this.attrAddress(col, row));
      const resolvedInk = this.resolveColor((attr >> 4) & 0xf, paletteBase);
      const resolvedPaper = this.resolveColor(attr & 0xf, paletteBase);
      ink = inverted ? resolvedPaper : resolvedInk;
      paper = inverted ? resolvedInk : resolvedPaper;
    } else {
      ink = inverted ? this.getPaper() : this.getInk();
      paper = inverted ? this.getInk() : this.getPaper();
    }
    this.hal.blitGlyph(col, row, code, ink, paper);
  }

  /** CURSEN — DEVELOPING.md §17, M25: shows the cursor, inverted, at
   * its current position. */
  showCursor(): void {
    this.sysvars.set('SCREEN', 'CURSOR-VISIBLE', TRUE);
    this.redrawCursorAt(this.getCursorCol(), this.getCursorRow(), true);
  }

  /** CURSDIS — DEVELOPING.md §17, M25: hides the cursor, redrawing its
   * current cell normally. */
  hideCursor(): void {
    this.sysvars.set('SCREEN', 'CURSOR-VISIBLE', FALSE);
    this.redrawCursorAt(this.getCursorCol(), this.getCursorRow(), false);
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
   * coordinates are silently ignored (matches WriteChar).
   *
   * spec/01-HAL.md §3.6: while a palette is active, `ink`/`paper` are
   * resolved through it before reaching the HAL (values 0-15 become a
   * looked-up 0xRRGGBB color; the HAL itself never gains any palette
   * awareness), and the *raw* ink/paper values — not the resolved ones —
   * are packed into ATTR as IIIIPPPP, mechanically, regardless of
   * whether they're valid indices (a literal RGB >=16 truncates to its
   * low nibble here — the named, accepted limitation: it renders
   * correctly this once via the resolved HAL call below, but isn't
   * ATTR-durable across a later redraw). */
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
    const paletteBase = this.getPaletteBase();
    if (paletteBase !== 0) {
      this.arena.writeByte(this.attrAddress(col, row), ((ink & 0xf) << 4) | (paper & 0xf));
    }
    this.hal.blitGlyph(col, row, code, this.resolveColor(ink, paletteBase), this.resolveColor(paper, paletteBase));
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
    // false: the cell being left was just written by writeChar() (this
    // is only ever called right after it, from emit()) — see setCursor()'s
    // own doc comment for why redrawing it again here is wrong, not just
    // redundant, while a palette is active.
    this.setCursor(col, row, false);
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
   * the current PAPER, resets the cursor to 0,0. DEVELOPING.md §17,
   * M25: clearScreen() now runs *before* setCursor(0, 0) — a real
   * ordering bug found while adding the visible-cursor redraw hook:
   * the old order drew the cursor first, then immediately painted
   * over it with the full-framebuffer clear. */
  cls(): void {
    for (let i = 0; i < this.charBank.size; i++) {
      this.arena.writeByte(this.charBank.base + i, SPACE);
    }
    // spec/01-HAL.md §3.6: ATTR gets the same treatment CHAR does here —
    // filled with the current ink/paper attribute so a freshly-cleared
    // screen is attribute-consistent immediately, not stale. Only while
    // a palette is active; otherwise ATTR stays untouched/inert.
    const paletteBase = this.getPaletteBase();
    if (paletteBase !== 0) {
      const attrByte = ((this.getInk() & 0xf) << 4) | (this.getPaper() & 0xf);
      this.arena.fillBytes(this.attrBank.base, this.attrBank.size, attrByte);
    }
    this.hal.clearScreen(this.resolveColor(this.getPaper(), paletteBase));
    this.setCursor(0, 0);
  }

  /** Repaints every cell of the visible framebuffer purely from CHAR
   * bank content — `redrawCursorAt`'s own "CHAR content is always
   * enough to redraw correctly" precedent (`CScreenModule::Redraw()`),
   * extended to the whole grid instead of one cell. Needed whenever
   * something has overwritten CHAR bytes directly, bypassing the
   * normal per-character HAL write-through every other write in this
   * class goes through — today, only `RESTORE`'s project-load (M29,
   * `repl.ts`), but this is also the mechanism `02-MEMORY-MODEL.md`
   * §6.2 names for a future arena-attach ("repointing the shared
   * screen surface at that arena's own CHAR bank and redrawing from
   * it"). Never touches CHAR itself, same as `redrawCursorAt`. */
  redrawAll(): void {
    const cursorVisible = this.isCursorVisible();
    const cursorCol = this.getCursorCol();
    const cursorRow = this.getCursorRow();
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const inverted = cursorVisible && col === cursorCol && row === cursorRow;
        this.redrawCursorAt(col, row, inverted);
      }
    }
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
