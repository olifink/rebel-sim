import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { NULL_SCREEN_HAL, ScreenHal } from './screen.js';
import { bootMachineWith } from './test-support.js';

/** Records SPRITE draws as [x, y, width] triples, in order. */
function recording(): { hal: ScreenHal; draws: number[][] } {
  const draws: number[][] = [];
  return {
    draws,
    hal: { ...NULL_SCREEN_HAL, blitSprite: (x, y, _p, w) => void draws.push([x, y, w]) },
  };
}

const top = (m: Machine): number => {
  m.interpret('');
  return m.stack.pop();
};

describe('the GAME module (game.fth, M86, spec/13-GAME-LOOP.md §7)', () => {
  it('spawns entities into free records, runs every active update word with its record, and kills them', () => {
    const m = bootMachineWith(['GAME']);
    m.interpret('VARIABLE RUNS  : TICKER ( rec -- ) REC-DATA + 1 SWAP +!  1 RUNS +! ;');
    m.interpret("3 16 NEW-ENTITIES  ' TICKER SPAWN ' TICKER SPAWN");
    const second = m.stack.pop();
    const first = m.stack.pop();
    expect(second).toBe(first + 16);
    m.interpret('RUN-ENTITIES RUN-ENTITIES RUNS @');
    expect(top(m)).toBe(4);
    m.stack.push(first);
    m.interpret('REC-DATA + @');
    expect(top(m)).toBe(2); // each record kept its own count

    m.stack.push(first);
    m.interpret("KILL ' TICKER SPAWN"); // the freed record is reused, its data zeroed
    expect(m.stack.pop()).toBe(first);
    m.stack.push(first);
    m.interpret('REC-DATA + @');
    expect(top(m)).toBe(0);
    m.interpret("' TICKER SPAWN ' TICKER SPAWN"); // the table holds 3
    expect(m.stack.toArray()).toEqual([0, first + 32]);
  });

  it('RENDER runs the background, then draws active slots lowest layer first', () => {
    const { hal, draws } = recording();
    const m = bootMachineWith(['GAME'], { screenHal: hal });
    m.interpret('LOAD-ASSET ROGUE.SPR  BANK@ ROGUE SPRITE-BASE !');
    m.interpret('VARIABLE BG  : MY-BG 1 BG +! ;  \' MY-BG BACKGROUND !');
    m.interpret('4 NEW-SLOTS  10 20 0 0 PLACE  30 40 10 1 PLACE  50 60 0 2 PLACE  2 0 LAYER!  2 UNPLACE');
    m.interpret('RENDER BG @');
    expect(m.stack.pop()).toBe(1);
    expect(draws).toEqual([
      [30, 40, 8], // slot 1, layer 0, the 8 x 8 coin
      [10, 20, 16], // slot 0, layer 2, the 16 x 16 hero
    ]);
  });

  it('OVERLAP? is axis-aligned box overlap, edges touching not counting', () => {
    const m = bootMachineWith(['GAME']);
    const overlap = (a: number[], b: number[]): number => {
      m.interpret(`${a.join(' ')} ${b.join(' ')} OVERLAP?`);
      return m.stack.pop();
    };
    expect(overlap([0, 0, 16, 16], [8, 8, 16, 16])).toBe(-1);
    expect(overlap([0, 0, 16, 16], [16, 0, 8, 8])).toBe(0); // touching edges
    expect(overlap([0, 0, 16, 16], [0, 20, 16, 16])).toBe(0);
    expect(overlap([5, 5, 2, 2], [0, 0, 16, 16])).toBe(-1); // inside
  });
});
