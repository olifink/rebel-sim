import { describe, expect, it } from 'vitest';
import { bootMachine } from './test-support.js';

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
});
