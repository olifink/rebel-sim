import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { Channel } from './channel.js';

describe('Machine.interpret', () => {
  it('evaluates a basic arithmetic expression', () => {
    const m = new Machine();
    m.interpret('2 3 + .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('5');
  });

  it('supports stack shuffling words', () => {
    const m = new Machine();
    m.interpret('1 2 SWAP');
    expect(m.stack.toArray()).toEqual([1, 2]);
  });

  it('DUP/DROP/OVER/ROT behave per their stack effects', () => {
    const m = new Machine();
    m.interpret('1 2 3 ROT');
    expect(m.stack.toArray()).toEqual([1, 3, 2]);

    const m2 = new Machine();
    m2.interpret('5 DUP');
    expect(m2.stack.toArray()).toEqual([5, 5]);

    const m3 = new Machine();
    m3.interpret('5 DROP');
    expect(m3.stack.depth).toBe(0);

    const m4 = new Machine();
    m4.interpret('1 2 OVER');
    expect(m4.stack.toArray()).toEqual([1, 2, 1]);
  });

  it('comparisons use the -1/0 boolean convention', () => {
    const m = new Machine();
    m.interpret('3 3 =');
    expect(m.stack.pop()).toBe(-1);

    const m2 = new Machine();
    m2.interpret('3 4 =');
    expect(m2.stack.pop()).toBe(0);
  });

  it('EMIT writes a character at the cursor and CR moves to the next row', () => {
    const m = new Machine();
    m.interpret('65 EMIT');
    expect(m.screen.readRowText(0).trimEnd()).toBe('A');
    expect(m.screen.getCursorCol()).toBe(1);

    m.interpret('CR');
    expect(m.screen.getCursorCol()).toBe(0);
    expect(m.screen.getCursorRow()).toBe(1);
  });

  it('rejects unrecognized words', () => {
    const m = new Machine();
    expect(() => m.interpret('FROBNICATE')).toThrow(/unrecognized word/);
  });

  it('handles negative number literals', () => {
    const m = new Machine();
    m.interpret('-5 3 + .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('-2');
  });

  it('divides and mods with truncating semantics, and rejects divide-by-zero', () => {
    const m = new Machine();
    m.interpret('7 2 / .');
    m.interpret('7 2 MOD .');
    expect(m.screen.readRowText(0).trimEnd()).toBe('3 1');
    expect(() => m.interpret('1 0 /')).toThrow(/division by zero/);
  });
});

/** Test double for the M7 Channel abstraction — starts empty, fed data
 * on demand, so blocking behavior can be tested without a real Keyboard/
 * KMAP translation round-trip (PLAN.md's own suggested test shape). */
class FakeChannel implements Channel {
  private queue: number[] = [];
  push(byte: number): void {
    this.queue.push(byte);
  }
  hasData(): boolean {
    return this.queue.length > 0;
  }
  readByte(): number {
    return this.queue.length > 0 ? this.queue.shift()! : -1;
  }
}

describe('Machine step-driven execution (M7)', () => {
  it('step() reports idle when there is no session', () => {
    const m = new Machine();
    expect(m.step(10)).toBe('idle');
  });

  it('a budget of 1 makes exactly one step of progress at a time', () => {
    const m = new Machine();
    m.interpret(': DOUBLE DUP + ;');

    m.beginLine('5 DOUBLE');
    expect(m.step(1)).toBe('more-to-run'); // '5' pushed
    expect(m.stack.toArray()).toEqual([5]);
    expect(m.step(1)).toBe('more-to-run'); // DUP
    expect(m.stack.toArray()).toEqual([5, 5]);
    expect(m.step(1)).toBe('more-to-run'); // +
    expect(m.stack.toArray()).toEqual([10]);
    expect(m.step(1)).toBe('more-to-run'); // EXIT (ip reset, no stack change)
    expect(m.stack.toArray()).toEqual([10]);
    expect(m.step(1)).toBe('idle'); // session finishes
    expect(m.stack.toArray()).toEqual([10]);
  });

  it('a large budget drives a whole line in one step() call, same as interpret()', () => {
    const m = new Machine();
    m.interpret(': DOUBLE DUP + ;');
    m.beginLine('5 DOUBLE');
    expect(m.step(1000)).toBe('idle');
    expect(m.stack.toArray()).toEqual([10]);
  });

  it('beginLine() throws if a previous session is still running or blocked', () => {
    const channel = new FakeChannel();
    const m = new Machine({ channel });
    m.beginLine('KEY'); // blocks immediately, channel is empty
    expect(() => m.beginLine('1 2 +')).toThrow(/still running or blocked/);
  });

  it('blocking KEY suspends the session and resumes once the bound channel has data', () => {
    const channel = new FakeChannel();
    const m = new Machine({ channel });

    m.beginLine('KEY 1 +');
    expect(m.step(10)).toBe('blocked');
    expect(m.stack.depth).toBe(0);

    channel.push(65); // 'A'
    expect(m.step(10)).toBe('idle');
    expect(m.stack.pop()).toBe(66); // 65 + 1
  });

  it('step() repeatedly returns blocked without consuming the session while the channel stays empty', () => {
    const channel = new FakeChannel();
    const m = new Machine({ channel });
    m.beginLine('KEY');
    expect(m.step(5)).toBe('blocked');
    expect(m.step(5)).toBe('blocked');
    expect(m.step(5)).toBe('blocked');
    channel.push(1);
    expect(m.step(5)).toBe('idle');
  });

  it('an error thrown mid-session clears it, allowing a new line to begin', () => {
    const m = new Machine();
    m.beginLine('FROBNICATE');
    expect(() => m.step(10)).toThrow(/unrecognized word/);
    expect(() => m.beginLine('1 2 +')).not.toThrow();
  });
});
