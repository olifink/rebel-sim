import { describe, expect, it } from 'vitest';
import { RemoteBoard } from './remote-board.js';
import { RemoteTerminal } from './remote-terminal.js';
import { ByteSink, decodeHelloAck, encodeHello } from './remote-terminal-protocol.js';
import { Personality } from './banks.js';
import { ScreenHal } from './screen.js';

/** Wires a `RemoteBoard` and `RemoteTerminal` together via two `ByteSink`s
 * that call each other's `receiveBytes()` directly, in place of a real
 * `navigator.serial` connection — this is the loopback harness itself.
 * Both roles are fully constructed (and their closures' `terminal`/`board`
 * variables assigned) *before* `board.start()` sends `HELLO` — sending it
 * any earlier would have the terminal's synchronous `HELLO_ACK` reply try
 * to reach a `board` variable that isn't assigned yet (see `start()`'s own
 * doc comment in `remote-board.ts`). */
function connect(personality?: Personality, hal?: ScreenHal): { board: RemoteBoard; terminal: RemoteTerminal } {
  let terminal!: RemoteTerminal;
  let board!: RemoteBoard;
  const boardSink: ByteSink = { writeBytes: (bytes) => terminal.receiveBytes(bytes) };
  const terminalSink: ByteSink = { writeBytes: (bytes) => board.receiveBytes(bytes) };

  terminal = new RemoteTerminal(terminalSink, 80, 60, hal);
  board = new RemoteBoard(boardSink, personality);
  board.start();
  return { board, terminal };
}

describe('remote-terminal loopback: RemoteBoard <-> RemoteTerminal over an in-memory transport', () => {
  it('negotiates the board\'s actual Personality geometry on connect', () => {
    const { board, terminal } = connect({ headless: false, screenCols: 40, screenRows: 25 });
    expect(terminal.getCols()).toBe(40);
    expect(terminal.getRows()).toBe(25);
    expect(board.getHelloAckStatus()).toBe(0); // HelloAckStatusOk
  });

  it('forwards the board\'s EMIT output to the terminal\'s shadow grid', () => {
    const { board, terminal } = connect({ headless: false, screenCols: 40, screenRows: 25 });
    board.machine.interpret('16711680 INK ! 255 PAPER ! 65 EMIT'); // red-on-(0,0,255) 'A'
    expect(terminal.cellAt(0, 0)).toEqual({ charCode: 0x41, ink: 16711680, paper: 255 });
  });

  it('forwards the board\'s CLS to reset every shadow cell to the given paper', () => {
    const { board, terminal } = connect({ headless: false, screenCols: 10, screenRows: 5 });
    board.machine.interpret('65 EMIT'); // dirty at least one cell first
    board.machine.interpret('4080 PAPER ! CLS');
    for (let row = 0; row < terminal.getRows(); row++) {
      for (let col = 0; col < terminal.getCols(); col++) {
        expect(terminal.cellAt(col, row)).toEqual({ charCode: 0, ink: 0, paper: 4080 });
      }
    }
  });

  it('round-trips a KEY_EVENT from the terminal into the board\'s keyboard queue', () => {
    const { board, terminal } = connect();
    terminal.sendKeyEvent(0x04, true); // 'a', pressed
    const event = board.machine.keyboard.readEvent();
    expect(event?.char).toBe('a'.charCodeAt(0));
    expect(event?.pressed).toBe(true);
    expect(event?.usageCode).toBe(0x04);
  });

  it('drives a supplied ScreenHal in real time, matching the shadow grid exactly', () => {
    const blits: Array<[number, number, number, number, number]> = [];
    const clears: number[] = [];
    const hal: ScreenHal = {
      blitGlyph: (col, row, charCode, ink, paper) => blits.push([col, row, charCode, ink, paper]),
      clearScreen: (paper) => clears.push(paper),
      drawPixel: () => {},
      readPixel: () => -1,
    };
    const { board, terminal } = connect({ headless: false, screenCols: 10, screenRows: 5 }, hal);

    // The board's own boot cls() already fired one CLEAR by connect time.
    expect(clears.length).toBeGreaterThan(0);
    const clearsBeforeEmit = clears.length;

    board.machine.interpret('16711680 INK ! 255 PAPER ! 65 EMIT');
    expect(blits).toContainEqual([0, 0, 0x41, 16711680, 255]);
    expect(terminal.cellAt(0, 0)).toEqual({ charCode: 0x41, ink: 16711680, paper: 255 });

    board.machine.interpret('4080 PAPER ! CLS');
    expect(clears.length).toBe(clearsBeforeEmit + 1);
    expect(clears[clears.length - 1]).toBe(4080);
  });

  it('rejects an unsupported cell size with HELLO_ACK status 2, per REMOTE-TERMINAL.md §5', () => {
    // Exercise RemoteTerminal directly against a hand-built HELLO, since
    // RemoteBoard itself always sends the fixed, correct 8x8 cell size —
    // an actual mismatch could only come from a non-conformant board.
    const acks: Uint8Array[] = [];
    const terminal = new RemoteTerminal({ writeBytes: (b) => acks.push(b) });
    terminal.receiveBytes(
      encodeHello({ protocolVersion: 1, charCols: 80, charRows: 60, charCellW: 16, charCellH: 16 }),
    );
    expect(acks).toHaveLength(1);
    expect(decodeHelloAck(acks[0].slice(3, 3 + 5)).status).toBe(2); // HelloAckStatusUnsupportedCellSize
  });
});
