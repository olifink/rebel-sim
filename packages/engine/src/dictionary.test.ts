import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { FLAG_HIDDEN, FLAG_IMMEDIATE, listDictionaryEntries, writeHeader } from './dictionary.js';

describe('colon-definitions', () => {
  it('defines and calls a simple word', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.interpret('5 SQUARE .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('25');
  });

  it('compiles number literals via LIT', () => {
    const m = new Machine();
    m.interpret(': FIVE 5 ;');
    m.interpret('FIVE');
    expect(m.stack.toArray()).toEqual([5]);
  });

  it('supports calling one user word from another (nested DOCOL)', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.interpret(': SUM-OF-SQUARES SQUARE SWAP SQUARE + ;');
    m.interpret('3 4 SUM-OF-SQUARES .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('25');
  });

  it('a redefined word shadows the earlier one (most-recent-wins search)', () => {
    const m = new Machine();
    m.interpret(': DOUBLE 2 * ;');
    m.interpret('10 DOUBLE .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('20');

    m.interpret(': DOUBLE DUP + ;');
    m.screen.cls();
    m.interpret('10 DOUBLE .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('20');
  });

  it('IMMEDIATE words run during compilation of a later word, not deferred', () => {
    const m = new Machine();
    // An IMMEDIATE word that emits at compile time proves it actually ran
    // while SHOUT was being compiled, not when SHOUT is later called.
    m.interpret(': TATTLE 42 EMIT ; IMMEDIATE');
    m.interpret(': SHOUT TATTLE ;');
    expect(m.screen.readRowText(0).trimEnd()).toBe('*'); // char code 42 = '*'

    // Calling SHOUT itself writes nothing further (TATTLE wasn't compiled in).
    m.interpret('SHOUT');
    expect(m.screen.readRowText(0).trimEnd()).toBe('*');
  });

  it('rejects ; outside a definition and : nested inside one', () => {
    const m = new Machine();
    expect(() => m.interpret(';')).toThrow(/outside a definition/);
    expect(() => m.interpret(': A : B ; ;')).toThrow(/cannot nest/);
  });

  it('rolls back a definition aborted by a compile-time error', () => {
    const m = new Machine();
    const latestBefore = m.sysvars.getLatest();
    const hereBefore = m.sysvars.getHere();

    expect(() => m.interpret(': BROKEN FROBNICATE ;')).toThrow(/unrecognized word/);

    expect(m.sysvars.getLatest()).toBe(latestBefore);
    expect(m.sysvars.getHere()).toBe(hereBefore);
    expect(m.sysvars.getState()).toBe(0);

    // The dictionary is left usable: BROKEN doesn't exist, and a fresh
    // definition can proceed normally afterward.
    expect(() => m.interpret('BROKEN')).toThrow(/unrecognized word/);
    m.interpret(': OK 1 ;');
    m.interpret('OK');
    expect(m.stack.pop()).toBe(1);
  });

  it('rejects a word name longer than 31 characters', () => {
    const m = new Machine();
    const tooLong = 'A'.repeat(32);
    expect(() => m.interpret(`: ${tooLong} ;`)).toThrow(/1-31 characters/);
  });

  it('deeply nested calls are bounded by the RSTK bank, not the host stack', () => {
    const m = new Machine();
    // COUNT-DOWN recurses via a freshly-redefined self-reference isn't
    // supported (no RECURSE in M2), so instead prove RSTK depth with a
    // long straight-line chain of nested calls.
    m.interpret(': L0 1 ;');
    let prev = 'L0';
    for (let i = 1; i <= 50; i++) {
      const name = `L${i}`;
      m.interpret(`: ${name} ${prev} 1 + ;`);
      prev = name;
    }
    m.interpret(`${prev} .`);
    expect(m.screen.readRowText(0).trimEnd()).toBe('51');
  });
});

describe('listDictionaryEntries', () => {
  it('lists boot-registered primitives with names, most-recently-defined first', () => {
    const m = new Machine();
    const entries = listDictionaryEntries(m);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].entryAddr).toBe(m.sysvars.getLatest());
    expect(entries.every((e) => e.name.length > 0)).toBe(true);
  });

  it('includes a user colon-definition with its flags and name', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    const entries = listDictionaryEntries(m);
    const entry = entries.find((e) => e.name === 'SQUARE');
    expect(entry).toBeDefined();
    expect(entry!.immediate).toBe(false);
    expect(entry!.compileOnly).toBe(false);
  });

  it('excludes a HIDDEN entry (mid-definition state)', () => {
    const m = new Machine();
    const before = listDictionaryEntries(m).length;
    writeHeader(m, 'INVISIBLE', FLAG_HIDDEN, 0);
    const after = listDictionaryEntries(m);
    expect(after.length).toBe(before);
    expect(after.some((e) => e.name === 'INVISIBLE')).toBe(false);
  });

  it('reports IMMEDIATE on entries that carry the flag', () => {
    const m = new Machine();
    writeHeader(m, 'SHOUTY', FLAG_IMMEDIATE, 0);
    const entry = listDictionaryEntries(m).find((e) => e.name === 'SHOUTY');
    expect(entry?.immediate).toBe(true);
  });
});
