import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';

const LSHIFT = 0x81; // pseudo-usage-code for Left Shift (0x80 + bit 1)

describe('Keyboard', () => {
  it('translates an unshifted printable key press', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x04, true); // 'a'
    const event = m.keyboard.readEvent();
    expect(event?.char).toBe('a'.charCodeAt(0));
    expect(event?.pressed).toBe(true);
    expect(event?.usageCode).toBe(0x04);
  });

  it('translates a shifted printable key press while Shift is held', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(LSHIFT, true);
    m.keyboard.pushRawEvent(0x04, true); // 'a' -> 'A' while shifted
    m.keyboard.readEvent(); // discard the shift-press event
    const event = m.keyboard.readEvent();
    expect(event?.char).toBe('A'.charCodeAt(0));
  });

  it('translates the digit row and its shifted symbol row', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x1e, true); // '1'
    expect(m.keyboard.readEvent()?.char).toBe('1'.charCodeAt(0));

    m.keyboard.pushRawEvent(LSHIFT, true);
    m.keyboard.readEvent();
    m.keyboard.pushRawEvent(0x1e, true); // '1' shifted -> '!'
    expect(m.keyboard.readEvent()?.char).toBe('!'.charCodeAt(0));
  });

  it('translates Enter/Backspace/Tab/Space/Escape identically on both planes', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x28, true); // Enter
    expect(m.keyboard.readEvent()?.char).toBe(10);
    m.keyboard.pushRawEvent(0x2a, true); // Backspace
    expect(m.keyboard.readEvent()?.char).toBe(8);
    m.keyboard.pushRawEvent(0x2b, true); // Tab
    expect(m.keyboard.readEvent()?.char).toBe(9);
    m.keyboard.pushRawEvent(0x2c, true); // Space
    expect(m.keyboard.readEvent()?.char).toBe(32);
    m.keyboard.pushRawEvent(0x29, true); // Escape — M57, TS's own cancel key
    expect(m.keyboard.readEvent()?.char).toBe(27);
    m.keyboard.pushRawEvent(0x52, true); // Up — M57 follow-up, TS's cursor movement
    expect(m.keyboard.readEvent()?.char).toBe(2);
    m.keyboard.pushRawEvent(0x51, true); // Down
    expect(m.keyboard.readEvent()?.char).toBe(3);
    m.keyboard.pushRawEvent(0x4f, true); // Right
    expect(m.keyboard.readEvent()?.char).toBe(4);
    m.keyboard.pushRawEvent(0x50, true); // Left
    expect(m.keyboard.readEvent()?.char).toBe(5);
  });

  it('leaves untranslated keys (Caps Lock, F-keys, arrows) at char 0, identified only by usageCode', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x39, true); // Caps Lock
    const event = m.keyboard.readEvent();
    expect(event?.char).toBe(0);
    expect(event?.usageCode).toBe(0x39);
  });

  it('releases carry no translated character even for printable keys', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x04, false); // release of 'a', never pressed here
    const event = m.keyboard.readEvent();
    expect(event?.char).toBe(0);
    expect(event?.pressed).toBe(false);
  });

  it('modifier press/release updates the KEYBOARD.MODIFIERS sysvar via the 0x80+bit convention', () => {
    const m = new Machine();
    expect(m.keyboard.getModifiers()).toBe(0);
    m.keyboard.pushRawEvent(LSHIFT, true);
    expect(m.keyboard.getModifiers()).toBe(0x02);
    m.keyboard.pushRawEvent(LSHIFT, false);
    expect(m.keyboard.getModifiers()).toBe(0);
  });

  it('left and right modifier bits stay independently tracked', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x80, true); // Left Ctrl
    m.keyboard.pushRawEvent(0x84, true); // Right Ctrl
    expect(m.keyboard.getModifiers()).toBe(0x11);
    m.keyboard.pushRawEvent(0x80, false);
    expect(m.keyboard.getModifiers()).toBe(0x10);
  });

  it('drops new events once the queue is full, matching PushEvent', () => {
    const m = new Machine();
    for (let i = 0; i < 40; i++) {
      m.keyboard.pushRawEvent(0x04, true);
    }
    let count = 0;
    while (m.keyboard.readEvent()) {
      count++;
    }
    expect(count).toBe(31); // KEYBOARD_QUEUE_SIZE - 1, one slot sacrificed for full/empty detection
  });

  it('KEY? reflects queue state without consuming', () => {
    const m = new Machine();
    m.interpret('KEY?');
    expect(m.stack.pop()).toBe(0); // FALSE, empty queue
    m.keyboard.pushRawEvent(0x04, true);
    m.interpret('KEY?');
    expect(m.stack.pop()).toBe(-1); // TRUE
    m.interpret('KEY?');
    expect(m.stack.pop()).toBe(-1); // still queued, KEY? doesn't pop
  });

  it('KEY pops the translated character', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x04, true); // 'a'
    m.interpret('KEY');
    expect(m.stack.pop()).toBe('a'.charCodeAt(0));
  });

  it('KEY blocks (does not throw) when the queue is empty, and resumes once data arrives', () => {
    const m = new Machine();
    m.interpret('KEY'); // starts the session; blocks immediately, empty queue
    expect(m.stack.depth).toBe(0); // nothing pushed yet

    m.keyboard.pushRawEvent(0x04, true); // 'a' arrives
    const status = m.step(100);
    expect(status).toBe('idle'); // session completed
    expect(m.stack.pop()).toBe('a'.charCodeAt(0));
  });
});
