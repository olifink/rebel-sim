/**
 * The GRAPHICS vocabulary (`system.fth`, M68) — LINE/RECT/CIRCLE and
 * their width/fill variants, all pure Forth built on the two new PLOT
 * (148)/POINT (149) primitives tested directly in `screen.test.ts`.
 * These tests exercise the Forth source itself (via `bootMachine()`,
 * which loads `system.fth`), not the engine primitives underneath it —
 * the point is to catch a broken algorithm or a Forth-source typo, not
 * to re-test PLOT/POINT's own bounds-checking.
 */

import { describe, expect, it, vi } from 'vitest';
import { ScreenHal } from './screen.js';
import { bootMachine } from './test-support.js';

function recordingHal(): { drawn: Array<[number, number, number]>; hal: ScreenHal } {
  const drawn: Array<[number, number, number]> = [];
  return {
    drawn,
    hal: {
      blitGlyph: vi.fn(),
      clearScreen: vi.fn(),
      drawPixel: (x: number, y: number, color: number) => drawn.push([x, y, color]),
      readPixel: () => -1,
    },
  };
}

describe('GRAPHICS vocabulary (M68)', () => {
  it('LINE draws a Bresenham diagonal from end to end inclusive', () => {
    const { drawn, hal } = recordingHal();
    const m = bootMachine({ screenHal: hal });
    m.interpret('GRAPHICS');
    m.interpret('0 0 5 5 LINE');
    expect(drawn).toHaveLength(6); // (0,0)..(5,5) inclusive, one pixel per step
    expect(drawn).toContainEqual([0, 0, expect.anything()]);
    expect(drawn).toContainEqual([5, 5, expect.anything()]);
  });

  it('LINE-WIDTH offsets a horizontal line across multiple rows', () => {
    const { drawn, hal } = recordingHal();
    const m = bootMachine({ screenHal: hal });
    m.interpret('GRAPHICS');
    m.interpret('3 LINE-WIDTH !');
    m.interpret('10 50 15 50 LINE'); // horizontal, well inside the screen
    const rows = new Set(drawn.map(([, y]) => y));
    expect(rows).toEqual(new Set([49, 50, 51]));
  });

  it('RECT draws a four-sided outline, not a fill', () => {
    const { drawn, hal } = recordingHal();
    const m = bootMachine({ screenHal: hal });
    m.interpret('GRAPHICS');
    m.interpret('10 10 6 6 RECT');
    // Four LINE1 calls, 6 pixels each (each side is 6 pixels inclusive of
    // both corners) — corners are plotted twice, once per adjacent side,
    // since this draws four independent lines rather than deduplicating.
    expect(drawn).toHaveLength(24);
    expect(drawn).toContainEqual([10, 10, expect.anything()]); // top-left corner
    expect(drawn).toContainEqual([15, 15, expect.anything()]); // bottom-right corner
    // Never touches the interior — this is an outline, not RECT-FILL.
    expect(drawn).not.toContainEqual([12, 12, expect.anything()]);
  });

  it('RECT-FILL fills exactly w*h pixels', () => {
    const { drawn, hal } = recordingHal();
    const m = bootMachine({ screenHal: hal });
    m.interpret('GRAPHICS');
    m.interpret('0 0 10 10 RECT-FILL');
    expect(drawn).toHaveLength(100);
  });

  it('CIRCLE plots only points at the given radius', () => {
    const { drawn, hal } = recordingHal();
    const m = bootMachine({ screenHal: hal });
    m.interpret('GRAPHICS');
    m.interpret('50 50 10 CIRCLE');
    expect(drawn.length).toBeGreaterThan(0);
    for (const [x, y] of drawn) {
      const dist = Math.hypot(x - 50, y - 50);
      expect(dist).toBeGreaterThanOrEqual(8);
      expect(dist).toBeLessThanOrEqual(12);
    }
  });

  it('CIRCLE-FILL covers strictly more area than CIRCLE, including the center', () => {
    const outline = recordingHal();
    const m1 = bootMachine({ screenHal: outline.hal });
    m1.interpret('GRAPHICS');
    m1.interpret('50 50 10 CIRCLE');

    const filled = recordingHal();
    const m2 = bootMachine({ screenHal: filled.hal });
    m2.interpret('GRAPHICS');
    m2.interpret('50 50 10 CIRCLE-FILL');

    expect(filled.drawn.length).toBeGreaterThan(outline.drawn.length);
    expect(filled.drawn).toContainEqual([50, 50, expect.anything()]);
  });
});
