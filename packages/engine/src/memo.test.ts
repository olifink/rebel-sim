import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { AMPLE_STEP_BUDGET, bootMachineWithMemo } from './test-support.js';

// Usage codes and modifier bits (docs/KEYBOARD.md).
const K = {
  a: 0x04, b: 0x05, c: 0x06, d: 0x07, h: 0x0b, i: 0x0c, k: 0x0e, o: 0x12, x: 0x1b,
  n1: 0x1e, n2: 0x1f, n3: 0x20, n5: 0x22,
  enter: 0x28, esc: 0x29, bs: 0x2a, space: 0x2c, equal: 0x2e, period: 0x37,
  home: 0x4a, del: 0x4c, end: 0x4d, right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
};
const SHIFT = 0x81;

/** A booted machine with MEMO loaded, switched into it, and the REPL
 * driving its step word until it blocks on EKEY. */
function enterMemo(): Machine {
  const m = bootMachineWithMemo();
  m.interpret('MEMO');
  m.startRepl();
  settle(m);
  return m;
}

function settle(m: Machine): void {
  let status = '';
  for (let i = 0; i < 500 && status !== 'blocked'; i++) status = m.step(AMPLE_STEP_BUDGET);
  expect(status).toBe('blocked');
}

function key(m: Machine, usage: number, shift = false): void {
  if (shift) m.keyboard.pushRawEvent(SHIFT, true);
  m.keyboard.pushRawEvent(usage, true);
  m.keyboard.pushRawEvent(usage, false);
  if (shift) m.keyboard.pushRawEvent(SHIFT, false);
  settle(m);
}

const CHARS: Record<string, number> = {
  ' ': K.space, '.': K.period, '+': -1,
  ...Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((c, i) => [c, 0x04 + i])),
  ...Object.fromEntries('123456789'.split('').map((c, i) => [c, 0x1e + i])),
  '0': 0x27,
};
function typeText(m: Machine, text: string): void {
  for (const ch of text) {
    if (ch === '+') key(m, K.equal, true);
    else key(m, CHARS[ch]);
  }
}

const row = (m: Machine, r: number): string => m.screen.readRowText(r).trimEnd();
const cursor = (m: Machine): [number, number] => {
  const sysv = m.banks.findBankByName('SYSV')!.base;
  return [m.arena.readCell(sysv + 16), m.arena.readCell(sysv + 20)];
};

/** The NOTES document's header and a page row, read straight from the bank. */
function notes(m: Machine) {
  const base = m.banks.findBankByName('NOTES')!.base;
  const cell = (o: number) => m.arena.readCell(base + o);
  const cols = cell(4);
  const rows = cell(8);
  return {
    cols, rows, pages: cell(12), revision: cell(16), page: cell(20),
    line: (page: number, r: number) =>
      Array.from({ length: cols }, (_, i) => String.fromCharCode(m.arena.readByte(base + 32 + page * cols * rows + r * cols + i)))
        .join('').trimEnd(),
    magic: String.fromCharCode(m.arena.readByte(base), m.arena.readByte(base + 1)) + m.arena.readByte(base + 2),
  };
}

describe('MEMO (memo.fth, M80, spec/09-MEMO.md)', () => {
  it("loads as a module, creates NOTES in this screen's geometry, and enters on an empty page", () => {
    const m = enterMemo();
    const doc = notes(m);
    expect(doc.magic).toBe('PG1');
    expect([doc.cols, doc.rows, doc.pages]).toEqual([80, 60, 1]);
    expect(cursor(m)).toEqual([0, 0]);
    expect(row(m, 0)).toBe('');
  });

  it('types in overwrite mode and edits a line: Home, End, Backspace, Delete, Shift-Space', () => {
    const m = enterMemo();
    typeText(m, 'abc');
    expect([row(m, 0), cursor(m)]).toEqual(['abc', [3, 0]]);
    key(m, K.home);
    key(m, K.space, true); // insert a space at the cursor
    expect([row(m, 0), cursor(m)]).toEqual([' abc', [0, 0]]);
    key(m, K.del);
    expect(row(m, 0)).toBe('abc');
    key(m, K.end);
    expect(cursor(m)).toEqual([3, 0]);
    key(m, K.bs);
    expect([row(m, 0), cursor(m)]).toEqual(['ab', [2, 0]]);
    key(m, K.home);
    typeText(m, 'x'); // overwrite, not insert
    expect(row(m, 0)).toBe('xb');
  });

  it('splits a line with Shift-Enter and joins it back with Shift-Backspace at column 0', () => {
    const m = enterMemo();
    typeText(m, 'abcd');
    key(m, K.left);
    key(m, K.left);
    key(m, K.enter, true);
    expect([row(m, 0), row(m, 1), cursor(m)]).toEqual(['ab', 'cd', [0, 1]]);
    key(m, K.bs, true);
    expect([row(m, 0), row(m, 1), cursor(m)]).toEqual(['abcd', '', [2, 0]]);
  });

  it('turns pages, adding a page past a non-blank last one and dropping a blank last one going back', () => {
    const m = enterMemo();
    typeText(m, 'hello');
    key(m, K.down, true);
    let doc = notes(m);
    expect([doc.pages, doc.page]).toEqual([2, 1]);
    expect(doc.line(0, 0)).toBe('hello'); // committed before the turn
    expect(doc.revision).toBeGreaterThan(0);
    expect(row(m, 0)).toBe('');
    key(m, K.up, true);
    doc = notes(m);
    expect([doc.pages, doc.page]).toEqual([1, 0]);
    expect(row(m, 0)).toBe('hello');
  });

  it('splits a page at a blank line with Shift-Space and joins it back at the top left', () => {
    const m = enterMemo();
    typeText(m, 'aa');
    key(m, K.enter);
    key(m, K.enter);
    typeText(m, 'bb');
    key(m, K.up); // to the blank line 1
    key(m, K.space, true);
    let doc = notes(m);
    expect(doc.pages).toBe(2);
    expect([doc.line(0, 0), doc.line(0, 2), doc.line(1, 0)]).toEqual(['aa', '', 'bb']);
    expect(row(m, 2)).toBe('');

    key(m, K.down, true); // to the new page
    key(m, K.home);
    key(m, K.up);
    key(m, K.up);
    key(m, K.bs, true); // top left: join onto the previous page
    doc = notes(m);
    expect([doc.pages, doc.page]).toEqual([1, 0]);
    expect([doc.line(0, 0), doc.line(0, 1)]).toEqual(['aa', 'bb']);
    expect(cursor(m)).toEqual([0, 1]);
  });

  it('Shift-Esc runs the line as Forth: output below it, a status comment on it, and re-running replaces the status', () => {
    const m = enterMemo();
    typeText(m, '2 3 + .');
    key(m, K.esc, true);
    expect([row(m, 0), row(m, 1)]).toEqual(['2 3 + . \\ ok', '5']);
    expect(cursor(m)).toEqual([7, 0]); // the cursor stays where it was
    key(m, K.esc, true);
    expect(row(m, 0)).toBe('2 3 + . \\ ok');
    const doc = notes(m);
    expect(doc.line(0, 0)).toBe('2 3 + . \\ ok');
    expect(doc.line(0, 1)).toBe('5');
  });

  it('a line that aborts gets the status error, with what the machine printed captured below it', () => {
    const m = enterMemo();
    typeText(m, 'nosuchword');
    key(m, K.esc, true);
    expect(row(m, 0)).toBe('nosuchword \\ error');
    expect(row(m, 1)).toMatch(/NOSUCHWORD|nosuchword/i);
    // MEMO is still in charge afterwards: typing still edits the page.
    key(m, K.down);
    key(m, K.down);
    key(m, K.home);
    typeText(m, 'z');
    expect(row(m, 2).startsWith('z')).toBe(true);
  });

  it('EDIT opens a Forth screen in the BLKS bank as a 64 x 16 page and writes through the block words', () => {
    const m = enterMemo();
    typeText(m, '3 edit');
    key(m, K.esc, true); // switches to MEMO again, now on block 3
    expect(row(m, 16)).toBe('BLKS  3');
    typeText(m, 'xy');
    key(m, K.down, true); // commit and turn to block 4
    expect(row(m, 16)).toBe('BLKS  4');
    const blks = m.banks.findBankByName('BLKS')!;
    expect(String.fromCharCode(m.arena.readByte(blks.base + 3 * 1024), m.arena.readByte(blks.base + 3 * 1024 + 1))).toBe('xy');
  });

  it('a command can switch environment: HOME leaves MEMO, and MEMO returns to the same page', () => {
    const m = enterMemo();
    typeText(m, 'home');
    key(m, K.esc, true);
    const sysv = m.banks.findBankByName('SYSV')!.base;
    expect(m.arena.readCell(sysv + 448)).toBe(0); // ENV-ENTRY: back at the prompt
    expect(notes(m).line(0, 0)).toBe('home'); // committed before running
  });

  it('Shift-Delete clears the line from the cursor to the right margin', () => {
    const m = enterMemo();
    typeText(m, 'abcdef');
    key(m, K.home);
    key(m, K.right);
    key(m, K.right);
    key(m, K.del, true);
    expect([row(m, 0), cursor(m)]).toEqual(['ab', [2, 0]]);
  });

  it('Shift-Esc on a blank line leaves MEMO for the Forth prompt, committing the page first', () => {
    const m = enterMemo();
    typeText(m, 'kept');
    key(m, K.down);
    key(m, K.esc, true);
    const sysv = m.banks.findBankByName('SYSV')!.base;
    expect(m.arena.readCell(sysv + 448)).toBe(0); // ENV-ENTRY: home
    expect(notes(m).line(0, 0)).toBe('kept');
  });

  it('MEMO always re-enters on the page document, even after EDIT showed a Forth screen', () => {
    const m = enterMemo();
    typeText(m, 'my notes');
    key(m, K.enter);
    typeText(m, '0 edit');
    key(m, K.esc, true);
    expect(row(m, 16)).toBe('BLKS  0'); // on block 0
    key(m, K.down);
    key(m, K.esc, true); // blank line: back home
    for (const u of [0x10, 0x08, 0x10, 0x12]) key(m, u); // m e m o
    key(m, K.enter);
    expect(row(m, 0)).toBe('my notes');
    expect(row(m, 16)).not.toContain('BLKS'); // full-screen page, no status row
  });
});

