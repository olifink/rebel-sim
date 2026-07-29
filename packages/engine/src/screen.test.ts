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
