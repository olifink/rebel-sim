import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('TERMINAL (rebel-opcodes.json 147)', () => {
  it("reaches step() as the dedicated 'terminal' status, never as a thrown error", () => {
    const m = new Machine();
    m.beginLine('TERMINAL');
    expect(m.step(10)).toBe('terminal');
  });

  it('makes no state change on its own — connecting to a board is host-only (packages/app/src/app/app.ts)', () => {
    const m = new Machine();
    const hereBefore = m.sysvars.getHere();

    m.beginLine('1 2 3 TERMINAL');
    m.step(10);

    // The 3 pushed before TERMINAL are still there (toArray() is
    // top-of-stack first) — TERMINAL never reached executePrimitive
    // (inner.ts's dispatch() intercepts its token before that).
    expect(m.stack.toArray()).toEqual([3, 2, 1]);
    expect(m.sysvars.getHere()).toBe(hereBefore);
  });

  it("doesn't clear the session itself — 'terminal' is returned the same way 'cold'/'breakpoint' are", () => {
    const m = new Machine();
    m.beginLine('TERMINAL');
    expect(m.step(10)).toBe('terminal');
    expect(m.step(10)).toBe('idle');
  });
});
