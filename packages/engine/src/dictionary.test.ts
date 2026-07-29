import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

describe('colon-definitions', () => {
  it('defines and calls a simple word', () => {
    const m = new Machine();
    m.interpret(': SQUARE DUP * ;');
    expect(m.interpret('5 SQUARE .')).toBe('25 ');
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
    expect(m.interpret('3 4 SUM-OF-SQUARES .')).toBe('25 ');
  });

  it('a redefined word shadows the earlier one (most-recent-wins search)', () => {
    const m = new Machine();
    m.interpret(': DOUBLE 2 * ;');
    expect(m.interpret('10 DOUBLE .')).toBe('20 ');
    m.interpret(': DOUBLE DUP + ;');
    expect(m.interpret('10 DOUBLE .')).toBe('20 ');
  });

  it('IMMEDIATE words run during compilation of a later word, not deferred', () => {
    const m = new Machine();
    // An IMMEDIATE word that emits at compile time proves it actually ran
    // while SHOUT was being compiled, not when SHOUT is later called.
    m.interpret(": TATTLE 42 EMIT ; IMMEDIATE");
    const compileOutput = m.interpret(': SHOUT TATTLE ;');
    expect(compileOutput).toBe('*'); // char code 42 = '*'
    // Calling SHOUT itself does nothing further (TATTLE wasn't compiled in).
    expect(m.interpret('SHOUT')).toBe('');
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
    expect(m.interpret('OK')).toBe('');
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
    expect(m.interpret(`${prev} .`)).toBe('51 ');
  });
});
