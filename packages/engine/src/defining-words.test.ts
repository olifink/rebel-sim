import { describe, expect, it } from 'vitest';
import { bootMachine } from './test-support.js';

describe('Defining words (M8, CORE-VOCABULARY.md §7)', () => {
  it('HERE/LATEST are callable and track dictionary growth', () => {
    const m = bootMachine();
    m.interpret('HERE');
    const before = m.stack.pop();
    m.interpret(': FOO 1 2 + ;');
    m.interpret('HERE');
    const after = m.stack.pop();
    expect(after).toBeGreaterThan(before);

    m.interpret('LATEST');
    const latest = m.stack.pop();
    expect(latest).toBeGreaterThan(0);
  });

  it(', compiles a cell at HERE and ALLOT reserves raw space', () => {
    const m = bootMachine();
    m.interpret('HERE');
    const addr = m.stack.pop();
    m.interpret('99 ,');
    m.interpret(`${addr} @`);
    expect(m.stack.pop()).toBe(99);

    m.interpret('HERE');
    const beforeAllot = m.stack.pop();
    m.interpret('40 ALLOT');
    m.interpret('HERE');
    const afterAllot = m.stack.pop();
    expect(afterAllot - beforeAllot).toBe(40);
  });

  it('VARIABLE creates a word that pushes its own address; @/! read and write through it', () => {
    const m = bootMachine();
    m.interpret('VARIABLE COUNTER');
    m.interpret('COUNTER @'); // reserved cell starts at 0
    expect(m.stack.pop()).toBe(0);

    m.interpret('42 COUNTER !');
    m.interpret('COUNTER @');
    expect(m.stack.pop()).toBe(42);

    m.interpret('1 COUNTER +!');
    m.interpret('COUNTER @');
    expect(m.stack.pop()).toBe(43);
  });

  it('CONSTANT creates a word that pushes its stored value, not an address', () => {
    const m = bootMachine();
    m.interpret('100 CONSTANT HUNDRED');
    m.interpret('HUNDRED');
    expect(m.stack.pop()).toBe(100);
    m.interpret('HUNDRED HUNDRED +');
    expect(m.stack.pop()).toBe(200);
  });

  it('CREATE makes a bare word pushing its own parameter-field address; , /ALLOT can fill it', () => {
    const m = bootMachine();
    m.interpret('CREATE TABLE 10 , 20 , 30 ,');
    m.interpret('TABLE @');
    expect(m.stack.pop()).toBe(10);
    m.interpret('TABLE 4 + @');
    expect(m.stack.pop()).toBe(20);
    m.interpret('TABLE 8 + @');
    expect(m.stack.pop()).toBe(30);
  });

  it('the canonical CREATE...DOES> defining-word example (a simple CONSTANT-alike built from scratch)', () => {
    const m = bootMachine();
    // : CONST CREATE , DOES> @ ;  — defines a *new defining word* CONST;
    // `5 CONST FIVE` then creates FIVE, a word that pushes 5 when run.
    m.interpret(': CONST CREATE , DOES> @ ;');
    m.interpret('5 CONST FIVE');
    m.interpret('FIVE');
    expect(m.stack.pop()).toBe(5);
    m.interpret('FIVE FIVE +');
    expect(m.stack.pop()).toBe(10);
  });

  it('CREATE...DOES> can define multiple independent words, each with its own stored data', () => {
    const m = bootMachine();
    m.interpret(': CONST CREATE , DOES> @ ;');
    m.interpret('5 CONST FIVE');
    m.interpret('9 CONST NINE');
    m.interpret('FIVE NINE +');
    expect(m.stack.pop()).toBe(14);
  });

  it('DOES> can compile more than a single word after it', () => {
    const m = bootMachine();
    // : DOUBLER CREATE , DOES> @ 2 * ;  — FIVE-DOUBLER pushes 2x the stored value.
    m.interpret(': DOUBLER CREATE , DOES> @ 2 * ;');
    m.interpret('5 DOUBLER FIVE-DOUBLED');
    m.interpret('FIVE-DOUBLED');
    expect(m.stack.pop()).toBe(10);
  });

  it('VARIABLE/CONSTANT/CREATE are ordinary (non-immediate) words — usable directly at the prompt', () => {
    const m = bootMachine();
    expect(() => m.interpret('VARIABLE X')).not.toThrow();
    expect(() => m.interpret('7 CONSTANT SEVEN')).not.toThrow();
    expect(() => m.interpret('CREATE Y')).not.toThrow();
  });
});
