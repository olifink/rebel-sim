import { describe, expect, it } from 'vitest';
import { RemoteChannel } from './channel.js';
import { bootMachine, AMPLE_STEP_BUDGET } from './test-support.js';

// M55 follow-up: the remaining core screen-editor commands, ported from
// inspiration/figforth_editor_screens.txt screens 2-6 — R# and the
// cursor-relative words (#LOCATE/#LEAD/#LAG/M), line editing (LINE/-MOVE/
// H/E/S/D/R/P/I), COPY, and search/replace (TEXT-LEN/-TEXT/1LINE/FIND/
// DELETE/N/F/B/X/TILL/C). TS (classic's interactive multi-line entry,
// rebuilt rather than literally ported — its own comment in system.fth
// explains why) is covered in its own describe block further down, M57.
function screenText(rows: number, m: ReturnType<typeof bootMachine>): string {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    out.push(m.screen.readRowText(r));
  }
  return out.join('\n');
}

describe('LINE (system.fth, M55)', () => {
  it('computes the address of a line within the current screen', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('5 CLEAR');
    // BLOCK resolves through the buffer pool, not a fixed blks.base +
    // n*BLOCK_SIZE offset (block-words.test.ts's own 4-slot round-robin
    // pool) — so LINE's own address is only checkable relative to
    // BLOCK's, never computed independently from the bank descriptor.
    m.interpret('5 BLOCK');
    const blockAddr = m.stack.pop();
    m.interpret('2 LINE');
    expect(m.stack.pop()).toBe(blockAddr! + 2 * 64);
  });

  it('throws on a line number outside 0..15', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('0 CLEAR');
    expect(() => m.interpret('16 LINE')).toThrow();
    expect(() => m.interpret('-1 LINE')).toThrow();
  });
});

describe('R# and the cursor-relative words #LOCATE/#LEAD/#LAG/M (system.fth, M55)', () => {
  it('#LOCATE splits R# into column and line#', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('0 CLEAR');
    m.interpret('70 R# !'); // line 1 (64..127), column 6
    m.interpret('#LOCATE');
    expect(m.stack.pop()).toBe(1); // line#
    expect(m.stack.pop()).toBe(6); // col
  });

  it('T positions R# at the start of the given line, not just wherever it last was', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('3 CLEAR');
    m.interpret('999 R# !'); // deliberately wrong, to prove T overrides it
    m.interpret('2 T HELLO');
    m.interpret('R# @');
    expect(m.stack.pop()).toBe(2 * 64);
  });

  it('M moves the cursor and redraws the current line with an underscore marker', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('4 CLEAR');
    m.interpret('0 T CURSOR TEST LINE');
    m.interpret('CLS');
    m.interpret('5 M');
    const text = screenText(3, m);
    expect(text).toContain('CURSO_R TEST LINE');
  });
});

describe('Line editing: E/S/D/H/R/P/I (system.fth, M55)', () => {
  it('E blanks one line without touching its neighbors', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('5 CLEAR');
    m.interpret('0 T FIRST');
    m.interpret('1 T SECOND');
    m.interpret('0 E');
    m.interpret('CLS');
    m.interpret('L');
    const text = screenText(20, m);
    expect(text).not.toContain('FIRST');
    expect(text).toContain('SECOND');
  });

  it('D deletes a line and shifts everything after it up, blanking the last line', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('6 CLEAR');
    m.interpret('0 T LINE-ZERO');
    m.interpret('1 T LINE-ONE');
    m.interpret('2 T LINE-TWO');
    m.interpret('1 D');
    m.interpret('CLS');
    m.interpret('L');
    const text = screenText(20, m);
    expect(text).toContain('LINE-ZERO');
    expect(text).toContain('LINE-TWO'); // shifted up into line 1
    expect(text).not.toContain('LINE-ONE'); // deleted
  });

  it('D holds the deleted line in PAD, so a following I pastes it back', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('7 CLEAR');
    m.interpret('0 T KEEP-ME');
    m.interpret('1 T DELETE-ME');
    m.interpret('2 T KEEP-ME-TOO');
    m.interpret('1 D'); // DELETE-ME removed, KEEP-ME-TOO shifts to line 1, held in PAD
    m.interpret('1 I'); // reinserts DELETE-ME's own content at line 1
    m.interpret('CLS');
    m.interpret('L');
    const text = screenText(20, m);
    expect(text).toContain('KEEP-ME');
    expect(text).toContain('DELETE-ME');
    expect(text).toContain('KEEP-ME-TOO');
  });

  it('S scrolls lines down from a given line, opening a blank gap there', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('8 CLEAR');
    m.interpret('0 T FIRST');
    m.interpret('1 T SECOND');
    m.interpret('0 S');
    function lineText(n: number): string {
      m.interpret(`${n} LINE`);
      const addr = m.stack.pop()!;
      let s = '';
      for (let i = 0; i < 64; i++) s += String.fromCharCode(m.arena.readByte(addr + i));
      return s.trimEnd();
    }
    expect(lineText(0)).toBe(''); // now blank
    expect(lineText(1)).toBe('FIRST'); // shifted down
    expect(lineText(2)).toBe('SECOND'); // shifted down
  });

  it('P reads a fresh line of typed text and replaces the given line with it', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('9 CLEAR');
    m.interpret('0 T ORIGINAL');
    m.interpret('0 P REPLACEMENT TEXT');
    m.interpret('CLS');
    m.interpret('L');
    const text = screenText(20, m);
    expect(text).not.toContain('ORIGINAL');
    expect(text).toContain('REPLACEMENT TEXT');
  });
});

describe('COPY (system.fth, M55)', () => {
  it('duplicates one screen’s whole content into another', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('10 CLEAR');
    m.interpret('0 T COPY-SOURCE-CONTENT');
    m.interpret('11 CLEAR');
    m.interpret('10 11 COPY');
    m.interpret('CLS');
    m.interpret('11 L');
    const text = screenText(20, m);
    expect(text).toContain('COPY-SOURCE-CONTENT');
  });

  it('does not disturb the source screen', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('12 CLEAR');
    m.interpret('0 T SOURCE-STAYS-PUT');
    m.interpret('13 CLEAR');
    m.interpret('12 13 COPY');
    m.interpret('CLS');
    m.interpret('12 L');
    expect(screenText(20, m)).toContain('SOURCE-STAYS-PUT');
  });
});

describe('Search and replace: TEXT-LEN/-TEXT/1LINE/FIND/N/F/B/X/TILL/C (system.fth, M55)', () => {
  it('F finds a pattern forward from the cursor, landing just past the match', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('14 CLEAR');
    m.interpret('0 T THE QUICK BROWN FOX');
    m.interpret('0 R# !');
    m.interpret('F BROWN');
    m.interpret('R# @');
    expect(m.stack.pop()).toBe(15); // "THE QUICK " (10 chars) + "BROWN" (5 chars)
  });

  it('B backs the cursor up by exactly the last search pattern’s length', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('15 CLEAR');
    m.interpret('0 T THE QUICK BROWN FOX');
    m.interpret('0 R# !');
    m.interpret('F BROWN');
    m.interpret('B');
    m.interpret('R# @');
    expect(m.stack.pop()).toBe(10); // right back at the start of "BROWN"
  });

  it('N repeats the most recent search pattern without retyping it', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('0 CLEAR');
    m.interpret('0 T AAA BBB AAA CCC');
    m.interpret('0 R# !');
    m.interpret('F AAA');
    m.interpret('R# @');
    const firstMatch = m.stack.pop();
    m.interpret('N');
    m.interpret('R# @');
    const secondMatch = m.stack.pop();
    expect(secondMatch).toBeGreaterThan(firstMatch!);
  });

  it('X finds and deletes the next occurrence of a freshly typed pattern', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('1 CLEAR');
    m.interpret('0 T REMOVE THIS WORD');
    m.interpret('0 R# !');
    m.interpret('X THIS ');
    m.interpret('CLS');
    m.interpret('L');
    const text = screenText(20, m);
    expect(text).not.toContain('THIS ');
    expect(text).toContain('REMOVE');
    expect(text).toContain('WORD');
  });

  it('TILL deletes from the cursor through the next match on the current line', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('2 CLEAR');
    m.interpret('0 T KEEPTHIS DELETE-THROUGH-HERE KEEPTHAT');
    m.interpret('9 R# !'); // right after "KEEPTHIS "
    m.interpret('TILL HERE ');
    m.interpret('CLS');
    m.interpret('L');
    const text = screenText(20, m);
    expect(text).toContain('KEEPTHIS');
    expect(text).toContain('KEEPTHAT');
    expect(text).not.toContain('DELETE-THROUGH');
  });

  it('C overwrites from the cursor onward with freshly typed text', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('3 CLEAR');
    m.interpret('0 T KEEP OLDTEXT');
    m.interpret('5 R# !'); // right after "KEEP "
    m.interpret('C NEWTEXT');
    m.interpret('CLS');
    m.interpret('L');
    const text = screenText(20, m);
    expect(text).toContain('KEEP NEWTEXT');
    expect(text).not.toContain('OLDTEXT');
  });

  it('FIND gives up after one full pass instead of looping forever when nothing matches', () => {
    const m = bootMachine();
    m.interpret('USE EDITOR');
    m.interpret('4 CLEAR');
    m.interpret('0 T SOME ORDINARY TEXT');
    m.interpret('0 R# !');
    // Must terminate promptly (vitest's own default timeout is the real
    // guard here) and leave R# inside the valid 0..1023 range afterward.
    m.interpret('F NEVER-PRESENT-ANYWHERE-ON-SCREEN');
    m.interpret('R# @');
    const r = m.stack.pop()!;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1024);
    // And a following, ordinary command still works — nothing left the
    // machine in a broken state.
    expect(() => m.interpret('0 M')).not.toThrow();
  });
});

describe('TS: interactive multi-line block entry (system.fth, M57)', () => {
  function bootWithRemote(): { m: ReturnType<typeof bootMachine>; remote: RemoteChannel } {
    const remote = new RemoteChannel();
    const m = bootMachine({ remoteChannel: remote });
    return { m, remote };
  }

  function lineText(m: ReturnType<typeof bootMachine>, n: number): string {
    m.interpret(`${n} LINE`);
    const addr = m.stack.pop()!;
    let s = '';
    for (let i = 0; i < 64; i++) s += String.fromCharCode(m.arena.readByte(addr + i));
    return s.trimEnd();
  }

  it('types characters directly into the block and onto the screen', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('0 CLEAR');
    m.interpret('TS');
    remote.push('HI');
    remote.push('\x1b'); // Esc: stop
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('HI');
    expect(m.screen.readRowText(0).trimEnd()).toBe('HI');
  });

  it('Enter advances to the start of the next line', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('1 CLEAR');
    m.interpret('TS');
    remote.push('AAA\nBB');
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('AAA');
    expect(lineText(m, 1)).toBe('BB');
  });

  it('Enter on the last line ends the session, same as Esc', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('2 CLEAR');
    m.interpret('TS');
    remote.push('\n'.repeat(16)); // one Enter per line; the 16th runs off the end
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    m.interpret('R# @');
    const r = m.stack.pop()!;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1024);
    // Control genuinely returned to the caller -- an ordinary command
    // right afterward still works, nothing left the machine stuck.
    expect(() => m.interpret('0 M')).not.toThrow();
  });

  it('Esc ends the session, keeping whatever was typed so far', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('3 CLEAR');
    m.interpret('TS');
    remote.push('KEEP-ME');
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('KEEP-ME');
    // Esc leaves the cursor showing right where typing left off -- unlike
    // the two BLOCK-SIZE-overflow exits, which really do have nothing
    // left to point at and disable it.
    expect(m.sysvars.get('SCREEN', 'CURSOR-VISIBLE')).toBe(-1);
    m.interpret('0 M'); // control genuinely returned, not just paused
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
  });

  it("Backspace erases the last character and won't cross above the top of the screen", () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('4 CLEAR');
    m.interpret('TS');
    remote.push('AB\b\b\b'); // two real erases; the third is a no-op, nothing left
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('');
  });

  it('a full line auto-advances to the next one without needing Enter', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('5 CLEAR');
    m.interpret('TS');
    remote.push('X'.repeat(64) + 'YZ');
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('X'.repeat(64));
    expect(lineText(m, 1)).toBe('YZ');
  });

  it('Right moves the cursor without writing anything, unlike typing', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('6 CLEAR');
    m.interpret('TS');
    remote.push('\x04\x04'); // Right, Right -- no content written yet
    remote.push('X');
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('  X'); // columns 0-1 untouched, X lands at column 2
  });

  it('Left moves the cursor back without erasing, unlike Backspace', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('7 CLEAR');
    m.interpret('TS');
    remote.push('AB\x05X'); // type AB, Left (back onto the B, not erasing it yet), overwrite with X
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('AX');
  });

  it("Left at column 0 of the screen doesn't move past it", () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('8 CLEAR');
    m.interpret('TS');
    remote.push('\x05X'); // Left, then type -- still lands at the very start
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('X');
  });

  it('Down moves the cursor one line down, preserving column, and Up undoes it', () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('9 CLEAR');
    m.interpret('TS');
    remote.push('AAAA\x03'); // four chars on line 0 (R# now 4), then Down -- line 1, column 4
    remote.push('X'); // writes at line 1 column 4, R# advances to column 5
    remote.push('\x02'); // Up -- back to line 0, same column 5 (X's own advance)
    remote.push('Y');
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('AAAA Y'); // column 4 untouched, Y at column 5
    expect(lineText(m, 1)).toBe('    X'); // columns 0-3 untouched, X at column 4
  });

  it("Up on the very first line doesn't move", () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('10 CLEAR');
    m.interpret('TS');
    remote.push('\x02X'); // Up, then type -- still lands on line 0
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 0)).toBe('X');
  });

  it("Down on the very last line doesn't move", () => {
    const { m, remote } = bootWithRemote();
    m.interpret('USE EDITOR');
    m.interpret('11 CLEAR');
    m.interpret('TS');
    remote.push('\x03'.repeat(16)); // Down x16 -- only 15 actually move (line 0..15)
    remote.push('X');
    remote.push('\x1b');
    expect(m.step(AMPLE_STEP_BUDGET)).toBe('idle');
    expect(lineText(m, 15)).toBe('X'); // stopped exactly at the last line, not past it
  });
});
