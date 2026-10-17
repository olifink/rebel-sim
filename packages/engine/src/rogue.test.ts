import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { NULL_SCREEN_HAL, ScreenHal } from './screen.js';
import { AMPLE_STEP_BUDGET, bootMachineWith } from './test-support.js';

function recording(): { hal: ScreenHal; draws: number[][] } {
  const draws: number[][] = [];
  return { draws, hal: { ...NULL_SCREEN_HAL, blitSprite: (x, y, _p, w) => void draws.push([x, y, w]) } };
}

/** Runs the REPL until it waits: for a frame (a game) or a key (the prompt). */
function settle(m: Machine): string {
  let status = '';
  for (let i = 0; i < 500; i++) {
    status = m.step(AMPLE_STEP_BUDGET);
    if (status === 'frame' || status === 'blocked') break;
  }
  return status;
}

/** One displayed frame: the host's screen_frame(), then run to the next VSYNC. */
function frame(m: Machine): string {
  m.screen.frame();
  m.keyboard.tick();
  return settle(m);
}

const slotX = (m: Machine, i: number): number => m.arena.readCell(m.banks.findBankByName('RENDER')!.base + i * 16 + 4);
const sysv = (m: Machine, offset: number): number => m.arena.readCell(m.banks.findBankByName('SYSV')!.base + offset);

describe('ROGUE, the demo game (rogue.fth, M86)', () => {
  it('draws a frame, moves the hero with a held key, and Esc returns to the prompt', () => {
    const { hal, draws } = recording();
    const m = bootMachineWith(['ROGUE'], { screenHal: hal });
    m.interpret('ROGUE');
    m.startRepl();
    expect(settle(m)).toBe('frame');

    // The first frame: the walls (8 x 8 tiles), the hero, 5 enemies, 5 coins.
    const tiles = draws.filter((d) => d[2] === 8);
    expect(tiles.length).toBe(2 * 40 + 2 * 22 + 5); // walls, plus the 5 coins
    expect(draws.filter((d) => d[2] === 16)).toHaveLength(6); // hero + enemies
    expect(sysv(m, 168)).toBe(0); // REPEAT-DELAY off while playing

    const start = slotX(m, 0);
    m.keyboard.pushRawEvent(0x4f, true); // hold Right
    for (let i = 0; i < 10; i++) expect(frame(m)).toBe('frame');
    expect(slotX(m, 0)).toBe(start + 20);
    m.keyboard.pushRawEvent(0x4f, false);

    m.keyboard.pushRawEvent(0x29, true); // Esc
    expect(frame(m)).toBe('blocked'); // back at the prompt, waiting for a key
    expect(sysv(m, 448)).toBe(0); // ENV-ENTRY: home
    expect(sysv(m, 168)).toBe(500); // repeat restored
  });

  it('re-entering resumes the same game rather than starting a new one', () => {
    const m = bootMachineWith(['ROGUE']);
    m.interpret('ROGUE');
    m.startRepl();
    settle(m);
    m.keyboard.pushRawEvent(0x4f, true);
    for (let i = 0; i < 5; i++) frame(m);
    m.keyboard.pushRawEvent(0x4f, false);
    const moved = slotX(m, 0);
    m.keyboard.pushRawEvent(0x29, true);
    frame(m);
    m.keyboard.pushRawEvent(0x29, false);

    // Type ROGUE at the prompt.
    for (const u of [0x15, 0x12, 0x0a, 0x18, 0x08, 0x28]) {
      m.keyboard.pushRawEvent(u, true);
      m.keyboard.pushRawEvent(u, false);
    }
    expect(settle(m)).toBe('frame');
    expect(slotX(m, 0)).toBe(moved);
  });

  it('waits on every entry: nothing moves until a key other than Esc is pressed', () => {
    const { hal, draws } = recording();
    const m = bootMachineWith(['ROGUE'], { screenHal: hal });
    m.interpret('ROGUE');
    m.startRepl();
    settle(m);
    expect(draws.filter((d) => d[2] === 16)).toHaveLength(6); // sprites shown while waiting
    const enemy = slotX(m, 1);
    for (let i = 0; i < 5; i++) frame(m);
    expect(slotX(m, 1)).toBe(enemy); // still waiting
    expect(m.screen.readRowText(15)).toContain('PRESS A KEY TO START');
    m.keyboard.pushRawEvent(0x2c, true); // Space starts it
    m.keyboard.pushRawEvent(0x2c, false);
    for (let i = 0; i < 5; i++) frame(m);
    expect(slotX(m, 1)).not.toBe(enemy);
  });
});

