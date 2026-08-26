/**
 * The "terminal" role of `REMOTE-TERMINAL.md` §7 — decodes the board's
 * wire frames into a local shadow character grid, can send keyboard input
 * back, and can optionally drive a real `ScreenHal` too (e.g. the app's
 * `CanvasScreenHal`) so the board's output actually paints somewhere
 * visible. Still scoped down from §7's full design: no `Machine`, no
 * `Arena`/`BankTable`/`FONT` bank of its own — a caller that already has a
 * `ScreenHal` (with its own font already loaded, e.g. a running local
 * `Machine`'s) can just pass it in and reuse it, which is exactly what
 * `packages/app`'s `TERMINAL`-word handling does. No real
 * `navigator.serial` wiring here regardless — that's a separate,
 * still-deferred concern.
 *
 * Cursor rendering needs no special-casing here: `BoardScreenHal`
 * (`remote-board.ts`) only ever forwards plain `blitGlyph`/`clearScreen`
 * calls, and this codebase has no separate cursor HAL primitive anywhere
 * (`screen.ts`'s own `redrawCursorAt()` expresses a visible cursor purely
 * as an ordinary `blitGlyph` with ink/paper swapped) — so a board's own
 * `Screen` already produces correctly pre-inverted `PLOT_CHAR` frames
 * whenever it shows a cursor. `CURSOR` (§4's *optional* bandwidth
 * shortcut) is still tracked as state only, not wired to `hal` — no board
 * built in this codebase ever sends one.
 */

import {
  ByteSink,
  CursorFields,
  FrameDecoder,
  HelloAckStatusOk,
  HelloAckStatusUnsupportedCellSize,
  HelloAckStatusVersionMismatch,
  MSG_CLEAR,
  MSG_CURSOR,
  MSG_HELLO,
  MSG_PLOT_CHAR,
  PROTOCOL_VERSION,
  decodeClear,
  decodeCursor,
  decodeHello,
  decodePlotChar,
  encodeHelloAck,
  encodeKeyEvent,
} from './remote-terminal-protocol.js';
import { ScreenHal } from './screen.js';

export interface ShadowCell {
  readonly charCode: number;
  readonly ink: number;
  readonly paper: number;
}

const BLANK_CELL: ShadowCell = { charCode: 0, ink: 0, paper: 0 };

export class RemoteTerminal {
  private cols = 0;
  private rows = 0;
  private shadow: ShadowCell[] = [];
  private cursor: CursorFields = { col: 0, row: 0, visible: false };
  private readonly decoder = new FrameDecoder();

  constructor(
    private readonly sink: ByteSink,
    private readonly maxCols = 80,
    private readonly maxRows = 60,
    private readonly hal?: ScreenHal,
  ) {}

  /** Char-grid dimensions actually negotiated via `HELLO`/`HELLO_ACK` —
   * both `0` until a `HELLO` has been received. */
  getCols(): number {
    return this.cols;
  }

  getRows(): number {
    return this.rows;
  }

  /** The shadow grid's true, non-inverted content at `(col, row)` — a
   * cursor overlay is tracked separately (`getCursorState()`), never
   * baked into this, matching §4's description of `CURSOR` as a pure
   * presentational shortcut on top of whatever's already shadowed. */
  cellAt(col: number, row: number): ShadowCell {
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
      throw new RangeError(`(${col}, ${row}) out of range for a ${this.cols}x${this.rows} grid`);
    }
    return this.shadow[row * this.cols + col];
  }

  getCursorState(): CursorFields {
    return this.cursor;
  }

  /** The loopback harness's stand-in for real DOM keyboard input
   * (`browser-keymap.ts`'s `codeToUsage()` lives in `packages/app`, out
   * of scope here) — encodes and writes a `KEY_EVENT` frame back to the
   * board. */
  sendKeyEvent(usageCode: number, pressed: boolean): void {
    this.sink.writeBytes(encodeKeyEvent({ usageCode, pressed }));
  }

  receiveBytes(bytes: Uint8Array): void {
    for (const frame of this.decoder.push(bytes)) {
      switch (frame.msgId) {
        case MSG_HELLO:
          this.handleHello(frame.payload);
          break;
        case MSG_PLOT_CHAR: {
          const { col, row, charCode, ink, paper } = decodePlotChar(frame.payload);
          if (col < this.cols && row < this.rows) {
            this.shadow[row * this.cols + col] = { charCode, ink, paper };
            this.hal?.blitGlyph(col, row, charCode, ink, paper);
          }
          break;
        }
        case MSG_CLEAR: {
          const { paper } = decodeClear(frame.payload);
          this.shadow.fill({ charCode: 0, ink: 0, paper });
          this.hal?.clearScreen(paper);
          break;
        }
        case MSG_CURSOR:
          this.cursor = decodeCursor(frame.payload);
          break;
      }
    }
  }

  private handleHello(payload: Uint8Array): void {
    const hello = decodeHello(payload);
    let status = HelloAckStatusOk;
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      status = HelloAckStatusVersionMismatch;
    } else if (hello.charCellW !== 8 || hello.charCellH !== 8) {
      // §5: cell pixel size is fixed at 8x8 for v1, never negotiated —
      // font rendering stays local to the terminal's own compiled-in
      // glyph table, which has no source to render a different size
      // against.
      status = HelloAckStatusUnsupportedCellSize;
    }

    if (status === HelloAckStatusOk) {
      this.cols = Math.min(hello.charCols, this.maxCols);
      this.rows = Math.min(hello.charRows, this.maxRows);
      this.shadow = new Array(this.cols * this.rows).fill(BLANK_CELL);
      this.cursor = { col: 0, row: 0, visible: false };
    }

    this.sink.writeBytes(encodeHelloAck({ status, negotiatedCols: this.cols, negotiatedRows: this.rows }));
  }
}
