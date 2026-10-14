import { describe, expect, it } from 'vitest';
import { bootMachine } from './test-support.js';
import { Machine } from './repl.js';

/** Writes `text` into a fresh scratch bank and returns its address. */
function place(m: Machine, text: string): number {
  const bank = m.banks.createBank('DATA', 256);
  for (let i = 0; i < text.length; i++) m.arena.writeByte(bank.base + i, text.charCodeAt(i));
  return bank.base;
}

/** Writes `lines` (each at most 64 chars) into block `n`, padded with
 * spaces, and flushes it so a later BLOCK of another number can't
 * evict it unsaved. */
function writeBlock(m: Machine, n: number, lines: string[]): void {
  m.interpret(`${n} BLOCK`);
  const addr = m.stack.pop();
  for (let i = 0; i < 1024; i++) m.arena.writeByte(addr + i, 32);
  lines.forEach((line, row) => {
    for (let i = 0; i < line.length; i++) m.arena.writeByte(addr + row * 64 + i, line.charCodeAt(i));
  });
  m.interpret('UPDATE FLUSH');
}

describe('EVALUATE (system.fth over (GET-INPUT)/(SET-INPUT), M75, spec/04-FORTH-CORE.md §6.15)', () => {
  it('interprets text from memory, then the rest of the calling line carries on', () => {
    const m = bootMachine();
    m.interpret('S" 2 3 +" EVALUATE 10 *');
    expect(m.stack.toArray()).toEqual([50]);
    m.stack.clear();

    m.interpret('S" : SQ DUP * ;" EVALUATE 7 SQ');
    expect(m.stack.toArray()).toEqual([49]);
    m.stack.clear();

    // STATE is left alone: a definition opened inside stays open.
    m.interpret('S" : FORTYTWO 42" EVALUATE ; FORTYTWO');
    expect(m.stack.toArray()).toEqual([42]);
    m.stack.clear();

    // Nests: evaluated text can call EVALUATE itself.
    const inner = place(m, '2');
    const outerText = `1 ${inner} 1 EVALUATE 3`;
    const outer = place(m, outerText);
    m.interpret(`${outer} ${outerText.length} EVALUATE 4`);
    expect(m.stack.toArray()).toEqual([4, 3, 2, 1]); // top first

    m.stack.clear();
    m.interpret('(GET-INPUT) NIP'); // what's left when it runs: "NIP"
    expect(m.stack.toArray()).toEqual([3]);
  });

  it('an error inside abandons the line, and the next line interprets normally', () => {
    const m = bootMachine();
    expect(() => m.interpret('S" 1 NOSUCHWORD" EVALUATE 5')).toThrow();
    m.stack.clear();
    m.interpret('6 7');
    expect(m.stack.toArray()).toEqual([7, 6]);
  });
});

describe('LOAD rebuilt on EVALUATE (M75)', () => {
  it('hands the rest of the calling line back, and survives a screen that LOADs another', () => {
    const m = bootMachine();
    writeBlock(m, 9, [': SCRW 11 ;', '4']);
    writeBlock(m, 8, ['1 9 LOAD 2', '3']);

    m.interpret('9 LOAD SCRW 5');
    expect(m.stack.toArray()).toEqual([5, 11, 4]);
    m.stack.clear();

    // Screen 8 line 0 LOADs screen 9 mid-line; both the rest of that
    // line and screen 8's second line must still run afterwards.
    m.interpret('8 LOAD 6');
    expect(m.stack.toArray()).toEqual([6, 3, 2, 4, 1]);
  });
});
