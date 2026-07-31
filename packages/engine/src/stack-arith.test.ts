import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

function run(line: string): number[] {
  const m = new Machine();
  m.interpret(line);
  return m.stack.toArray();
}

describe('Stack/arithmetic rounding out (M8, CORE-VOCABULARY.md §9)', () => {
  it('2DUP', () => {
    expect(run('1 2 2DUP')).toEqual([2, 1, 2, 1]); // top-first: 2,1,2,1
  });

  it('2DROP', () => {
    expect(run('1 2 3 2DROP')).toEqual([1]);
  });

  it('-ROT', () => {
    expect(run('1 2 3 -ROT')).toEqual([2, 1, 3]); // ( a b c -- c a b ), top-first
  });

  it('TUCK', () => {
    expect(run('1 2 TUCK')).toEqual([2, 1, 2]); // ( a b -- b a b )
  });

  it('NIP', () => {
    expect(run('1 2 NIP')).toEqual([2]);
  });

  it('?DUP duplicates only when nonzero', () => {
    expect(run('5 ?DUP')).toEqual([5, 5]);
    expect(run('0 ?DUP')).toEqual([0]);
  });

  it('DEPTH', () => {
    expect(run('1 2 3 DEPTH')).toEqual([3, 3, 2, 1]);
  });

  it('/MOD', () => {
    expect(run('7 2 /MOD')).toEqual([3, 1]); // ( a b -- rem quot ), top-first: quot, rem
    expect(run('-7 2 /MOD')).toEqual([-3, -1]);
  });

  it('NEGATE and ABS', () => {
    expect(run('5 NEGATE')).toEqual([-5]);
    expect(run('-5 NEGATE')).toEqual([5]);
    expect(run('-5 ABS')).toEqual([5]);
    expect(run('5 ABS')).toEqual([5]);
  });

  it('MIN and MAX', () => {
    expect(run('3 7 MIN')).toEqual([3]);
    expect(run('3 7 MAX')).toEqual([7]);
  });

  it('1+ 1- 2+ 2- 2* 2/', () => {
    expect(run('5 1+')).toEqual([6]);
    expect(run('5 1-')).toEqual([4]);
    expect(run('5 2+')).toEqual([7]);
    expect(run('5 2-')).toEqual([3]);
    expect(run('5 2*')).toEqual([10]);
    expect(run('5 2/')).toEqual([2]); // arithmetic shift, truncates toward -inf like >>
  });

  it('<>', () => {
    expect(run('3 3 <>')).toEqual([0]);
    expect(run('3 4 <>')).toEqual([-1]);
  });

  it('0< and 0>', () => {
    expect(run('-1 0<')).toEqual([-1]);
    expect(run('1 0<')).toEqual([0]);
    expect(run('1 0>')).toEqual([-1]);
    expect(run('-1 0>')).toEqual([0]);
  });

  it('U< treats operands as unsigned', () => {
    // -1 as an unsigned 32-bit value is 4294967295, larger than 1.
    expect(run('-1 1 U<')).toEqual([0]);
    expect(run('1 -1 U<')).toEqual([-1]);
    expect(run('1 2 U<')).toEqual([-1]);
  });
});
