import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { RemoteChannel } from './channel.js';

describe('ABORT (DEVELOPING.md §9, M17)', () => {
  it('empties a non-empty data stack and throws', () => {
    const m = new Machine();
    expect(() => m.interpret('1 2 3 ABORT')).toThrow('ABORT');
    expect(m.stack.depth).toBe(0);
  });

  it('is a plain Error, not a dedicated class — per the tabled THROW/CATCH scope, nothing needs to distinguish it', () => {
    const m = new Machine();
    expect(() => m.interpret('ABORT')).toThrow(Error);
    expect(() => m.interpret('ABORT')).toThrow('ABORT');
  });

  it("interpret()'s error contract is unchanged — no auto stack-clear outside the interactive REPL loop", () => {
    const m = new Machine();
    m.interpret('1 2 3');
    expect(() => m.interpret('UNRECOGNIZED-WORD')).toThrow(/unrecognized word/);
    // Deliberately still there — interpret()/runLine() never resets the
    // stack on error, only replLoop does (see the tests below).
    expect(m.stack.depth).toBe(3);
  });
});

describe('replLoop stack recovery on uncaught errors (DEVELOPING.md §9, M17)', () => {
  it('clears the data stack after an uncaught error typed at the interactive prompt', () => {
    const remote = new RemoteChannel();
    const m = new Machine({ channel: remote });
    m.startRepl();
    m.step(10); // block on the first ACCEPT

    remote.push('1 2 3 UNRECOGNIZED-WORD\n');
    const status = m.step(500);

    expect(status).toBe('blocked'); // loop survived and is prompting again
    expect(m.stack.depth).toBe(0);
  });

  it('fixes the confirmed rstack leak: threadFrom pushes a sentinel with no try/finally, so an uncaught error used to leave it on rstack forever', () => {
    const remote = new RemoteChannel();
    const m = new Machine({ channel: remote });
    m.startRepl();
    m.step(10);

    // A word that throws (stack underflow) once actually called, so the
    // error surfaces from inside a real threadFrom() call, not straight
    // from the outer interpreter's own word lookup.
    remote.push(': BAD DUP ;\n');
    m.step(500);
    expect(m.rstack.depth).toBe(0);

    remote.push('BAD\n');
    m.step(500);
    expect(m.rstack.depth).toBe(0); // was 1 before the fix

    remote.push('BAD\n');
    m.step(500);
    expect(m.rstack.depth).toBe(0); // was 2 before the fix, growing without bound
  });

  it('ABORT itself, typed at the prompt, leaves a clean prompt (both stacks empty)', () => {
    const remote = new RemoteChannel();
    const m = new Machine({ channel: remote });
    m.startRepl();
    m.step(10);

    remote.push(': DEEP DUP ABORT ;\n');
    m.step(500);

    remote.push('1 2 3 DEEP\n');
    const status = m.step(500);

    expect(status).toBe('blocked');
    expect(m.stack.depth).toBe(0);
    expect(m.rstack.depth).toBe(0);
  });
});
