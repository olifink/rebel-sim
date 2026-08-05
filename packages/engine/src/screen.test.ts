import { describe, expect, it, vi } from 'vitest';
import { Machine } from './repl.js';
import { ScreenHal } from './screen.js';

function spyHal(): ScreenHal & { blitGlyph: ReturnType<typeof vi.fn>; clearScreen: ReturnType<typeof vi.fn> } {
  return { blitGlyph: vi.fn(), clearScreen: vi.fn() };
}

describe('Screen', () => {
  it('CHAR! writes the CHAR bank and CHAR@ reads it back', () => {
    const m = new Machine();
    m.interpret('5 3 65 CHAR!');
    expect(m.screen.readChar(5, 3)).toBe(65);
    m.interpret('5 3 CHAR@');
    expect(m.stack.pop()).toBe(65);
  });

  it('CHAR@ returns a space for out-of-range coordinates, matching Rebel-ROM', () => {
    const m = new Machine();
    expect(m.screen.readChar(-1, 0)).toBe(32);
    expect(m.screen.readChar(0, 9999)).toBe(32);
  });

  it('CHAR! silently ignores out-of-range coordinates rather than throwing', () => {
    const m = new Machine();
    expect(() => m.interpret('9999 9999 65 CHAR!')).not.toThrow();
  });

  it('EMIT wraps to the next row at the end of a row, and to row 0 at the bottom — no scrolling', () => {
    const m = new Machine();
    const { cols, rows } = m.screen;

    m.screen.setCursor(cols - 1, 0);
    m.interpret('65 EMIT'); // fills the last column of row 0
    expect(m.screen.getCursorCol()).toBe(0);
    expect(m.screen.getCursorRow()).toBe(1);

    m.screen.setCursor(cols - 1, rows - 1); // last cell of the last row
    m.interpret('66 EMIT');
    expect(m.screen.getCursorCol()).toBe(0);
    expect(m.screen.getCursorRow()).toBe(0); // wrapped back to the top, not scrolled
  });

  it('AT-XY repositions the cursor without bounds-checking', () => {
    const m = new Machine();
    m.interpret('5 7 AT-XY');
    expect(m.screen.getCursorCol()).toBe(5);
    expect(m.screen.getCursorRow()).toBe(7);
  });

  it('CLS blanks the CHAR bank, resets the cursor, and clears the framebuffer via the HAL', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.interpret('0 0 65 CHAR!');
    m.screen.setCursor(3, 3);
    hal.clearScreen.mockClear();

    m.interpret('CLS');

    expect(m.screen.readChar(0, 0)).toBe(32);
    expect(m.screen.getCursorCol()).toBe(0);
    expect(m.screen.getCursorRow()).toBe(0);
    expect(hal.clearScreen).toHaveBeenCalledTimes(1);
  });

  it('INK/PAPER change the default colors CHAR!/EMIT blit with', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    hal.blitGlyph.mockClear();

    m.interpret('16711680 INK 255 PAPER 65 EMIT'); // red ink, blue paper, 'A'
    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 16711680, 255);
  });

  it('a fresh Machine boots with a blank, HAL-painted screen', () => {
    const hal = spyHal();
    new Machine({ screenHal: hal });
    expect(hal.clearScreen).toHaveBeenCalledTimes(1);
  });
});

describe('Visible cursor (CURSEN/CURSDIS, DEVELOPING.md §17, M25)', () => {
  it('a fresh Machine has no visible cursor until CURSEN is called', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    hal.blitGlyph.mockClear();

    m.interpret('5 5 AT-XY'); // moving the cursor before CURSEN triggers no redraw

    expect(hal.blitGlyph).not.toHaveBeenCalled();
  });

  it('CURSEN redraws the current cursor cell inverted (ink/paper swapped)', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.interpret('3 4 AT-XY');
    hal.blitGlyph.mockClear();

    m.interpret('CURSEN');

    // space (32) at (3,4); boot defaults are ink=0x00ff00 (green), paper=0x000000 (black), swapped
    expect(hal.blitGlyph).toHaveBeenCalledWith(3, 4, 32, 0x000000, 0x00ff00);
  });

  it('moving the cursor while visible restores the old cell and inverts the new one', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.interpret('5 5 AT-XY CURSEN');
    hal.blitGlyph.mockClear();

    m.interpret('6 5 AT-XY');

    expect(hal.blitGlyph).toHaveBeenNthCalledWith(1, 5, 5, 32, 0x00ff00, 0x000000); // old cell, restored normal
    expect(hal.blitGlyph).toHaveBeenNthCalledWith(2, 6, 5, 32, 0x000000, 0x00ff00); // new cell, inverted
  });

  it('CURSDIS redraws the current cell normally', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.interpret('2 2 AT-XY CURSEN');
    hal.blitGlyph.mockClear();

    m.interpret('CURSDIS');

    expect(hal.blitGlyph).toHaveBeenCalledWith(2, 2, 32, 0x00ff00, 0x000000);
  });

  it('typing a character at the cursor draws it normally, not inverted', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.interpret('0 0 AT-XY CURSEN');
    hal.blitGlyph.mockClear();

    m.interpret('65 EMIT'); // 'A'

    // The typed character itself must never be inverted — DEVELOPING.md
    // §17's own worked-through reasoning about EMIT's call sequence.
    // Three calls happen, not two: EMIT's content write (normal), then
    // setCursor(1,0)'s "restore the old cell" redraw — which redraws the
    // just-typed 'A' again, harmlessly, since CHAR already holds it by
    // then (the documented "wasted-but-harmless double-blit") — then the
    // real new-position redraw, inverted.
    expect(hal.blitGlyph).toHaveBeenNthCalledWith(1, 0, 0, 65, 0x00ff00, 0x000000);
    expect(hal.blitGlyph).toHaveBeenNthCalledWith(2, 0, 0, 65, 0x00ff00, 0x000000);
    expect(hal.blitGlyph).toHaveBeenNthCalledWith(3, 1, 0, 32, 0x000000, 0x00ff00);
    expect(hal.blitGlyph).toHaveBeenCalledTimes(3);
  });

  it('an out-of-range AT-XY while visible does not throw', () => {
    const m = new Machine();
    m.interpret('1 1 AT-XY CURSEN');
    expect(() => m.interpret('9999 9999 AT-XY')).not.toThrow();
  });

  it('CLS shows the cursor at (0,0) after the framebuffer clear, not painted over by it', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.interpret('3 3 AT-XY CURSEN');
    hal.blitGlyph.mockClear();

    m.interpret('CLS');

    // Last blitGlyph call is the inverted redraw at the new (0,0)
    // position — proves it happened after clearScreen()'s full-framebuffer
    // paint, not before (the ordering bug this change also fixed).
    expect(hal.blitGlyph.mock.calls.at(-1)).toEqual([0, 0, 32, 0x000000, 0x00ff00]);
  });

  it('startRepl() shows the cursor immediately, before the first keystroke (DEVELOPING.md §18, M26)', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    hal.blitGlyph.mockClear();

    m.startRepl();

    // At startRepl() time the cursor is still at (0,0) — the '> '
    // prompt hasn't been emitted yet (that happens on the first
    // step()). One inverted redraw, no content write.
    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 32, 0x000000, 0x00ff00);
  });

  it('a plain interpret()/beginLine() session never shows a cursor — opt-in stays scoped to startRepl()', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    hal.blitGlyph.mockClear();

    m.interpret('1 2 + .');

    expect(hal.blitGlyph.mock.calls.every((call) => call[3] !== 0x000000 || call[4] !== 0x00ff00)).toBe(true);
  });
});
