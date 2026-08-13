import { describe, expect, it } from 'vitest';
import { bootMachine as boot } from './test-support.js';

describe('FORGET (DEVELOPING.md §8.6)', () => {
  it('removes the forgotten word from lookup', () => {
    const m = boot();
    m.interpret(': FOO 1 ;');
    expect(() => m.interpret('FOO')).not.toThrow();
    m.interpret('FORGET FOO');
    expect(() => m.interpret('FOO')).toThrow(/unrecognized word/i);
  });

  it("reclaims the forgotten word's DICT space (HERE rolls back)", () => {
    const m = boot();
    m.interpret('HERE');
    const hereBefore = m.stack.pop();
    m.interpret(': FOO 1 2 3 ;');
    m.interpret('FORGET FOO');
    m.interpret('HERE');
    expect(m.stack.pop()).toBe(hereBefore);
  });

  it('keeps everything defined before the forgotten word', () => {
    const m = boot();
    m.interpret(': KEEPME 42 ;');
    m.interpret(': FOO 1 ;');
    m.interpret('FORGET FOO');
    m.interpret('KEEPME');
    expect(m.stack.pop()).toBe(42);
  });

  it('forgetting a word also forgets everything defined after it', () => {
    const m = boot();
    m.interpret(': FOO 1 ;');
    m.interpret(': BAR 2 ;');
    m.interpret('FORGET FOO');
    expect(() => m.interpret('BAR')).toThrow(/unrecognized word/i);
    expect(() => m.interpret('FOO')).toThrow(/unrecognized word/i);
  });

  it('errors on an unknown name, same as tick, and leaves the dictionary untouched', () => {
    const m = boot();
    m.interpret('HERE');
    const hereBefore = m.stack.pop();
    expect(() => m.interpret('FORGET NOSUCHWORD')).toThrow(/unrecognized word/i);
    m.interpret('HERE');
    expect(m.stack.pop()).toBe(hereBefore);
  });
});
