import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

/** Presses and releases a printable key by USB HID usage code, exactly
 * as the browser host would after translating a DOM keydown/keyup. */
function type(m: Machine, usageCode: number): void {
  m.keyboard.pushRawEvent(usageCode, true);
}

const KEY_A = 0x04;
const KEY_B = 0x05;
const KEY_C = 0x06;
const KEY_X = 0x1b;
const ENTER = 0x28;
const BACKSPACE = 0x2a;

describe('ACCEPT (M7a)', () => {
  it('reads chars until Enter, echoing each, and pushes the actual length', () => {
    const m = new Machine();
    const addr = m.dictBank.base; // safe unused scratch this early

    m.interpret(`${addr} 8 ACCEPT`); // blocks immediately, queue empty
    type(m, KEY_A);
    type(m, KEY_B);
    type(m, ENTER);
    expect(m.step(50)).toBe('idle');

    expect(m.stack.pop()).toBe(2);
    expect(m.arena.readByte(addr)).toBe('a'.charCodeAt(0));
    expect(m.arena.readByte(addr + 1)).toBe('b'.charCodeAt(0));
    expect(m.screen.readRowText(0).trimEnd()).toBe('ab');
  });

  it('backspace erases the last echoed character and its buffer slot', () => {
    const m = new Machine();
    const addr = m.dictBank.base;

    m.interpret(`${addr} 8 ACCEPT`);
    type(m, KEY_A);
    type(m, KEY_B);
    type(m, BACKSPACE);
    type(m, KEY_C);
    type(m, ENTER);
    expect(m.step(50)).toBe('idle');

    expect(m.stack.pop()).toBe(2);
    expect(m.arena.readByte(addr)).toBe('a'.charCodeAt(0));
    expect(m.arena.readByte(addr + 1)).toBe('c'.charCodeAt(0));
    expect(m.screen.readRowText(0).trimEnd()).toBe('ac');
  });

  it('backspace before any character was typed does nothing (cannot erase the prompt)', () => {
    const m = new Machine();
    const addr = m.dictBank.base;

    m.interpret(`${addr} 8 ACCEPT`);
    type(m, BACKSPACE);
    type(m, KEY_X);
    type(m, ENTER);
    expect(m.step(50)).toBe('idle');

    expect(m.stack.pop()).toBe(1);
    expect(m.arena.readByte(addr)).toBe('x'.charCodeAt(0));
    expect(m.screen.readRowText(0).trimEnd()).toBe('x');
  });

  it('stops storing/echoing once maxLen is reached but keeps listening for Enter', () => {
    const m = new Machine();
    const addr = m.dictBank.base;

    m.interpret(`${addr} 2 ACCEPT`);
    type(m, KEY_A);
    type(m, KEY_B);
    type(m, KEY_C); // dropped — buffer already full
    type(m, ENTER);
    expect(m.step(50)).toBe('idle');

    expect(m.stack.pop()).toBe(2);
    expect(m.screen.readRowText(0).trimEnd()).toBe('ab');
  });

  it('backspace wraps back across a screen row boundary', () => {
    const m = new Machine();
    const addr = m.dictBank.base;
    const cols = m.screen.cols;

    m.interpret(`${addr} ${cols + 1} ACCEPT`);
    for (let i = 0; i < cols; i++) {
      // Drain each keystroke immediately — the keyboard queue's real
      // capacity (31, KEYBOARD_QUEUE_SIZE - 1) is smaller than a full
      // row here, so pushing all `cols` events up front would silently
      // drop the overflow (matches real hardware: nothing buffers an
      // unbounded backlog of unconsumed keystrokes).
      type(m, KEY_A);
      m.step(10);
    }
    expect(m.screen.getCursorRow()).toBe(1); // fills row 0 exactly, wraps cursor to row 1 col 0
    expect(m.screen.getCursorCol()).toBe(0);

    type(m, BACKSPACE); // should erase the last 'a' back on row 0
    type(m, ENTER);
    expect(m.step(50)).toBe('idle');

    expect(m.stack.pop()).toBe(cols - 1);
    expect(m.screen.getCursorRow()).toBe(0);
    expect(m.screen.getCursorCol()).toBe(cols - 1);
  });
});
