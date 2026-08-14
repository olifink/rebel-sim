import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { FLAG_HIDDEN, FLAG_IMMEDIATE, getPrimitiveNote, listDictionaryEntries, writeHeader } from './dictionary.js';

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

  it('rejects ; outside a definition', () => {
    const m = new Machine();
    expect(() => m.interpret(';')).toThrow(/outside a definition/);
  });

  it('a : nested inside another definition still fails safely (M43: uniform dispatch)', () => {
    // spec/04-FORTH-CORE.md §5.2: once `:` is an ordinary non-immediate
    // primitive rather than special-cased syntax, "nothing external gates
    // this" — a nested `:` no longer throws immediately (§5.2's own
    // words). It gets *compiled* as an inert call into A's body instead;
    // the very next token, B, is then looked up and fails as an
    // unrecognized word (B was never A's name — the whole point of the
    // old "cannot nest" check was to catch exactly this kind of malformed
    // input). What matters is preserved either way: an error is thrown,
    // and the half-built definition is fully rolled back.
    const m = new Machine();
    const latestBefore = m.sysvars.getLatest();
    const hereBefore = m.sysvars.getHere();

    expect(() => m.interpret(': A : B ; ;')).toThrow(/unrecognized word: B/);

    expect(m.sysvars.getLatest()).toBe(latestBefore);
    expect(m.sysvars.getHere()).toBe(hereBefore);
    expect(m.sysvars.getState()).toBe(0);
    expect(() => m.interpret('A')).toThrow(/unrecognized word/);
  });

  it(': / ; / IMMEDIATE / COMPILE-ONLY are genuine, findable dictionary entries (M43)', () => {
    // spec/04-FORTH-CORE.md §5.2: the whole point of this milestone —
    // these are no longer special-cased strings the outer loop matches
    // before dictionary lookup ever runs; they're ordinary primitives
    // like anything else, findable via `findWord` and listed by `WORDS`.
    const m = new Machine();
    const names = listDictionaryEntries(m).map((e) => e.name);
    for (const name of [':', ';', 'IMMEDIATE', 'COMPILE-ONLY']) {
      expect(names).toContain(name);
    }
    const semicolon = listDictionaryEntries(m).find((e) => e.name === ';')!;
    expect(semicolon.immediate).toBe(true);
    const colon = listDictionaryEntries(m).find((e) => e.name === ':')!;
    expect(colon.immediate).toBe(false);
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

  it('reports breakable=true for a colon-definition, false for a primitive (M10)', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    const entries = listDictionaryEntries(m);
    expect(entries.find((e) => e.name === 'SQUARE')?.breakable).toBe(true);
    expect(entries.find((e) => e.name === 'DUP')?.breakable).toBe(false);
  });

  it('reports breakable=true for a CREATE...DOES> word once DOES> has run (M10)', () => {
    const m = new Machine();
    m.interpret(': CONST CREATE , DOES> @ ;');
    // Before DOES> runs (a bare CREATE with no DOES> yet), the Code
    // Field is still DOVAR, not DODOES — a plain CREATE-only word (no
    // compiled body to break on) stays false. CONST itself is a
    // DOCOL-coded colon-definition, so it's breakable regardless.
    m.interpret('5 CONST FIVE');
    const entry = listDictionaryEntries(m).find((e) => e.name === 'FIVE');
    expect(entry?.breakable).toBe(true);
  });
});

describe('LATEST-ADDR (DEVELOPING.md §8, VOCABULARY/USE)', () => {
  it('LATEST-ADDR @ reads the same value LATEST itself pushes', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.interpret('LATEST-ADDR @ LATEST =');
    expect(m.stack.toArray()).toEqual([-1]);
  });

  it('writing through LATEST-ADDR actually changes what LATEST reports', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    const beforeLatest = m.sysvars.getLatest();
    m.interpret(': FIVE 5 ;');
    const afterLatest = m.sysvars.getLatest();
    expect(afterLatest).not.toBe(beforeLatest);

    m.interpret(`${beforeLatest} LATEST-ADDR !`);
    expect(m.sysvars.getLatest()).toBe(beforeLatest);
    // Confirmed from the Forth side too, not just the TS accessor.
    m.interpret('LATEST .');
    expect(m.screen.readRowText(0).trimEnd()).toBe(String(beforeLatest));
  });
});

describe('HERE-ADDR (DEVELOPING.md §8.6, FORGET)', () => {
  it('HERE-ADDR @ reads the same value HERE itself pushes', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    m.interpret('HERE-ADDR @ HERE =');
    expect(m.stack.toArray()).toEqual([-1]);
  });

  it('writing through HERE-ADDR actually changes what HERE reports', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    const beforeHere = m.sysvars.getHere();
    m.interpret(': FIVE 5 ;');
    const afterHere = m.sysvars.getHere();
    expect(afterHere).not.toBe(beforeHere);

    m.interpret(`${beforeHere} HERE-ADDR !`);
    expect(m.sysvars.getHere()).toBe(beforeHere);
    // Confirmed from the Forth side too, not just the TS accessor.
    m.interpret('HERE .');
    expect(m.screen.readRowText(0).trimEnd()).toBe(String(beforeHere));
  });
});

describe('getPrimitiveNote (web-only monitor-panel tooltip support)', () => {
  it('returns the rebel-opcodes.json note for a primitive that has one', () => {
    // ABORT's note is a stable, unlikely-to-churn one (M17) — matched
    // loosely (a substring) so this doesn't break if the note's wording
    // is later polished without changing its meaning.
    expect(getPrimitiveNote('ABORT')).toContain('DEVELOPING.md');
  });

  it('is case-insensitive, matching every other dictionary lookup', () => {
    expect(getPrimitiveNote('abort')).toBe(getPrimitiveNote('ABORT'));
  });

  it('returns undefined for a primitive with no recorded note (e.g. DUP)', () => {
    expect(getPrimitiveNote('DUP')).toBeUndefined();
  });

  it('returns undefined for a user-defined word — notes only ever come from rebel-opcodes.json', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    expect(getPrimitiveNote('SQUARE')).toBeUndefined();
  });

  it('returns undefined for an unrecognized name entirely', () => {
    expect(getPrimitiveNote('NOSUCHWORD')).toBeUndefined();
  });
});
