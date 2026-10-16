import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { AMPLE_STEP_BUDGET, bootMachine } from './test-support.js';

/** Steps until the session is idle or waiting on a frame. */
function run(m: Machine): string {
  let status = '';
  for (let i = 0; i < 200; i++) {
    status = m.step(AMPLE_STEP_BUDGET);
    if (status !== 'more-to-run') break;
  }
  return status;
}

describe('frames, time and held keys (M83, spec/13-GAME-LOOP.md §3-§5)', () => {
  it('VSYNC waits, reporting frame, until the host advances FRAME-COUNT', () => {
    const m = new Machine();
    m.beginLine('VSYNC 7');
    expect(run(m)).toBe('frame');
    expect(run(m)).toBe('frame'); // still the same frame
    expect(m.stack.toArray()).toEqual([]);
    m.screen.frame();
    expect(run(m)).toBe('idle');
    expect(m.stack.toArray()).toEqual([7]);
  });

  it('FRAME-COUNT counts frames and is readable from Forth', () => {
    const m = bootMachine();
    m.interpret('FRAME-COUNT @');
    const before = m.stack.pop();
    m.screen.frame();
    m.screen.frame();
    m.interpret('FRAME-COUNT @');
    expect(m.stack.pop()).toBe(before + 2);
  });

  it('MS@ reads the timing HAL; MS waits at least that long, a frame at a time', () => {
    let now = 1000;
    const m = bootMachine({ timingHal: { millis: () => now } });
    m.interpret('MS@');
    expect(m.stack.pop()).toBe(1000);

    m.beginLine('100 MS 5');
    expect(run(m)).toBe('frame');
    now = 1050;
    m.screen.frame();
    expect(run(m)).toBe('frame'); // 50 ms in: still waiting
    now = 1100;
    m.screen.frame();
    expect(run(m)).toBe('idle');
    expect(m.stack.toArray()).toEqual([5]);
  });

  it('KEY-DOWN? reports held keys, modifiers included, independent of reading the event queue', () => {
    const m = bootMachine();
    const down = (usage: number): number => {
      m.interpret(`${usage} KEY-DOWN?`);
      return m.stack.pop();
    };
    expect(down(0x50)).toBe(0); // Left, not held
    m.keyboard.pushRawEvent(0x50, true);
    m.keyboard.pushRawEvent(0x81, true); // Left Shift
    expect([down(0x50), down(0x81), down(0x4f)]).toEqual([-1, -1, 0]);
    m.interpret('EKEY DROP'); // reading the event changes nothing
    expect(down(0x50)).toBe(-1);
    m.keyboard.pushRawEvent(0x50, false);
    expect([down(0x50), down(0x81)]).toEqual([0, -1]);
  });
});
