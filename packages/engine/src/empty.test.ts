import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';

/** Whether `name` is currently findable via self-hosted FIND — the
 * CONTEXT-based search order an ordinary typed word goes through, not
 * the separate, deliberately narrower LATEST-scoped native tick (`'`),
 * which only ever sees the compile chain regardless of what's merely
 * being browsed. See the CONTEXT/CURRENT-VOCAB split tests below for why
 * the two differ. */
function findable(m: Machine, name: string): boolean {
  m.interpret(`S" ${name}" FIND`);
  const flag = m.stack.pop();
  m.stack.pop(); // entry-addr, unused
  return flag !== 0;
}

describe('EMPTY (system.fth, FORTH-ARCHITECTURE.md §7 follow-up) — resets the dictionary to its post-boot (COLD-equivalent) state', () => {
  it('forgets a user-defined word', () => {
    const m = bootMachine();
    m.interpret(': FOO 42 ;');
    m.interpret('FOO');
    expect(m.stack.pop()).toBe(42);

    m.interpret('EMPTY');
    // Self-hosted INTERPRET (already the active dispatch path by now, since
    // system.fth fully loaded) reports an unfound word as ABORT, with the
    // failing token TYPEd to the screen first (NUMBER's own NUM-ABORT) —
    // not the native fallback's "unrecognized word: X" message, which only
    // fires before INTERPRET itself exists.
    expect(() => m.interpret('FOO')).toThrow();
    expect(m.screen.readRowText(0).trimEnd()).toBe('FOO');
  });

  it('reclaims DICT space exactly like FORGET would — HERE matches a freshly-booted machine with nothing extra defined', () => {
    const fresh = bootMachine();
    const freshHere = fresh.sysvars.getHere();

    const m = bootMachine();
    m.interpret(': FOO 1 2 3 ;');
    m.interpret(': BAR FOO FOO ;');
    m.interpret('EMPTY');

    expect(m.sysvars.getHere()).toBe(freshHere);
  });

  it('the entire system vocabulary survives — BLOCK/BUFFER/FLUSH/WORDS/SEE/FORGET/EMPTY itself all still findable', () => {
    const m = bootMachine();
    m.interpret(': THROWAWAY 1 ;');
    m.interpret('EMPTY');

    for (const name of ['BLOCK', 'BUFFER', 'UPDATE', 'FLUSH', 'WORDS', 'SEE', 'HIDE', 'FORGET', 'EMPTY']) {
      expect(() => m.interpret(`' ${name}`)).not.toThrow();
      m.stack.pop();
    }
  });

  it('is repeatable — calling it again after defining something new works the same way', () => {
    const m = bootMachine();
    m.interpret(': FIRST 1 ;');
    m.interpret('EMPTY');
    m.interpret(': SECOND 2 ;');
    m.interpret('SECOND');
    expect(m.stack.pop()).toBe(2);

    m.interpret('EMPTY');
    expect(() => m.interpret('SECOND')).toThrow();
    expect(() => m.interpret('FIRST')).toThrow();
  });

  it('a fresh EMPTY call with nothing defined since boot (or since the last EMPTY) is a safe no-op', () => {
    const m = bootMachine();
    const hereBefore = m.sysvars.getHere();
    const latestBefore = m.sysvars.getLatest();

    m.interpret('EMPTY');

    expect(m.sysvars.getHere()).toBe(hereBefore);
    expect(m.sysvars.getLatest()).toBe(latestBefore);
  });

  it('leaves the rest of the machine untouched: data stack, sysvars (INK), and BLKS bank content survive', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');
    m.arena.writeByte(blks.base, 0x77);

    m.interpret('9 8 7'); // leave items on the data stack
    m.sysvars.set('SCREEN', 'INK', 99); // mutate an ordinary sysvar directly
    m.interpret(': JUNK 1 ;');

    m.interpret('EMPTY');

    expect(m.stack.toArray()).toEqual([7, 8, 9]); // toArray() is top-to-bottom (most recently pushed first)
    expect(m.sysvars.get('SCREEN', 'INK')).toBe(99);
    expect(m.arena.readByte(blks.base)).toBe(0x77);
  });

  it('can still define new words normally after EMPTY, with no leftover corruption', () => {
    const m = bootMachine();
    m.interpret(': OLD 1 2 + ;');
    m.interpret('EMPTY');
    m.interpret(': NEW 10 20 + ;');
    m.interpret('NEW');
    expect(m.stack.pop()).toBe(30);
  });

  it('calling EMPTY while a non-FORTH vocabulary is the compile target does not corrupt that vocabulary — regression for a real bug found by Oliver', () => {
    // EMPTY only ever reset the global LATEST/HERE cells, with no idea
    // what CURRENT-VOCAB currently pointed at. Calling it while EDITOR
    // (or any other vocabulary) was still the *compile target* — i.e.
    // reached via DEFINITIONS, not just USE's own context-only browsing
    // — left CURRENT-VOCAB aimed at that vocabulary's own
    // remembered-position cell. The next DEFINITIONS-equivalent switch
    // then saved the freshly-reset (boot-marker) LATEST value directly
    // into that vocabulary's own cell, permanently overwriting its real
    // chain tip. The vocabulary's own marker word survived (reachable via
    // FORTH's own chain), but everything defined inside it became
    // permanently unreachable, even though the underlying bytes were
    // never touched. Reproduced against EDITOR (system.fth's own real
    // vocabulary, not a synthetic one) exactly as it was actually found.
    // [Revised for the later CONTEXT/CURRENT-VOCAB split: the original
    // report used plain USE, which was the single combined pointer at
    // the time — DEFINITIONS is that same full switch's modern name;
    // plain USE alone (browsing only) was never the vulnerable path.]
    const m = bootMachine();
    m.interpret('EDITOR DEFINITIONS');
    expect(findable(m, 'L')).toBe(true);

    // The bug: call EMPTY without switching back to FORTH first.
    m.interpret('EMPTY');
    m.interpret('FORTH DEFINITIONS');
    m.interpret('EDITOR DEFINITIONS');

    for (const name of ['L', 'T', 'TOP', 'CLEAR', 'SCR']) {
      expect(findable(m, name)).toBe(true);
    }
    m.interpret('FORTH DEFINITIONS');
  });

  it('EMPTY leaves plain FORTH active even when called mid-vocabulary, so a following FORTH DEFINITIONS is a harmless no-op', () => {
    const m = bootMachine();
    m.interpret('EDITOR DEFINITIONS');
    m.interpret('EMPTY');
    // Already back on FORTH's own chain — LOAD (FORTH-root) reachable,
    // EDITOR-only words are not, without any explicit FORTH DEFINITIONS
    // at all.
    expect(findable(m, 'LOAD')).toBe(true);
    expect(findable(m, 'L')).toBe(false);
  });
});
