import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';

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

  it('self-hosted DEPTH (system.fth, post-boot) matches a fresh empty stack — regression for a real bug found by Oliver', () => {
    // system.fth's own `: DEPTH SP0 SP@ - 4 / ;` pushed SP0 onto the data
    // stack *before* calling SP@, so SP@ read the pointer with SP0's own
    // push already counted -- every self-hosted DEPTH result was off by
    // one (a freshly booted, genuinely empty stack reported DEPTH 1, not
    // 0). Fixed by reordering to `SP@ SP0 SWAP - 4 /`, so SP@ reads the
    // pointer before DEPTH pushes anything of its own.
    const m = bootMachine();
    m.interpret('DEPTH');
    expect(m.stack.pop()).toBe(0);

    m.interpret('1 2 3 DEPTH');
    expect(m.stack.pop()).toBe(3);
    expect(m.stack.toArray()).toEqual([3, 2, 1]);
  });

  it('self-hosted PICK (system.fth, post-boot) matches DUP/OVER for 0/1 — regression for a real bug found by Oliver', () => {
    // system.fth's own `: PICK CELLS SP@ + @ ;` read one cell too shallow:
    // it never accounted for its own argument's slot sitting between
    // SP@'s reading point and the item PICK actually wants. `0 PICK`
    // collided with that leftover argument slot and returned
    // self-referential garbage (an address, not a stack value); every
    // other index returned what should have been index-1's value.
    // Fixed by adding `1+` before `CELLS`, matching `: PICK 1+ CELLS
    // SP@ + @ ;`.
    const m = bootMachine();
    m.interpret('10 20 30');
    m.interpret('0 PICK');
    expect(m.stack.pop()).toBe(30); // 0 PICK == DUP
    m.interpret('1 PICK');
    expect(m.stack.pop()).toBe(20); // 1 PICK == OVER
    m.interpret('2 PICK');
    expect(m.stack.pop()).toBe(10);
    expect(m.stack.toArray()).toEqual([30, 20, 10]); // untouched below
  });

  it('self-hosted .S (system.fth, post-boot) prints bottom-to-top with no garbage top item — regression for a real bug found by Oliver', () => {
    // .S's own `DEPTH 1- I - PICK` reaches index 0 (the top item) on its
    // very last iteration -- exactly where the PICK bug above bites
    // hardest, so a fresh-looking "SP - 4" garbage value showed up as
    // the top (last-printed) entry while every other entry printed the
    // wrong (shifted) value beneath it.
    const m = bootMachine();
    m.interpret('10 20 30 .S');
    expect(m.screen.readRowText(0).trimEnd()).toBe('10 20 30');
    expect(m.stack.toArray()).toEqual([30, 20, 10]); // .S is non-destructive
  });

  it('self-hosted 2OVER (system.fth, post-boot) matches the standard ( a b c d -- a b c d a b ) — regression for a real bug found by Oliver', () => {
    // 2OVER is built from two `3 PICK` calls and was silently broken by
    // the same underlying PICK bug (it happened to still typecheck/run,
    // just with the wrong values), even though its own source comment
    // already described the *intended*, PICK-correct reasoning.
    const m = bootMachine();
    m.interpret('1 2 3 4 2OVER');
    expect(m.stack.toArray()).toEqual([2, 1, 4, 3, 2, 1]);
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
