import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { findWord } from './dictionary.js';
import { bootMachine } from './test-support.js';

describe('WARM (rebel-opcodes.json 131)', () => {
  it('empties both stacks but leaves an already-defined word findable', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    const hereBefore = m.sysvars.getHere();
    const latestBefore = m.sysvars.getLatest();

    m.interpret('1 2 3 WARM');

    expect(m.stack.depth).toBe(0);
    expect(m.rstack.depth).toBe(0);
    // DICT/MMAP genuinely untouched — same word, same HERE/LATEST.
    expect(findWord(m, 'SQUARE')).toBeDefined();
    expect(m.sysvars.getHere()).toBe(hereBefore);
    expect(m.sysvars.getLatest()).toBe(latestBefore);
  });

  // Revised for a real regression found by Oliver: self-hosted INTERPRET
  // (M43) is itself a DOCOL-threaded colon word with its own live RSTK
  // frame for as long as it's running a line, so "clear RSTK, then
  // resume the calling frame normally" is a contradiction once anything
  // self-hosted is the caller — the very return address WARM needs to
  // get back to is what RP0 RP! (WARM's own former self-hosted
  // definition) just wiped. Fixed by aligning with classic Forth
  // WARM/QUIT semantics instead: still doesn't throw, but abandons the
  // rest of the current line rather than continuing it (primitives.ts's
  // WARM throws a dedicated WarmReset signal that repl.ts's
  // runLine()/replLoop() catch and recover from silently, distinct from
  // a genuine error).
  it('does not throw, but abandons the rest of the line — classic WARM/QUIT semantics, not ABORT-with-recovery', () => {
    const m = new Machine();
    expect(() => m.interpret('1 2 3 WARM 4 5')).not.toThrow();
    // WARM cleared the stack; "4 5" after it never ran at all.
    expect(m.stack.toArray()).toEqual([]);
  });

  it('self-hosted (system.fth, post-boot): same "does not throw, abandons rest of line" contract, not just the native primitive path', () => {
    const m = bootMachine();
    m.interpret(': SQUARE DUP * ;');
    const hereBefore = m.sysvars.getHere();
    const latestBefore = m.sysvars.getLatest();

    expect(() => m.interpret('1 2 3 WARM 4 5')).not.toThrow();

    expect(m.stack.toArray()).toEqual([]);
    expect(m.rstack.depth).toBe(0);
    expect(findWord(m, 'SQUARE')).toBeDefined();
    expect(m.sysvars.getHere()).toBe(hereBefore);
    expect(m.sysvars.getLatest()).toBe(latestBefore);

    // Repeatable, and the machine keeps working normally afterward.
    m.interpret('WARM');
    m.interpret('5 SQUARE');
    expect(m.stack.pop()).toBe(25);
  });

  it('plain RP0 RP! (unrelated to WARM) is still a genuine, unguarded low-level footgun — this fix does not paper over it', () => {
    // RP0/RP! stay ordinary primitives: setting RSTK's pointer to a
    // value shallower than the caller's own live frame is inherently
    // dangerous in any Forth, self-hosted or not. Only WARM itself
    // (case 131) gets special handling, not RP! in general.
    const m = bootMachine();
    expect(() => m.interpret('RP0 RP!')).toThrow(/RSTK stack underflow/);
  });
});
