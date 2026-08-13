import { describe, expect, it } from 'vitest';
import { bootMachine } from './test-support.js';

describe('EXECUTE (DEVELOPING.md, deferred from M13 — nothing in scope needed it until now)', () => {
  it('EXECUTE on a primitive xt runs it exactly like a direct call', () => {
    const m = bootMachine();
    m.interpret('5 \' DUP EXECUTE');
    expect(m.stack.toArray()).toEqual([5, 5]);
  });

  it('EXECUTE on a colon-definition threads DOCOL correctly', () => {
    const m = bootMachine();
    m.interpret(': SQUARE DUP * ;');
    m.interpret('6 \' SQUARE EXECUTE');
    expect(m.stack.toArray()).toEqual([36]);
  });

  it('EXECUTE on a VARIABLE pushes its address, same as calling it directly', () => {
    const m = bootMachine();
    m.interpret('VARIABLE FOO');
    m.interpret('42 \' FOO EXECUTE !');
    m.interpret('FOO @');
    expect(m.stack.toArray()).toEqual([42]);
  });

  it('EXECUTE on a CONSTANT pushes its value, not an address', () => {
    const m = bootMachine();
    m.interpret('99 CONSTANT NINETY-NINE');
    m.interpret('\' NINETY-NINE EXECUTE');
    expect(m.stack.toArray()).toEqual([99]);
  });

  it('EXECUTE on a CREATE...DOES> word runs the does-code, not just DOVAR', () => {
    const m = bootMachine();
    m.interpret(': DOUBLER CREATE , DOES> @ 2 * ;');
    m.interpret('21 DOUBLER FORTY-TWO');
    m.interpret('\' FORTY-TWO EXECUTE');
    expect(m.stack.toArray()).toEqual([42]);
  });

  it('nested EXECUTE (a word EXECUTEd calls EXECUTE itself) recurses correctly via the shared rstack', () => {
    const m = bootMachine();
    m.interpret(': INC 1+ ;');
    m.interpret(': RUN-IT ( xt -- ) EXECUTE ;');
    m.interpret("5 ' INC ' RUN-IT EXECUTE");
    expect(m.stack.toArray()).toEqual([6]);
  });

  it('EXECUTE on an xt whose word body calls a compile-only IMMEDIATE control word works unchanged (breakpoints/blocking machinery untouched)', () => {
    const m = bootMachine();
    m.interpret(': ABS-ISH DUP 0< IF NEGATE THEN ;');
    m.interpret("-7 ' ABS-ISH EXECUTE");
    expect(m.stack.toArray()).toEqual([7]);
  });

  it('a breakpoint on a word fires correctly when reached indirectly via EXECUTE, not just a direct compiled call', () => {
    const m = bootMachine();
    m.interpret(': SQUARE DUP * ;');
    m.setBreakpoint('SQUARE');

    m.beginLine("5 ' SQUARE EXECUTE");
    expect(m.step(1000)).toBe('breakpoint');
    expect(m.pausedAtWord()).toBe('SQUARE');
    expect(m.stack.toArray()).toEqual([5]); // paused before SQUARE's body ran

    expect(m.step(1000)).toBe('idle');
    expect(m.stack.toArray()).toEqual([25]);
  });
});
