import { describe, expect, it, vi } from 'vitest';
import { Machine } from './repl.js';
import { ScreenHal } from './screen.js';
import { bootMachine } from './test-support.js';

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

  it('redrawAll() repaints every cell purely from CHAR bank content, without writing CHAR itself (M29)', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    // A byte straight into CHAR, bypassing writeChar()'s own HAL
    // write-through — the same shape a project RESTORE leaves behind.
    const charBase = m.banks.findBank('CHAR')!.base;
    m.arena.writeByte(charBase, 72); // 'H' at (0,0)
    hal.blitGlyph.mockClear();

    m.screen.redrawAll();

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 72, 0x00ff00, 0x000000);
    expect(hal.blitGlyph).toHaveBeenCalledTimes(m.screen.cols * m.screen.rows);
    // Never mutates CHAR — a pure repaint.
    expect(m.screen.readChar(0, 0)).toBe(72);
  });

  it('REDRAW (133): poking CHAR directly via BANK@/C! draws nothing until REDRAW repaints it', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    hal.blitGlyph.mockClear();

    // The exact scenario REDRAW exists for: BANK@ CHAR gives a raw
    // address into the CHAR bank, C! writes straight to arena bytes —
    // neither goes anywhere near writeChar()'s HAL write-through.
    m.interpret('72 BANK@ CHAR C!');
    expect(m.screen.readChar(0, 0)).toBe(72); // the byte landed...
    expect(hal.blitGlyph).not.toHaveBeenCalled(); // ...but nothing repainted

    m.interpret('REDRAW');

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 72, 0x00ff00, 0x000000);
    expect(hal.blitGlyph).toHaveBeenCalledTimes(m.screen.cols * m.screen.rows);
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

    // At startRepl() time the cursor is still at (0,0) — nothing has
    // been typed or run yet (no prompt glyph is ever drawn; `ok`/an
    // error is the only "ready" signal, printed once a line runs).
    // One inverted redraw, no content write.
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

describe('Indexed color palette + ATTR bank (spec/01-HAL.md §3.6, spec/02-MEMORY-MODEL.md §4.6)', () => {
  it('PALETTE-BASE defaults to the default palette map at boot (M62 follow-up 3) — literal RGB >=16 still passes through unresolved', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });

    expect(m.screen.getPaletteBase()).toBe(m.banks.findBank('PAL')!.base);

    hal.blitGlyph.mockClear();
    m.interpret('16711680 INK 255 PAPER 65 EMIT'); // red ink, blue paper, 'A' -- both >=16, literal either way

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 16711680, 255);
  });

  it('boot defaults INK/PAPER to palette indices 4/0 (M62 follow-up 3) — same rendered green-on-black as before', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    hal.blitGlyph.mockClear();

    m.interpret('65 EMIT'); // 'A' with untouched boot INK/PAPER

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 0x00ff00, 0x000000);
  });

  it('PALETTE-BASE (system.fth, M62 follow-up) pushes the sysvar cell\'s own address, same BASE/STATE idiom — read with @, write with !', () => {
    const m = bootMachine();
    const palBase = m.banks.findBank('PAL')!.base;

    m.interpret('PALETTE-BASE @');
    expect(m.stack.pop()).toBe(palBase); // enabled by default at boot (M62 follow-up 3)

    m.interpret('0 PALETTE-BASE !');
    expect(m.screen.getPaletteBase()).toBe(0);

    m.interpret(`${palBase} PALETTE-BASE !`);
    expect(m.screen.getPaletteBase()).toBe(palBase); // same sysvar setPaletteBase() writes

    m.interpret('PALETTE-BASE @');
    expect(m.stack.pop()).toBe(palBase);
  });

  it('BANK@ PAL PALETTE-BASE ! is enough to enable the default palette end-to-end', () => {
    const hal = spyHal();
    const m = bootMachine({ screenHal: hal });
    hal.blitGlyph.mockClear();

    m.interpret('BANK@ PAL PALETTE-BASE !');
    m.interpret('4 INK 0 PAPER 65 EMIT'); // green (4) on black (0)

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 0x00ff00, 0x000000);
  });

  it('PALETTE (system.fth, M62 follow-up 2) selects PAL\'s n\'th map by index', () => {
    const m = bootMachine();
    const palBase = m.banks.findBank('PAL')!.base;

    m.interpret('0 PALETTE');
    expect(m.screen.getPaletteBase()).toBe(palBase);

    m.interpret('3 PALETTE');
    expect(m.screen.getPaletteBase()).toBe(palBase + 3 * 64);
  });

  it('a custom color written into a non-default PAL map resolves correctly once PALETTE selects it', () => {
    const hal = spyHal();
    const m = bootMachine({ screenHal: hal });
    const palBase = m.banks.findBank('PAL')!.base;
    m.arena.writeCell(palBase + 2 * 64 + 0 * 4, 0x123456); // map 2, index 0
    hal.blitGlyph.mockClear();

    m.interpret('2 PALETTE');
    m.interpret('0 INK 0 PAPER 65 EMIT');

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 0x123456, 0x123456);
  });

  it('disabling stays a plain sysvar write — 0 PALETTE-BASE !, no dedicated word', () => {
    const m = bootMachine();
    m.interpret('1 PALETTE');
    expect(m.screen.getPaletteBase()).not.toBe(0);

    m.interpret('0 PALETTE-BASE !');

    expect(m.screen.getPaletteBase()).toBe(0);
  });

  it('the default palette is resident at PAL map slot 0 at boot', () => {
    const m = new Machine();
    const palBank = m.banks.findBank('PAL')!;
    const defaultPalette = [
      0x000000, 0x0000ff, 0xff0000, 0xff00ff, 0x00ff00, 0x00ffff, 0xffff00, 0xffffff, 0xff0088, 0x8800ff, 0xff8888,
      0xff8800, 0x0088ff, 0x8888ff, 0x888800, 0x888888,
    ];
    for (let i = 0; i < defaultPalette.length; i++) {
      expect(m.arena.readCell(palBank.base + i * 4)).toBe(defaultPalette[i]);
    }
  });

  it('once PALETTE-BASE points at the default map, INK/PAPER values 0-15 resolve through it', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.screen.setPaletteBase(m.banks.findBank('PAL')!.base);
    hal.blitGlyph.mockClear();

    m.interpret('4 INK 0 PAPER 65 EMIT'); // green (index 4) on black (index 0)

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 0x00ff00, 0x000000);
  });

  it('values >=16 stay literal RGB even while a palette is active', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.screen.setPaletteBase(m.banks.findBank('PAL')!.base);
    hal.blitGlyph.mockClear();

    m.interpret('16711680 INK 255 PAPER 65 EMIT');

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 16711680, 255);
  });

  it('a literal RGB ink survives the very next cursor-advance while CURSEN is on — regression for a real bug found live: the un-invert half of setCursor() used to redraw the just-written cell from its ATTR-truncated nibble, silently replacing e.g. white with whatever the low nibble\'s palette entry happened to be', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.screen.setPaletteBase(m.banks.findBank('PAL')!.base);
    m.screen.showCursor(); // CURSEN
    hal.blitGlyph.mockClear();

    m.interpret('16777215 INK 0 PAPER 65 EMIT'); // white 'A' on black

    // The cell EMIT wrote must be the LAST thing painted there — not
    // clobbered a moment later by the cursor moving off it.
    const paintsAtOrigin = hal.blitGlyph.mock.calls.filter((call) => call[0] === 0 && call[1] === 0);
    expect(paintsAtOrigin.at(-1)).toEqual([0, 0, 65, 16777215, 0]);
  });

  it("writes the cell's ATTR byte as IIIIPPPP while a palette is active — green on black is 0x40", () => {
    const m = new Machine();
    m.screen.setPaletteBase(m.banks.findBank('PAL')!.base);

    m.interpret('4 INK 0 PAPER 65 EMIT');

    const attrBank = m.banks.findBank('ATTR')!;
    expect(m.arena.readByte(attrBank.base)).toBe(0x40);
  });

  it('ATTR is not written while PALETTE-BASE is 0', () => {
    const m = new Machine();
    m.screen.setPaletteBase(0); // explicitly disabled — boot now defaults to non-zero (M62 follow-up 3)
    const attrBank = m.banks.findBank('ATTR')!;
    m.arena.writeByte(attrBank.base, 0xff); // sentinel — writeChar() must leave this alone

    m.interpret('4 INK 0 PAPER 65 EMIT');

    expect(m.arena.readByte(attrBank.base)).toBe(0xff);
  });

  it('redrawAll() reads each cell\'s own ATTR-stored color while a palette is active, not the current global INK/PAPER', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.screen.setPaletteBase(m.banks.findBank('PAL')!.base);
    m.interpret('2 INK 1 PAPER 65 EMIT'); // red (2) on blue (1) at (0,0)
    m.interpret('6 INK 0 PAPER 66 EMIT'); // yellow (6) on black (0) at (1,0)

    m.interpret('99 INK 99 PAPER'); // change the global colors to something unrelated
    hal.blitGlyph.mockClear();

    m.screen.redrawAll();

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 65, 0xff0000, 0x0000ff);
    expect(hal.blitGlyph).toHaveBeenCalledWith(1, 0, 66, 0xffff00, 0x000000);
  });

  it('cls() fills ATTR with the current ink/paper attribute while a palette is active, so a cleared screen is attribute-consistent immediately', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.screen.setPaletteBase(m.banks.findBank('PAL')!.base);
    m.interpret('3 INK 5 PAPER'); // magenta ink, cyan paper

    m.interpret('CLS');
    hal.blitGlyph.mockClear();

    m.screen.redrawAll();

    expect(hal.blitGlyph).toHaveBeenCalledWith(0, 0, 32, 0xff00ff, 0x00ffff);
    expect(hal.blitGlyph).toHaveBeenCalledTimes(m.screen.cols * m.screen.rows);
  });

  it('CURSEN inverts using the cell\'s own resolved palette colors, not the global INK/PAPER, while a palette is active', () => {
    const hal = spyHal();
    const m = new Machine({ screenHal: hal });
    m.screen.setPaletteBase(m.banks.findBank('PAL')!.base);
    m.interpret('2 INK 1 PAPER 3 4 65 CHAR!'); // 'A', red (2) ink / blue (1) paper, ATTR = 0x21
    m.interpret('3 4 AT-XY');
    hal.blitGlyph.mockClear();

    m.interpret('CURSEN');

    expect(hal.blitGlyph).toHaveBeenCalledWith(3, 4, 65, 0x0000ff, 0xff0000); // swapped
  });
});
