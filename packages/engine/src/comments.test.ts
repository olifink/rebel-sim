import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { findWord } from './dictionary.js';
import { CELL_SIZE } from './arena.js';
import { bootMachine } from './test-support.js';

describe('Comments (DEVELOPING.md §2, M11; discard reverted M44)', () => {
  it('a comment inside a definition has zero runtime stack effect', () => {
    const m = new Machine();
    m.interpret(': FIVE ( push five ) 5 ;');
    m.interpret('FIVE');
    expect(m.stack.toArray()).toEqual([5]);
  });

  it('discards a comment rather than compiling it as inline data — verified by reading the compiled bytes directly, not just that it runs harmlessly', () => {
    // M11 originally compiled this as (SLIT)+2DROP so SEE could echo the
    // comment back; reverted (M44) since SEE printed it indistinguishably
    // from a genuine discarded string, never as ( ... ) syntax. FOO's body
    // should now be exactly LIT 5 EXIT — no (SLIT)/2DROP cells between the
    // Code Field and the literal at all.
    const m = new Machine();
    m.interpret(': FOO ( a note ) 5 ;');
    const entry = findWord(m, 'FOO')!;
    const litCfa = m.arena.readCell(entry.cfa + CELL_SIZE);
    expect(litCfa).toBe(findWord(m, 'LIT')!.cfa);
    const value = m.arena.readCell(entry.cfa + CELL_SIZE * 2);
    expect(value).toBe(5);
    const exitCfa = m.arena.readCell(entry.cfa + CELL_SIZE * 3);
    expect(exitCfa).toBe(findWord(m, 'EXIT')!.cfa);
  });

  it('a multi-word comment (spaces preserved via token-rejoin) parses and stores correctly', () => {
    const m = new Machine();
    m.interpret(': FOO ( this is a longer note about FOO ) 42 ;');
    m.interpret('FOO');
    expect(m.stack.toArray()).toEqual([42]);
  });

  it('a comment immediately before ; does not interfere with closing the definition', () => {
    const m = new Machine();
    m.interpret(': FOO 5 ( trailing note ) ;');
    m.interpret('FOO');
    expect(m.stack.toArray()).toEqual([5]);
  });

  it('a comment typed loose at the prompt is silently discarded: no stack effect, no dictionary change', () => {
    const m = new Machine();
    const before = m.sysvars.getLatest();
    m.interpret('( just a note, nothing to compile into )');
    expect(m.stack.toArray()).toEqual([]);
    expect(m.sysvars.getLatest()).toBe(before);
  });

  it('an unterminated comment throws the same input-exhausted error nextInputToken already raises', () => {
    const m = new Machine();
    expect(() => m.interpret(': FOO ( never closed 5 ;')).toThrow(/input ended/);
  });

  it('a word with a comment can be called more than once, correctly, each time', () => {
    const m = new Machine();
    m.interpret(': DOUBLE ( n -- 2n ) DUP + ;');
    m.interpret('3 DOUBLE');
    m.interpret('10 DOUBLE');
    expect(m.stack.toArray()).toEqual([20, 6]); // top-first: 20 (most recent) on top, 6 underneath
  });
});

describe('\\ (rest-of-line comment, spec/04-FORTH-CORE.md §6.7, M68 follow-up)', () => {
  // A BOOTSTRAP word (system.fth), built on WORD, not a primitive — needs
  // the real bootstrap layer loaded, unlike ( 's tests above.
  it('discards everything to the end of the line, including unbalanced parens', () => {
    const m = bootMachine();
    m.interpret('5 3 + \\ this comment has (nested) parens and a lone 148) too');
    expect(m.stack.toArray()).toEqual([8]);
  });

  it('works inside a colon-definition, IMMEDIATE, same as (', () => {
    const m = bootMachine();
    m.interpret(': FOO 1 2 + \\ adds one and two, deliberately including a )');
    m.interpret('  3 + ;');
    m.interpret('FOO');
    expect(m.stack.toArray()).toEqual([6]);
  });

  it('a bare backslash with nothing following it is a no-op', () => {
    const m = bootMachine();
    m.interpret('42 \\');
    expect(m.stack.toArray()).toEqual([42]);
  });

  it('only comments out the rest of its own line — a later interpret() call is unaffected', () => {
    const m = bootMachine();
    m.interpret('1 \\ comments out everything after it, but not the 1 before it');
    m.interpret('2');
    expect(m.stack.toArray()).toEqual([2, 1]); // top-first: 2 (most recent) on top, 1 underneath
  });
});
