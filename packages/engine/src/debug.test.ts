import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('Word-level breakpoints (DEBUGGING.md, M10)', () => {
  it('setBreakpoint/clearBreakpoint throw on an unknown word', () => {
    const m = new Machine();
    expect(() => m.setBreakpoint('NOSUCHWORD')).toThrow(/unrecognized word/);
    expect(() => m.clearBreakpoint('NOSUCHWORD')).toThrow(/unrecognized word/);
  });

  it('clearBreakpoint on a word with no breakpoint set is a no-op', () => {
    const m = new Machine();
    expect(() => m.clearBreakpoint('DUP')).not.toThrow();
  });

  it('setBreakpoint rejects a primitive — it would never actually fire', () => {
    const m = new Machine();
    expect(() => m.setBreakpoint('DUP')).toThrow(/no compiled body/);
  });

  it('setBreakpoint rejects a plain CREATE/VARIABLE word (no DOES>, no compiled body)', () => {
    const m = new Machine();
    m.interpret('VARIABLE FOO');
    expect(() => m.setBreakpoint('FOO')).toThrow(/no compiled body/);
  });

  it('pausedAtWord is undefined until a breakpoint has ever fired', () => {
    const m = new Machine();
    expect(m.pausedAtWord()).toBeUndefined();
  });

  it('listBreakpoints reports armed breakpoints by name', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.interpret(': DOUBLE DUP + ;');
    expect(m.listBreakpoints()).toEqual([]);

    m.setBreakpoint('SQUARE');
    expect(m.listBreakpoints()).toEqual(['SQUARE']);

    m.setBreakpoint('DOUBLE');
    expect(m.listBreakpoints().sort()).toEqual(['DOUBLE', 'SQUARE']);

    m.clearBreakpoint('SQUARE');
    expect(m.listBreakpoints()).toEqual(['DOUBLE']);
  });

  it('pauses right before a breakpointed word runs, and resumes with state intact', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.setBreakpoint('SQUARE');

    m.beginLine('5 SQUARE');
    expect(m.step(1)).toBe('more-to-run'); // '5' pushed, SQUARE not reached yet
    expect(m.stack.toArray()).toEqual([5]);

    const status = m.step(1000);
    expect(status).toBe('breakpoint');
    expect(m.pausedAtWord()).toBe('SQUARE');
    expect(m.stack.toArray()).toEqual([5]); // paused before SQUARE's body ran, nothing consumed yet

    expect(m.step(1000)).toBe('idle'); // resumes past the breakpoint, runs SQUARE, finishes the line
    expect(m.stack.toArray()).toEqual([25]);
  });

  it('fires even when the breakpointed word is the very first one on a line (top-level entry)', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.stack.push(5);
    m.setBreakpoint('SQUARE');

    m.beginLine('SQUARE');
    expect(m.step(1000)).toBe('breakpoint');
    expect(m.pausedAtWord()).toBe('SQUARE');
    expect(m.step(1000)).toBe('idle');
    expect(m.stack.toArray()).toEqual([25]);
  });

  it('does not fire for a call that never reaches the breakpointed word', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.setBreakpoint('SQUARE');

    m.interpret('3 4 +'); // no SQUARE call at all — interpret() throws if it unexpectedly blocks/pauses
    expect(m.stack.toArray()).toEqual([7]);
  });

  it('a cleared breakpoint no longer fires', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.setBreakpoint('SQUARE');
    m.clearBreakpoint('SQUARE');

    m.interpret('5 SQUARE'); // would throw/hang on an unexpected pause if this still broke
    expect(m.stack.toArray()).toEqual([25]);
  });

  it('a recursive word re-breaks on every call, not just the first', () => {
    const m = new Machine();
    // COUNTDOWN ( n -- ): recurses to 0, so it's entered once per value 3,2,1,0.
    // No comments in source yet (DEVELOPING.md §2 — not built), hence this note lives here instead.
    m.interpret(': COUNTDOWN DUP 0= IF DROP ELSE 1 - RECURSE THEN ;');
    m.setBreakpoint('COUNTDOWN');

    m.beginLine('3 COUNTDOWN');
    let breaks = 0;
    let status = m.step(1000);
    while (status === 'breakpoint') {
      breaks++;
      expect(m.pausedAtWord()).toBe('COUNTDOWN');
      status = m.step(1000);
    }
    expect(status).toBe('idle');
    expect(breaks).toBe(4);
    expect(m.stack.toArray()).toEqual([]);
  });
});
