import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('COLD (rebel-opcodes.json 132)', () => {
  it('reaches step() as the dedicated \'cold\' status, never as a thrown error', () => {
    const m = new Machine();
    m.beginLine('COLD');
    expect(m.step(10)).toBe('cold');
  });

  it('makes no state change on its own — the engine only signals; reconstructing the Machine is host-only (packages/app/src/app/app.ts)', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    const hereBefore = m.sysvars.getHere();
    const latestBefore = m.sysvars.getLatest();

    m.beginLine('1 2 3 COLD');
    m.step(10);

    // The 3 pushed before COLD are still there (toArray() is top-of-stack
    // first) — COLD never reached executePrimitive (inner.ts's dispatch()
    // intercepts its token before that), so nothing about the running
    // Machine changed.
    expect(m.stack.toArray()).toEqual([3, 2, 1]);
    expect(m.sysvars.getHere()).toBe(hereBefore);
    expect(m.sysvars.getLatest()).toBe(latestBefore);
  });

  it("doesn't clear the session itself — 'cold' is returned the same way 'breakpoint' is, leaving cleanup entirely to the caller", () => {
    const m = new Machine();
    m.beginLine('COLD');
    expect(m.step(10)).toBe('cold');
    // COLD was the only token on the line, so resuming the (still-alive)
    // session just runs it to completion — proves step() genuinely left
    // the session in place after the 'cold' return rather than tearing
    // it down itself, the same contract 'breakpoint' has.
    expect(m.step(10)).toBe('idle');
  });
});
