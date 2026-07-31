import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

/**
 * CORE-VOCABULARY.md §12's own sufficiency check: a concrete proof that
 * §4-§9's vocabulary is actually enough to write WORDS (dictionary
 * listing, a.k.a. VLIST), not just plausible on paper. Adapted from the
 * doc's exact source in exactly two ways, neither changing its logic:
 *  - `\` line comments stripped — `\` itself is out of CORE-VOCABULARY.md's
 *    scope (never listed in any word table), so it isn't a real word our
 *    tokenizer could execute; the doc includes them purely for human
 *    readability of the *specification text*, not as literal input.
 *  - `1F` (hex for 31, the name-length mask) written as decimal `31` —
 *    we default to BASE 10 and CORE-VOCABULARY.md doesn't scope a
 *    HEX/DECIMAL word to switch bases, so the hex literal as written
 *    wouldn't parse; 31 is the exact same value.
 */
const WORDS_DEFINITION =
  ': WORDS LATEST BEGIN DUP WHILE DUP 4 + C@ 31 AND OVER 5 + SWAP TYPE 32 EMIT @ REPEAT DROP ;';

/** With ~90 words in the dictionary by now, the printed list wraps
 * across many screen rows — read the whole screen, not just row 0. */
function fullScreenText(m: Machine): string {
  const rows: string[] = [];
  for (let r = 0; r < m.screen.rows; r++) {
    rows.push(m.screen.readRowText(r));
  }
  return rows.join(' ');
}

describe('WORDS — CORE-VOCABULARY.md §12 sufficiency check', () => {
  it('the exact spec definition (adapted only for \\ comments and one hex literal) compiles', () => {
    const m = new Machine();
    expect(() => m.interpret(WORDS_DEFINITION)).not.toThrow();
  });

  it('lists boot-registered primitives by name', () => {
    const m = new Machine();
    m.interpret(WORDS_DEFINITION);
    m.interpret('WORDS');
    const listed = fullScreenText(m);
    expect(listed).toContain('DUP'); // token id 1 — the very first primitive boot-registered, so last in the LATEST-to-oldest walk
    expect(listed).toContain('SWAP');
    expect(listed).toContain('WORDS'); // WORDS lists itself — it's LATEST by the time it runs
  });

  it('lists a user-defined word once compiled', () => {
    const m = new Machine();
    m.interpret(WORDS_DEFINITION);
    m.interpret(': MYWORD 1 2 + ;');
    m.interpret('WORDS');
    expect(fullScreenText(m)).toContain('MYWORD');
  });

  it('a fully-closed definition is listed (HIDDEN was correctly cleared by ;)', () => {
    const m = new Machine();
    m.interpret(WORDS_DEFINITION);
    m.interpret(': DONE 42 ;');
    m.interpret('WORDS');
    expect(fullScreenText(m)).toContain('DONE');
  });

  it('is stack-neutral and terminates cleanly (DROP consumes the terminating 0)', () => {
    const m = new Machine();
    m.interpret(WORDS_DEFINITION);
    m.interpret('DEPTH');
    const depthBefore = m.stack.pop();
    m.interpret('WORDS');
    m.interpret('DEPTH');
    expect(m.stack.pop()).toBe(depthBefore);
  });
});
