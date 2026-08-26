import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  MSG_CLEAR,
  MSG_CURSOR,
  MSG_HELLO,
  MSG_HELLO_ACK,
  MSG_KEY_EVENT,
  MSG_PLOT_CHAR,
  SYNC,
  decodeClear,
  decodeCursor,
  decodeHello,
  decodeHelloAck,
  decodeKeyEvent,
  decodePlotChar,
  encodeClear,
  encodeCursor,
  encodeFrame,
  encodeHello,
  encodeHelloAck,
  encodeKeyEvent,
  encodePlotChar,
} from './remote-terminal-protocol.js';

describe('remote-terminal-protocol: per-message encode/decode round-trips (REMOTE-TERMINAL.md §4)', () => {
  it('HELLO', () => {
    const fields = { protocolVersion: 1, charCols: 80, charRows: 60, charCellW: 8, charCellH: 8 };
    const frame = new FrameDecoder().push(encodeHello(fields))[0];
    expect(frame.msgId).toBe(MSG_HELLO);
    expect(decodeHello(frame.payload)).toEqual(fields);
  });

  it('HELLO_ACK', () => {
    const fields = { status: 0, negotiatedCols: 40, negotiatedRows: 25 };
    const frame = new FrameDecoder().push(encodeHelloAck(fields))[0];
    expect(frame.msgId).toBe(MSG_HELLO_ACK);
    expect(decodeHelloAck(frame.payload)).toEqual(fields);
  });

  it('PLOT_CHAR, including a color whose low byte is 0xA5 (the SYNC byte)', () => {
    const fields = { col: 1234, row: 999, charCode: 0x41, ink: 0x00ffa5, paper: 0xa5a5a5 };
    const frame = new FrameDecoder().push(encodePlotChar(fields))[0];
    expect(frame.msgId).toBe(MSG_PLOT_CHAR);
    expect(decodePlotChar(frame.payload)).toEqual(fields);
  });

  it('CLEAR', () => {
    const fields = { paper: 0x123456 };
    const frame = new FrameDecoder().push(encodeClear(fields))[0];
    expect(frame.msgId).toBe(MSG_CLEAR);
    expect(decodeClear(frame.payload)).toEqual(fields);
  });

  it('CURSOR', () => {
    const fields = { col: 5, row: 6, visible: true };
    const frame = new FrameDecoder().push(encodeCursor(fields))[0];
    expect(frame.msgId).toBe(MSG_CURSOR);
    expect(decodeCursor(frame.payload)).toEqual(fields);
  });

  it('KEY_EVENT', () => {
    const fields = { usageCode: 0x04, pressed: true };
    const frame = new FrameDecoder().push(encodeKeyEvent(fields))[0];
    expect(frame.msgId).toBe(MSG_KEY_EVENT);
    expect(decodeKeyEvent(frame.payload)).toEqual(fields);
  });
});

describe('FrameDecoder: resync algorithm (REMOTE-TERMINAL.md §6)', () => {
  it('decodes multiple frames delivered in one push()', () => {
    const decoder = new FrameDecoder();
    const a = encodeClear({ paper: 1 });
    const b = encodeClear({ paper: 2 });
    const frames = decoder.push(new Uint8Array([...a, ...b]));
    expect(frames).toHaveLength(2);
    expect(decodeClear(frames[0].payload)).toEqual({ paper: 1 });
    expect(decodeClear(frames[1].payload)).toEqual({ paper: 2 });
  });

  it('buffers a frame split across two push() calls', () => {
    const decoder = new FrameDecoder();
    const frame = encodeClear({ paper: 0xabcdef });
    const splitAt = 3;
    expect(decoder.push(frame.slice(0, splitAt))).toHaveLength(0);
    const [decoded] = decoder.push(frame.slice(splitAt));
    expect(decodeClear(decoded.payload)).toEqual({ paper: 0xabcdef });
  });

  it('discards only the leading SYNC byte on a checksum mismatch, then keeps scanning', () => {
    const decoder = new FrameDecoder();
    const good = encodeClear({ paper: 42 });
    const corrupted = encodeClear({ paper: 99 });
    corrupted[corrupted.length - 1] ^= 0xff; // flip the checksum byte

    const frames = decoder.push(new Uint8Array([...corrupted, ...good]));
    // The corrupted frame never decodes; the good one right after it still does.
    expect(frames).toHaveLength(1);
    expect(decodeClear(frames[0].payload)).toEqual({ paper: 42 });
  });

  it('skips leading noise bytes before the first valid frame', () => {
    const decoder = new FrameDecoder();
    const good = encodeClear({ paper: 7 });
    const garbage = new Uint8Array([0x00, 0xff, 0x00, 0xff]); // no embedded SYNC byte

    const frames = decoder.push(new Uint8Array([...garbage, ...good]));
    expect(frames).toHaveLength(1);
    expect(decodeClear(frames[0].payload)).toEqual({ paper: 7 });
  });

  it('recovers from a stray SYNC byte inside garbage that forms a bogus, checksum-failing candidate', () => {
    const decoder = new FrameDecoder();
    const good = encodeClear({ paper: 7 });
    // A lone SYNC byte followed by low-valued bytes: read as a candidate
    // frame (msgId=0x01, len=0x02), but its "checksum" byte is 0x00 —
    // essentially guaranteed to mismatch — so the decoder discards just
    // that leading SYNC and resumes scanning, reaching the real frame.
    const garbage = new Uint8Array([SYNC, 0x01, 0x02, 0x00, 0x00, 0x00]);

    const frames = decoder.push(new Uint8Array([...garbage, ...good]));
    expect(frames).toHaveLength(1);
    expect(decodeClear(frames[0].payload)).toEqual({ paper: 7 });
  });

  it('never misreads a SYNC byte occurring inside a valid, fully-buffered payload as a new frame start', () => {
    const decoder = new FrameDecoder();
    // ink's low byte is 0xA5 (SYNC) but the frame is delivered whole and
    // in sync, so LEN is trusted and the payload is consumed as one unit.
    const fields = { col: 0, row: 0, charCode: 0, ink: 0xa5, paper: 0 };
    const frames = decoder.push(encodePlotChar(fields));
    expect(frames).toHaveLength(1);
    expect(decodePlotChar(frames[0].payload)).toEqual(fields);
  });

  it('waits for more bytes rather than failing when a frame is merely incomplete', () => {
    const decoder = new FrameDecoder();
    const frame = encodeHello({ protocolVersion: 1, charCols: 80, charRows: 60, charCellW: 8, charCellH: 8 });
    expect(decoder.push(frame.slice(0, frame.length - 1))).toHaveLength(0);
    const frames = decoder.push(frame.slice(frame.length - 1));
    expect(frames).toHaveLength(1);
  });
});

describe('encodeFrame: raw layout (REMOTE-TERMINAL.md §3)', () => {
  it('matches the documented byte layout exactly for a known payload', () => {
    const payload = new Uint8Array([0x11, 0x22, 0x33]);
    const frame = encodeFrame(0x04, payload);
    // SYNC, MSG_ID, LEN, payload..., CHECKSUM
    expect(Array.from(frame)).toEqual([SYNC, 0x04, 3, 0x11, 0x22, 0x33, (0x04 + 3 + 0x11 + 0x22 + 0x33) & 0xff]);
  });
});
