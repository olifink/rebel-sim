/**
 * Wire protocol for `REMOTE-TERMINAL.md` (repo root) — a binary framing
 * format plus a fixed message catalog (§3/§4) letting a "board" role
 * (§8, a real interpreter whose screen HAL calls cross the wire) talk to
 * a "terminal" role (§7, decodes the wire back into a character grid).
 *
 * Deliberately not built on `channel.ts`'s `Channel` — that interface is
 * input-only, feeding a byte stream into a *locally* running interpreter.
 * This protocol is the reverse relationship (screen output flows out,
 * keyboard input flows back, both across one wire) — new design surface,
 * per `REMOTE-TERMINAL.md`'s own framing.
 *
 * Every multi-byte field is little-endian (`REMOTE-TERMINAL.md` §3, same
 * rule `FORTH-ARCHITECTURE.md` fixes for arena cells) — every `DataView`
 * call below passes `littleEndian: true` explicitly, never omitted.
 * Booleans are `TRUE = 0xFF` / `FALSE = 0x00` (§3's byte-width-scaled
 * version of the project's `-1`/`0` HAL convention) — decoded here as
 * "nonzero is true", not "must be exactly 0xFF", matching ordinary Forth
 * truthiness.
 *
 * The message-ID table stays hand-coded constants, not a JSON source of
 * truth (§9 names real cross-language codegen as deferred until
 * `FORTH-ARCHITECTURE.md` §0's own generator exists — building one just
 * for this fixed 6-message table now would be ahead of any real need).
 */

export const SYNC = 0xa5;

export const MSG_HELLO = 0x01;
export const MSG_HELLO_ACK = 0x02;
export const MSG_PLOT_CHAR = 0x03;
export const MSG_CLEAR = 0x04;
export const MSG_CURSOR = 0x05;
export const MSG_KEY_EVENT = 0x06;

export const PROTOCOL_VERSION = 1;

export const HelloAckStatusOk = 0;
export const HelloAckStatusVersionMismatch = 1;
export const HelloAckStatusUnsupportedCellSize = 2;

/** The one new transport abstraction this protocol needs — a plain
 * outbound byte sink. A real target adapts this to `navigator.serial`'s
 * `WritableStream`; the loopback harness (`remote-terminal-loopback.test.ts`)
 * adapts it to a direct function call into the other role's
 * `receiveBytes()`. */
export interface ByteSink {
  writeBytes(bytes: Uint8Array): void;
}

export interface HelloFields {
  readonly protocolVersion: number;
  readonly charCols: number;
  readonly charRows: number;
  readonly charCellW: number;
  readonly charCellH: number;
}

export interface HelloAckFields {
  readonly status: number;
  readonly negotiatedCols: number;
  readonly negotiatedRows: number;
}

export interface PlotCharFields {
  readonly col: number;
  readonly row: number;
  readonly charCode: number;
  readonly ink: number;
  readonly paper: number;
}

export interface ClearFields {
  readonly paper: number;
}

export interface CursorFields {
  readonly col: number;
  readonly row: number;
  readonly visible: boolean;
}

export interface KeyEventFields {
  readonly usageCode: number;
  readonly pressed: boolean;
}

function bool8(value: boolean): number {
  return value ? 0xff : 0x00;
}

/** `(MSG_ID + LEN + Σ payload) mod 256` — §3's checksum, computed
 * identically by both the encoder and the decoder so there's exactly one
 * definition of it in this file. */
function checksumOf(msgId: number, payload: Uint8Array): number {
  let sum = (msgId + payload.length) & 0xff;
  for (const b of payload) {
    sum = (sum + b) & 0xff;
  }
  return sum;
}

/** Wraps a payload in the full `SYNC/MSG_ID/LEN/.../CHECKSUM` frame (§3). */
export function encodeFrame(msgId: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + payload.length);
  frame[0] = SYNC;
  frame[1] = msgId;
  frame[2] = payload.length;
  frame.set(payload, 3);
  frame[3 + payload.length] = checksumOf(msgId, payload);
  return frame;
}

export function encodeHello(fields: HelloFields): Uint8Array {
  const view = new DataView(new ArrayBuffer(7));
  view.setUint8(0, fields.protocolVersion);
  view.setUint16(1, fields.charCols, true);
  view.setUint16(3, fields.charRows, true);
  view.setUint8(5, fields.charCellW);
  view.setUint8(6, fields.charCellH);
  return encodeFrame(MSG_HELLO, new Uint8Array(view.buffer));
}

export function decodeHello(payload: Uint8Array): HelloFields {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    protocolVersion: view.getUint8(0),
    charCols: view.getUint16(1, true),
    charRows: view.getUint16(3, true),
    charCellW: view.getUint8(5),
    charCellH: view.getUint8(6),
  };
}

export function encodeHelloAck(fields: HelloAckFields): Uint8Array {
  const view = new DataView(new ArrayBuffer(5));
  view.setUint8(0, fields.status);
  view.setUint16(1, fields.negotiatedCols, true);
  view.setUint16(3, fields.negotiatedRows, true);
  return encodeFrame(MSG_HELLO_ACK, new Uint8Array(view.buffer));
}

export function decodeHelloAck(payload: Uint8Array): HelloAckFields {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    status: view.getUint8(0),
    negotiatedCols: view.getUint16(1, true),
    negotiatedRows: view.getUint16(3, true),
  };
}

export function encodePlotChar(fields: PlotCharFields): Uint8Array {
  const view = new DataView(new ArrayBuffer(13));
  view.setUint16(0, fields.col, true);
  view.setUint16(2, fields.row, true);
  view.setUint8(4, fields.charCode);
  view.setUint32(5, fields.ink, true);
  view.setUint32(9, fields.paper, true);
  return encodeFrame(MSG_PLOT_CHAR, new Uint8Array(view.buffer));
}

export function decodePlotChar(payload: Uint8Array): PlotCharFields {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    col: view.getUint16(0, true),
    row: view.getUint16(2, true),
    charCode: view.getUint8(4),
    ink: view.getUint32(5, true),
    paper: view.getUint32(9, true),
  };
}

export function encodeClear(fields: ClearFields): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, fields.paper, true);
  return encodeFrame(MSG_CLEAR, new Uint8Array(view.buffer));
}

export function decodeClear(payload: Uint8Array): ClearFields {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { paper: view.getUint32(0, true) };
}

export function encodeCursor(fields: CursorFields): Uint8Array {
  const view = new DataView(new ArrayBuffer(5));
  view.setUint16(0, fields.col, true);
  view.setUint16(2, fields.row, true);
  view.setUint8(4, bool8(fields.visible));
  return encodeFrame(MSG_CURSOR, new Uint8Array(view.buffer));
}

export function decodeCursor(payload: Uint8Array): CursorFields {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    col: view.getUint16(0, true),
    row: view.getUint16(2, true),
    visible: view.getUint8(4) !== 0,
  };
}

export function encodeKeyEvent(fields: KeyEventFields): Uint8Array {
  const view = new DataView(new ArrayBuffer(2));
  view.setUint8(0, fields.usageCode);
  view.setUint8(1, bool8(fields.pressed));
  return encodeFrame(MSG_KEY_EVENT, new Uint8Array(view.buffer));
}

export function decodeKeyEvent(payload: Uint8Array): KeyEventFields {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    usageCode: view.getUint8(0),
    pressed: view.getUint8(1) !== 0,
  };
}

export interface DecodedFrame {
  readonly msgId: number;
  readonly payload: Uint8Array;
}

/** §6's resync algorithm, streaming: bytes can arrive in arbitrary chunks
 * (real WebSerial delivers arbitrary chunk boundaries) — `push()`
 * buffers whatever isn't yet a complete, validated frame and returns
 * every frame that newly completed. On a checksum mismatch, discards
 * only the one leading `SYNC` byte and resumes scanning from the very
 * next byte, never the whole candidate frame — so a false-positive
 * `0xA5` inside garbage can't get the reader stuck, and (since a
 * validated header's own `LEN` is trusted for exactly one frame's worth
 * of bytes once buffered) a `0xA5` occurring naturally inside a valid
 * payload is never misread as a new frame start during normal, synced
 * operation. */
export class FrameDecoder {
  private buffer: number[] = [];

  push(bytes: Uint8Array): DecodedFrame[] {
    for (const b of bytes) {
      this.buffer.push(b);
    }

    const frames: DecodedFrame[] = [];
    for (;;) {
      while (this.buffer.length > 0 && this.buffer[0] !== SYNC) {
        this.buffer.shift();
      }
      if (this.buffer.length < 3) {
        break; // not enough for SYNC + MSG_ID + LEN yet
      }
      const msgId = this.buffer[1];
      const len = this.buffer[2];
      const frameLen = 4 + len; // SYNC + MSG_ID + LEN + payload + CHECKSUM
      if (this.buffer.length < frameLen) {
        break; // wait for the rest of this frame
      }

      const payload = Uint8Array.from(this.buffer.slice(3, 3 + len));
      const checksumByte = this.buffer[3 + len];
      if (checksumByte === checksumOf(msgId, payload)) {
        frames.push({ msgId, payload });
        this.buffer.splice(0, frameLen);
      } else {
        this.buffer.shift(); // discard just the leading SYNC, keep scanning
      }
    }
    return frames;
  }
}
