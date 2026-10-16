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

describe('EKEY / EKEY? (M76, spec/04-FORTH-CORE.md §6.9)', () => {
  const pack = (usage: number, mods: number, char: number): number => usage | (mods << 8) | (char << 16);

  it('returns key presses packed as usage | modifiers << 8 | char << 16, skipping releases and modifier-only events', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(LSHIFT, true); // modifier-only: skipped
    m.keyboard.pushRawEvent(0x04, true); // shifted 'a' -> 'A'
    m.keyboard.pushRawEvent(0x04, false); // release: skipped
    m.keyboard.pushRawEvent(LSHIFT, false); // modifier-only: skipped
    m.keyboard.pushRawEvent(0x3a, true); // F1: no translated char
    m.keyboard.pushRawEvent(0x28, true); // Enter, unshifted

    m.interpret('EKEY EKEY EKEY');
    expect(m.stack.toArray()).toEqual([pack(0x28, 0, 10), pack(0x3a, 0, 0), pack(0x04, 0x02, 65)]);
    m.stack.clear();

    m.interpret('EKEY?');
    expect(m.stack.pop()).toBe(0); // queue now empty
    m.keyboard.pushRawEvent(0x04, false); // only a release queued
    m.interpret('EKEY?');
    expect(m.stack.pop()).toBe(0);
    m.keyboard.pushRawEvent(0x05, true);
    m.interpret('EKEY?');
    expect(m.stack.pop()).toBe(-1);
  });

  it('blocks like KEY until a press arrives, ignoring a release that arrives first', () => {
    const m = new Machine();
    m.beginLine('EKEY 1 +');
    expect(m.step(10)).toBe('blocked');
    m.keyboard.pushRawEvent(0x04, false);
    expect(m.step(10)).toBe('blocked');
    m.keyboard.pushRawEvent(0x04, true); // 'a'
    expect(m.step(1000)).toBe('idle');
    expect(m.stack.toArray()).toEqual([pack(0x04, 0, 97) + 1]);
  });

  it('shares the one keyboard queue with KEY: a key EKEY takes is gone for KEY', () => {
    const m = new Machine();
    m.keyboard.pushRawEvent(0x04, true); // 'a'
    m.keyboard.pushRawEvent(0x05, true); // 'b'
    m.interpret('EKEY DROP KEY');
    expect(m.stack.toArray()).toEqual([98]);
  });
});

describe('auto-repeat (M85, spec/01-HAL.md §4.3)', () => {
  function clocked() {
    const clock = { now: 0 };
    const m = new Machine({ timingHal: { millis: () => clock.now } });
    const at = (ms: number) => {
      clock.now = ms;
      m.keyboard.tick();
    };
    const drain = (): number[] => {
      const events: number[] = [];
      while (m.keyboard.hasKeyPress()) {
        m.interpret('EKEY');
        events.push(m.stack.pop());
      }
      while (m.keyboard.readEvent()) {
        // releases and modifiers: not presses
      }
      return events;
    };
    return { m, at, drain };
  }
  const REPEAT = 1 << 24;

  it('repeats a held key after REPEAT-DELAY, then every REPEAT-RATE, marking repeats', () => {
    const { m, at, drain } = clocked();
    m.keyboard.pushRawEvent(0x04, true); // 'a' at t = 0
    expect(drain()).toEqual([0x04 | (97 << 16)]); // the real press, unmarked
    at(499);
    expect(drain()).toEqual([]);
    at(500);
    expect(drain()).toEqual([0x04 | (97 << 16) | REPEAT]);
    at(549);
    expect(drain()).toEqual([]);
    at(550);
    expect(drain()).toHaveLength(1);
    at(5000); // a long gap between ticks: still only one, no flood
    expect(drain()).toHaveLength(1);
  });

  it('stops on release, never repeats a modifier, follows the newest key, and carries the modifiers held now', () => {
    const { m, at, drain } = clocked();
    m.keyboard.pushRawEvent(0x81, true); // Shift alone: no repeat
    at(1000);
    expect(drain()).toEqual([]);
    m.keyboard.pushRawEvent(0x04, true); // Shift-a at t = 1000
    m.keyboard.pushRawEvent(0x05, true); // then b: b takes over
    drain();
    at(1500);
    expect(drain()).toEqual([0x05 | (0x02 << 8) | (66 << 16) | REPEAT]); // 'B', shifted
    m.keyboard.pushRawEvent(0x05, false);
    at(2000);
    expect(drain()).toEqual([]);
    expect(m.keyboard.isRepeating()).toBe(false);
  });

  it('REPEAT-DELAY 0 turns it off; repeats reach KEY and leave held-key state alone', () => {
    const { m, at, drain } = clocked();
    expect(m.sysvars.get('KEYBOARD', 'REPEAT-DELAY')).toBe(500);
    expect(m.sysvars.get('KEYBOARD', 'REPEAT-RATE')).toBe(50);
    m.sysvars.set('KEYBOARD', 'REPEAT-DELAY', 0);
    m.keyboard.pushRawEvent(0x04, true);
    drain();
    at(10_000);
    expect(drain()).toEqual([]);
    expect(m.keyboard.isRepeating()).toBe(false);

    m.sysvars.set('KEYBOARD', 'REPEAT-DELAY', 500);
    m.keyboard.pushRawEvent(0x05, true); // b at t = 10000
    at(10_500);
    m.interpret('KEY KEY'); // the press, then the repeat, as characters
    expect(m.stack.toArray()).toEqual([98, 98]);
  });
});
