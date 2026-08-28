/**
 * The "board" role of `REMOTE-TERMINAL.md` §8 — a real local `Machine`
 * whose screen HAL calls cross the wire as `PLOT_CHAR`/`CLEAR` frames
 * instead of drawing anywhere, and whose keyboard input arrives as
 * `KEY_EVENT` frames instead of real DOM events. Stands in for what a
 * real RP2350 board's firmware would eventually do, entirely in
 * software, before that firmware exists.
 */

import { Machine } from './repl.js';
import { ScreenHal } from './screen.js';
import { DEFAULT_PERSONALITY, Personality } from './banks.js';
import {
  ByteSink,
  FrameDecoder,
  MSG_HELLO_ACK,
  MSG_KEY_EVENT,
  decodeHelloAck,
  decodeKeyEvent,
  encodeClear,
  encodeHello,
  encodePlotChar,
} from './remote-terminal-protocol.js';

/** Forwards every `ScreenHal` call across the wire instead of drawing —
 * §1's central design choice: char-cell HAL level, not raw pixels. */
export class BoardScreenHal implements ScreenHal {
  constructor(private readonly sink: ByteSink) {}

  blitGlyph(col: number, row: number, charCode: number, ink: number, paper: number): void {
    this.sink.writeBytes(encodePlotChar({ col, row, charCode, ink, paper }));
  }

  clearScreen(paper: number): void {
    this.sink.writeBytes(encodeClear({ paper }));
  }

  /** No-op: REMOTE-TERMINAL.md's wire protocol carries no raw-pixel
   * message (§1, §10 item 3 — "no hal_draw_*-equivalent message family...
   * not designed here"). A board running GRAPHICS-vocabulary Forth code
   * in remote-terminal mode has nowhere to send PLOT today; this is that
   * limitation surfacing here as silence rather than a thrown error,
   * matching this class's char-cell methods' own "forward or silently
   * drop" shape. */
  drawPixel(): void {}

  /** Same limitation as `drawPixel` — no wire message exists to ask the
   * terminal what a pixel currently shows, so this can only ever report
   * "nothing there" (`Screen.point()`'s own out-of-range sentinel). */
  readPixel(): number {
    return -1;
  }
}

export class RemoteBoard {
  readonly machine: Machine;
  private readonly decoder = new FrameDecoder();
  private helloAckStatus: number | undefined;

  private readonly sink: ByteSink;
  private readonly personality: Personality;

  constructor(sink: ByteSink, personality: Personality = DEFAULT_PERSONALITY) {
    this.sink = sink;
    this.personality = personality;
    this.machine = new Machine({ screenHal: new BoardScreenHal(sink), personality });
  }

  /** Sends `HELLO` (§8 step 1). A separate method from the constructor,
   * deliberately: the caller is expected to call this only once *both*
   * ends of the transport are fully constructed and reachable (e.g. a
   * loopback harness's own `board`/`terminal` variables are assigned) —
   * calling it any earlier, from inside a constructor whose own
   * completion the receiving end's synchronous reply depends on, is a
   * real reentrancy hazard (a peer replying to `HELLO` before the
   * caller holds a usable reference to whoever sent it). `Machine`'s own
   * constructor already ran `Screen.cls()` during boot by this point
   * (repl.ts, unconditional for every `Machine`, remote-terminal mode or
   * not) — that earlier `CLEAR` frame lands on a terminal that hasn't
   * negotiated real dimensions yet and safely no-ops (`RemoteTerminal`
   * ignores screen frames until its own `HELLO` handling has sized its
   * shadow grid), so this ordering costs nothing in practice even though
   * it isn't literally "the first byte on the wire." Real RP2350
   * firmware, written fresh for this mode, can and should satisfy §8's
   * literal ordering directly — this is a Rebel-Sim-`Machine`-reuse
   * simplification specific to this software harness, not a wire-level
   * requirement being relaxed. */
  start(): void {
    this.sink.writeBytes(
      encodeHello({
        protocolVersion: 1,
        charCols: this.personality.screenCols,
        charRows: this.personality.screenRows,
        charCellW: 8,
        charCellH: 8,
      }),
    );
  }

  /** The negotiated status from the terminal's `HELLO_ACK`, once
   * received — `undefined` until then. Exposed as a plain getter, not
   * enforced as a hard construction-time wait: real "block until the
   * ack arrives" behavior is a firmware concern §8 explicitly leaves
   * undictated ("how the board falls back... is a firmware decision"),
   * not something a synchronous in-process harness needs to simulate. */
  getHelloAckStatus(): number | undefined {
    return this.helloAckStatus;
  }

  /** Feed bytes arriving from the terminal (§8 step 4: `KEY_EVENT`
   * frames feed straight into the keyboard input pipeline at the same
   * point real raw HID events would). */
  receiveBytes(bytes: Uint8Array): void {
    for (const frame of this.decoder.push(bytes)) {
      if (frame.msgId === MSG_HELLO_ACK) {
        this.helloAckStatus = decodeHelloAck(frame.payload).status;
      } else if (frame.msgId === MSG_KEY_EVENT) {
        const { usageCode, pressed } = decodeKeyEvent(frame.payload);
        this.machine.keyboard.pushRawEvent(usageCode, pressed);
      }
    }
  }
}
