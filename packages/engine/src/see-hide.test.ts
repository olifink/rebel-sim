/**
 * SEE/HIDE (system.fth) — decompiling and hiding a word by name. No
 * dedicated engine-level tests existed for either before M70
 * (DEVELOPING.md §3/§8 both flag the gap).
 *
 * M70's own reason for existing: both words resolved their target name
 * via the native ' primitive (token 94), which finds a word by walking
 * the raw LATEST sysvar directly — a search rooted in whatever
 * vocabulary is currently CURRENT-VOCAB (i.e. has had DEFINITIONS run
 * on it), not CONTEXT (whatever's merely being browsed via USE). Every
 * *other* consumer of dictionary search — ordinary word dispatch,
 * WORDS — goes through the self-hosted, CONTEXT-aware FIND instead, so
 * this was a real, silent inconsistency: SEE/HIDE worked on a word in
 * some other vocabulary only once DEFINITIONS had been run on it, never
 * from merely browsing it. Fixed by giving SEE/HIDE their own
 * CONTEXT-aware name resolution ((TICK), built on FIND) and by walking
 * XT-NAME's and HIDE's own internal xt-to-entry searches from
 * SEARCH-ROOT instead of raw LATEST too.
 */

import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';

function fullScreenText(m: Machine): string {
  const rows: string[] = [];
  for (let r = 0; r < m.screen.rows; r++) {
    rows.push(m.screen.readRowText(r));
  }
  return rows.join('');
}

describe('SEE', () => {
  it('decompiles an ordinary FORTH-vocabulary word', () => {
    const m = bootMachine();
    m.interpret(': FOO 1 2 + ;');
    m.interpret('SEE FOO');
    expect(fullScreenText(m)).toContain(': FOO 1 2 + ;');
  });

  it('errors on an unrecognized word, printing the offending token first (M70)', () => {
    const m = bootMachine();
    expect(() => m.interpret('SEE NOSUCHWORD')).toThrow(/ABORT/);
    expect(fullScreenText(m)).toContain('NOSUCHWORD');
  });

  it('M70 regression: works on a word in another vocabulary while merely browsing it (USE, no DEFINITIONS)', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('SEE TOP');
    expect(fullScreenText(m)).toContain(': TOP 0 LIST ;');
  });

  it('still works on a word in another vocabulary once DEFINITIONS has run on it', () => {
    const m = bootMachine();
    m.interpret('EDITOR DEFINITIONS');
    m.interpret('SEE TOP');
    expect(fullScreenText(m)).toContain(': TOP 0 LIST ;');
  });
});

describe('HIDE', () => {
  it('hides an ordinary FORTH-vocabulary word from WORDS and further lookup', () => {
    const m = bootMachine();
    m.interpret(': FOO 1 2 + ;');
    m.interpret('HIDE FOO');
    m.interpret('WORDS');
    expect(fullScreenText(m)).not.toContain('FOO');
    expect(() => m.interpret("' FOO")).toThrow(/unrecognized word/i);
  });

  it('M70 regression: hides a word in another vocabulary while merely browsing it (USE, no DEFINITIONS)', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('HIDE TOP');
    m.interpret('WORDS');
    expect(fullScreenText(m)).not.toContain('TOP');
  });
});
