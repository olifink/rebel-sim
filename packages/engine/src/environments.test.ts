import { describe, expect, it } from 'vitest';
import { Channel } from './channel.js';
import { Machine } from './repl.js';
import { AMPLE_STEP_BUDGET, bootMachine } from './test-support.js';

/** Byte-queue channel, so a whole typed line can be pushed at once. */
class LineChannel implements Channel {
  private queue: number[] = [];
  type(line: string): void {
    for (const ch of line) this.queue.push(ch.charCodeAt(0));
    this.queue.push(10);
  }
  hasData(): boolean {
    return this.queue.length > 0;
  }
  readByte(): number {
    return this.queue.length > 0 ? this.queue.shift()! : -1;
  }
}

const sysv = (m: Machine, offset: number): number => m.arena.readCell(m.banks.findBankByName('SYSV')!.base + offset);
const envEntry = (m: Machine): number => sysv(m, 448);
const envReason = (m: Machine): number => sysv(m, 452);
const fetch = (m: Machine, word: string): number => {
  m.interpret(`${word} @`);
  return m.stack.pop();
};
const screenText = (m: Machine): string =>
  Array.from({ length: m.screen.rows }, (_, r) => m.screen.readRowText(r).trimEnd()).join('\n');

/** Runs the REPL until it blocks on ACCEPT (or the budget runs out). */
function runUntilBlocked(m: Machine): string {
  let status = '';
  for (let i = 0; i < 200 && status !== 'blocked'; i++) {
    status = m.step(AMPLE_STEP_BUDGET);
  }
  return status;
}

describe('environments (M77, spec/06-ENVIRONMENTS.md)', () => {
  it('boots with the ESCR header written, HOME in slot 0, and the ENV sysvars at the prompt', () => {
    const m = bootMachine();
    const escr = m.banks.findBankByName('ESCR')!;
    const cols = sysv(m, 80);
    const rows = sysv(m, 84);
    expect(m.arena.readCell(escr.base)).toBe(8);
    const slotSize = m.arena.readCell(escr.base + 4);
    expect(slotSize).toBe((48 + cols * rows * 2 + 3) & ~3);
    expect(escr.size).toBeGreaterThanOrEqual(16 + 8 * slotSize);

    const slot0 = escr.base + 16;
    const name = Array.from({ length: 4 }, (_, i) => String.fromCharCode(m.arena.readByte(slot0 + i))).join('');
    expect(name).toBe('HOME');
    expect(m.arena.readByte(slot0 + 4)).toBe(0);

    expect(envEntry(m)).toBe(0);
    m.interpret("' HOME"); // ENV-CURRENT holds HOME's record: step xt 0, then slot 0
    m.stack.pop();
    const record = fetch(m, 'ENV-CURRENT');
    expect(m.arena.readCell(record)).toBe(0);
    expect(m.arena.readCell(record + 4)).toBe(slot0);
    m.interpret('ENV-STEP ENV-ENTER ENV-RECOVER');
    expect(m.stack.toArray()).toEqual([2, 1, 0]);
  });

  it('a switch saves the outgoing screen, clears or restores the incoming one, and never returns', () => {
    const m = bootMachine();
    m.interpret(': NOP-STEP ;');
    m.interpret("' NOP-STEP ENVIRONMENT TENV");
    m.interpret('CLS 5 3 AT-XY');
    m.interpret('." AT-HOME"');
    expect(screenText(m)).toContain('AT-HOME');

    m.interpret('1 2 TENV 99'); // the 99 after the switch must not run
    expect(m.stack.toArray()).toEqual([]); // WARM discarded both stacks
    m.interpret("' NOP-STEP");
    expect(envEntry(m)).toBe(m.stack.pop());
    expect(envReason(m)).toBe(1); // ENV-ENTER
    expect(screenText(m)).not.toContain('AT-HOME'); // never-saved: CLS

    m.interpret('." IN-TENV"');
    m.interpret('HOME');
    expect(envEntry(m)).toBe(0);
    expect(screenText(m)).toContain('AT-HOME');
    expect(screenText(m)).not.toContain('IN-TENV');
    m.interpret('TENV'); // back in: TENV's own saved screen this time
    expect(screenText(m)).toContain('IN-TENV');
    expect(screenText(m)).not.toContain('AT-HOME');

    // Reloading after FORGET adopts the same slot, saved screen and all.
    m.interpret('HOME');
    m.interpret('FORGET TENV');
    m.interpret("' NOP-STEP ENVIRONMENT TENV TENV");
    expect(screenText(m)).toContain('IN-TENV');

    m.interpret('HOME');
    expect(() => m.interpret("' NOP-STEP ENVIRONMENT TOOLONGNAME")).toThrow();
  });

  it('the driving loop runs the step word with ENTER, then STEP, RECOVER after an error, and prints no ok inside it', () => {
    const channel = new LineChannel();
    const m = bootMachine({ channel });
    m.interpret('VARIABLE HIST VARIABLE N');
    m.interpret(
      ': T-STEP ENV-REASON @ ENV-STEP ENV-REASON ! HIST @ 10 * + HIST ! ' +
        '1 N +! N @ 2 = IF ABORT THEN N @ 4 = IF HOME THEN ;',
    );
    m.interpret("' T-STEP ENVIRONMENT TENV");
    m.interpret('CLS HIST N');
    const nAddr = m.stack.pop();
    const histAddr = m.stack.pop();

    m.startRepl();
    expect(runUntilBlocked(m)).toBe('blocked'); // home prompt, waiting
    channel.type('TENV');
    expect(runUntilBlocked(m)).toBe('blocked'); // stepped 4 times, came HOME

    // ENTER, STEP, then RECOVER after the ABORT, then STEP.
    expect(m.arena.readCell(histAddr)).toBe(1020);
    expect(m.arena.readCell(nAddr)).toBe(4);
    expect(envEntry(m)).toBe(0);
    // Back home: the line typed before leaving is completed with "ok".
    const home = screenText(m);
    expect(home).toMatch(/TENV ok/);
    expect(home.match(/ok/g)!.length).toBe(1);
  });
});
