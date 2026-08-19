import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';
import { BLOCK_SIZE } from './banks.js';

/** Whether `name` is currently findable via self-hosted FIND — i.e.
 * genuinely reachable through the CONTEXT-based search order an ordinary
 * typed word goes through, not the separate, deliberately narrower
 * LATEST-scoped native tick (`'`). See empty.test.ts's CONTEXT/CURRENT
 * split write-up for why the two differ. */
function findable(m: Machine, name: string): boolean {
  m.interpret(`S" ${name}" FIND`);
  const flag = m.stack.pop();
  m.stack.pop(); // entry-addr, unused
  return flag !== 0;
}

describe('BLKS starts space-filled, not zero-filled (Screen Editor follow-up, repl.ts)', () => {
  it('every byte of a freshly-created BLKS bank is a space (32)', () => {
    const m = new Machine();
    const blks = m.banks.requireBank('BLKS');
    for (const offset of [0, 1, BLOCK_SIZE, 5 * BLOCK_SIZE, 16 * BLOCK_SIZE - 1]) {
      expect(m.arena.readByte(blks.base + offset)).toBe(32);
    }
  });
});

describe('LOAD (system.fth, FORTH-ARCHITECTURE.md §7 follow-up)', () => {
  it('interprets a screen written via T as real Forth source, one line at a time — LOAD compiles into FORTH even while still browsing EDITOR', () => {
    // Deliberately stays USEd into EDITOR (browsing) through the T and
    // LOAD calls — proves LOAD compiles into FORTH regardless of which
    // vocabulary is merely being *browsed*, the CONTEXT/CURRENT-VOCAB
    // split's whole point (PLAN.md's M48 follow-up). A vocabulary you're
    // only browsing, not compiling into, can't see words compiled
    // elsewhere after its own fork point — same chain isolation as any
    // two sibling vocabularies — so switching context back to FORTH
    // before calling the loaded word is expected, not a leftover chore:
    // if LOAD had wrongly compiled into EDITOR instead, this same switch
    // back to FORTH would fail to find SQUARED at all.
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('2 CLEAR');
    m.interpret('0 T : SQUARED DUP * ;');
    m.interpret('2 LOAD');

    m.interpret('USE FORTH');
    m.interpret('5 SQUARED');
    expect(m.stack.pop()).toBe(25);
  });

  it('interpreting multiple lines lets a later line call a word an earlier line just defined', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('3 CLEAR');
    m.interpret('0 T : DOUBLE 2 * ;');
    m.interpret('1 T : QUADRUPLE DOUBLE DOUBLE ;');
    m.interpret('3 LOAD');

    m.interpret('USE FORTH');
    m.interpret('7 QUADRUPLE');
    expect(m.stack.pop()).toBe(28);
  });

  it('a blank (never-T-ed) screen loads as a genuine no-op, not an error', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('4 CLEAR');
    expect(() => m.interpret('4 LOAD')).not.toThrow();
  });

  it('a word LOADed while merely browsing EDITOR is reachable from plain FORTH afterward, not trapped inside EDITOR', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('13 CLEAR');
    m.interpret('0 T : LOADED-WORD 123 ;');
    m.interpret('13 LOAD');

    m.interpret('USE FORTH');
    expect(findable(m, 'LOADED-WORD')).toBe(true);
  });
});

describe('EDITOR vocabulary isolation (VOCABULARY/DEFINITIONS/USE, DEVELOPING.md §8, revised for the CONTEXT/CURRENT split)', () => {
  it('L/T/TOP/CLEAR/SCR are not reachable from plain FORTH', () => {
    const m = bootMachine();
    for (const name of ['L', 'T', 'TOP', 'CLEAR', 'SCR']) {
      expect(findable(m, name)).toBe(false);
    }
  });

  it('become reachable once USEing EDITOR (browsing only), and LOAD/BLOCK/DUP (FORTH-root) stay reachable from inside EDITOR too', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    for (const name of ['L', 'T', 'TOP', 'CLEAR', 'SCR', 'LOAD', 'BLOCK', 'DUP']) {
      expect(findable(m, name)).toBe(true);
    }
  });

  it('LOAD stays reachable from plain FORTH without ever USEing EDITOR', () => {
    const m = bootMachine();
    expect(findable(m, 'LOAD')).toBe(true);
  });

  it('USE alone (browsing) never redirects where new words compile — they land in FORTH, not EDITOR', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret(': BROWSE-DEFINED 1 ;');
    m.interpret('USE FORTH');
    expect(findable(m, 'BROWSE-DEFINED')).toBe(true);
  });

  it('DEFINITIONS does redirect where new words compile, unlike plain USE', () => {
    const m = bootMachine();
    m.interpret('EDITOR DEFINITIONS');
    m.interpret(': DEFINITIONS-DEFINED 2 ;');
    m.interpret('FORTH DEFINITIONS');

    expect(findable(m, 'DEFINITIONS-DEFINED')).toBe(false);
    m.interpret('USE EDITOR');
    expect(findable(m, 'DEFINITIONS-DEFINED')).toBe(true);
  });
});

describe('CLEAR/T/LIST/L (system.fth, Screen Editor follow-up)', () => {
  it('T writes text into a line, space-padding the rest of it', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');
    m.interpret('USE EDITOR');
    m.interpret('5 CLEAR');
    m.interpret('2 T HI');
    m.interpret('FLUSH');

    const lineBase = blks.base + 5 * BLOCK_SIZE + 2 * 64;
    expect(m.arena.readByte(lineBase)).toBe('H'.charCodeAt(0));
    expect(m.arena.readByte(lineBase + 1)).toBe('I'.charCodeAt(0));
    expect(m.arena.readByte(lineBase + 2)).toBe(32); // space-padded, not left over garbage
    expect(m.arena.readByte(lineBase + 63)).toBe(32); // last byte of the line too
  });

  it('T truncates text longer than one line (64 chars) rather than overflowing into the next line', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');
    m.interpret('USE EDITOR');
    m.interpret('6 CLEAR');
    const longText = 'A'.repeat(80);
    m.interpret(`0 T ${longText}`);
    m.interpret('FLUSH');

    const line0 = blks.base + 6 * BLOCK_SIZE;
    for (let i = 0; i < 64; i++) {
      expect(m.arena.readByte(line0 + i)).toBe('A'.charCodeAt(0));
    }
    // Line 1 must be untouched by the truncated overflow.
    expect(m.arena.readByte(blks.base + 6 * BLOCK_SIZE + 64)).toBe(32);
  });

  it('CLEAR re-blanks a screen that already has real content', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');
    m.interpret('USE EDITOR');
    m.interpret('7 CLEAR');
    m.interpret('0 T HELLO');
    m.interpret('7 CLEAR');
    m.interpret('FLUSH');

    expect(m.arena.readByte(blks.base + 7 * BLOCK_SIZE)).toBe(32);
  });

  it('LIST prints a header and every line, including the just-written text', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('8 CLEAR');
    m.interpret('3 T HELLO SCREEN EDITOR');
    m.interpret('8 LIST');

    const rows: string[] = [];
    for (let r = 0; r < m.screen.rows; r++) {
      rows.push(m.screen.readRowText(r));
    }
    const full = rows.join('\n');
    expect(full).toContain('SCR # 8');
    expect(full).toContain('HELLO SCREEN EDITOR');
  });

  it('L redisplays the current screen (whatever LIST/CLEAR last set SCR to) without an argument', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('9 CLEAR');
    m.interpret('0 T MARKER-NINE');
    m.interpret('CLS'); // wipe the visible screen so L's own output is unambiguous
    m.interpret('L');

    const rows: string[] = [];
    for (let r = 0; r < m.screen.rows; r++) {
      rows.push(m.screen.readRowText(r));
    }
    expect(rows.join('\n')).toContain('MARKER-NINE');
  });

  it('TOP jumps to and displays screen 0 regardless of which screen was current', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('0 CLEAR');
    m.interpret('0 T SCREEN-ZERO-MARKER');
    m.interpret('12 CLEAR'); // move SCR away from 0
    m.interpret('CLS');
    m.interpret('TOP');

    const rows: string[] = [];
    for (let r = 0; r < m.screen.rows; r++) {
      rows.push(m.screen.readRowText(r));
    }
    expect(rows.join('\n')).toContain('SCREEN-ZERO-MARKER');
    expect(rows.join('\n')).toContain('SCR # 0');
  });

  it('writing to one screen never touches another (per-screen isolation via BLOCK)', () => {
    const m = bootMachine();
    const blks = m.banks.requireBank('BLKS');
    m.interpret('USE EDITOR');
    m.interpret('10 CLEAR');
    m.interpret('0 T SCREEN-TEN');
    m.interpret('11 CLEAR');
    m.interpret('FLUSH');

    const line0of10 = blks.base + 10 * BLOCK_SIZE;
    expect(m.arena.readByte(line0of10)).toBe('S'.charCodeAt(0));
    const line0of11 = blks.base + 11 * BLOCK_SIZE;
    expect(m.arena.readByte(line0of11)).toBe(32);
  });
});
