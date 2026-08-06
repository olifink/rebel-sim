import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

function press(m: Machine, usageCode: number): void {
  m.keyboard.pushRawEvent(usageCode, true);
}
function release(m: Machine, usageCode: number): void {
  m.keyboard.pushRawEvent(usageCode, false);
}

const KEY_2 = 0x1f;
const KEY_3 = 0x20;
const SPACE = 0x2c;
const SHIFT_L = 0x81;
const KEY_EQUAL = 0x2e; // shifted -> '+'
const ENTER = 0x28;

describe('Machine.startRepl (M7a)', () => {
  it('draws no prompt glyph, blocks on ACCEPT, and throws if a session is already active', () => {
    const m = new Machine();
    m.startRepl();
    expect(m.step(10)).toBe('blocked');
    // Real Forth never prints a `> ` prompt either — `ok`/an error is the
    // only "ready" signal, printed once a line actually runs (below).
    // Nothing has run yet, so the row is still blank.
    expect(m.screen.readRowText(0).trimEnd()).toBe('');
    expect(() => m.startRepl()).toThrow(/still running or blocked/);
    expect(() => m.beginLine('1 2 +')).toThrow(/still running or blocked/);
  });

  it('accepts a typed line, interprets it, and prints ok before blocking on the next ACCEPT', () => {
    const m = new Machine();
    m.startRepl();
    m.step(10); // block on the first ACCEPT

    press(m, KEY_2);
    press(m, SPACE);
    press(m, KEY_3);
    press(m, SPACE);
    press(m, SHIFT_L);
    press(m, KEY_EQUAL); // shifted Equal -> '+'
    release(m, SHIFT_L);
    press(m, ENTER);

    const status = m.step(500);
    expect(status).toBe('blocked'); // loop finished this line and is prompting again

    expect(m.stack.toArray()).toEqual([5]);
    expect(m.screen.readRowText(0).trimEnd()).toBe('2 3 + ok');
    expect(m.screen.readRowText(1).trimEnd()).toBe('');
  });

  it('prints a Forth error to the screen and keeps the REPL loop alive', () => {
    const m = new Machine();
    m.startRepl();
    m.step(10);

    const F = 0x09,
      R = 0x15,
      O = 0x12,
      B = 0x05,
      N = 0x11,
      I = 0x0c,
      C = 0x06,
      A = 0x04,
      T = 0x17,
      E = 0x08;
    for (const usage of [F, R, O, B, N, I, C, A, T, E]) {
      press(m, usage);
    }
    press(m, ENTER);

    const status = m.step(500);
    expect(status).toBe('blocked'); // loop survived the error and is prompting again

    // ACCEPT echoes exactly what was typed (unshifted letter keys ->
    // lowercase) — the interpreter only uppercases internally for
    // dictionary lookup, same as a real terminal echoes verbatim.
    const fullScreen = [0, 1, 2].map((r) => m.screen.readRowText(r).trimEnd()).join('\n');
    expect(fullScreen).toContain('frobnicate');
    expect(fullScreen).toContain('? unrecognized word');
    expect(m.stack.depth).toBe(0);
  });
});
