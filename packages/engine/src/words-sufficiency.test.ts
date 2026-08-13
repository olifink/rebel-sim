import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';

/**
 * Originally CORE-VOCABULARY.md §12's own sufficiency check: a proof that a
 * *bare* native kernel was enough to define WORDS from scratch, with no
 * bootstrap layer loaded first. spec/04-FORTH-CORE.md's §6 KERNEL→BOOTSTRAP
 * reclassification (M42) makes that specific premise stale on purpose —
 * WORDS itself depends on BEGIN/WHILE/REPEAT, which are themselves now
 * BOOTSTRAP words (§6.5), not native ones, so a bare `new Machine()` no
 * longer has enough natives to define WORDS at all. That's the intended
 * outcome of a smaller kernel, not a regression: §7.2 already lists WORDS
 * as an ordinary bootstrap library word, "built entirely from the KERNEL
 * words above... with zero additional native support, already proven as
 * working Forth source" — i.e. `system.fth`'s own copy *is* the reference
 * now, not a hand-duplicated string in this file. What's still worth
 * proving, and still true, is WORDS's own observable behavior once the real
 * bootstrap layer has loaded — unchanged from before this reclassification.
 */

/** With ~90 words in the dictionary by now, the printed list wraps
 * across many screen rows — read the whole screen, not just row 0.
 * Joined with no separator, not a space: a row boundary is purely a
 * cursor-wrap artifact (screen.ts's advanceCursor, "wrap only, no
 * scroll"), not a character actually written to the stream — WORDS's
 * own definition already emits a real space between words, so
 * inserting a second one here can (and, once the dictionary grew past
 * a row boundary at just the wrong offset, did) fracture a word that
 * happened to wrap exactly mid-name, e.g. "SWAP" read back as "S
 * WAP". */
function fullScreenText(m: Machine): string {
  const rows: string[] = [];
  for (let r = 0; r < m.screen.rows; r++) {
    rows.push(m.screen.readRowText(r));
  }
  return rows.join('');
}

describe('WORDS — behavior once the real bootstrap layer has loaded', () => {
  it('lists boot-registered primitives by name', () => {
    const m = bootMachine();
    m.interpret('WORDS');
    const listed = fullScreenText(m);
    expect(listed).toContain('DUP'); // token id 1 — the very first primitive boot-registered, so last in the LATEST-to-oldest walk
    expect(listed).toContain('SWAP');
    expect(listed).toContain('WORDS'); // WORDS lists itself — it's LATEST by the time it runs
  });

  it('lists a user-defined word once compiled', () => {
    const m = bootMachine();
    m.interpret(': MYWORD 1 2 + ;');
    m.interpret('WORDS');
    expect(fullScreenText(m)).toContain('MYWORD');
  });

  it('a fully-closed definition is listed (HIDDEN was correctly cleared by ;)', () => {
    const m = bootMachine();
    m.interpret(': DONE 42 ;');
    m.interpret('WORDS');
    expect(fullScreenText(m)).toContain('DONE');
  });

  it('is stack-neutral and terminates cleanly (DROP consumes the terminating 0)', () => {
    const m = bootMachine();
    m.interpret('DEPTH');
    const depthBefore = m.stack.pop();
    m.interpret('WORDS');
    m.interpret('DEPTH');
    expect(m.stack.pop()).toBe(depthBefore);
  });
});
