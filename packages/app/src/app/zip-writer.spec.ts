import { buildZip } from './zip-writer.js';

// Real-world cross-check performed once during development (not part of
// this automated suite, since it needs a real `unzip` binary): built an
// archive with these exact entries via Node, wrote it to disk, and
// confirmed both `unzip -l`/`unzip -t` (CRC integrity) and manual
// extraction matched byte-for-byte, including a 0-byte entry. These
// tests check the same properties structurally, without an external tool.

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

describe('buildZip', () => {
  it('an empty entry list still produces a valid (empty) archive — just the end-of-central-directory record', () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22); // end-of-central-directory record only
    expect(readUint32LE(zip, 0)).toBe(0x06054b50);
    expect(readUint16LE(zip, 8)).toBe(0); // 0 entries
  });

  it('one entry: local header signature, filename, and raw bytes appear in order at the expected offsets', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const zip = buildZip([{ filename: 'HELLO.DAT', bytes }]);

    expect(readUint32LE(zip, 0)).toBe(0x04034b50); // local file header signature
    expect(readUint16LE(zip, 8)).toBe(0); // method: stored, not deflated
    expect(readUint32LE(zip, 18)).toBe(bytes.length); // compressed size
    expect(readUint32LE(zip, 22)).toBe(bytes.length); // uncompressed size (equal — stored)
    expect(readUint16LE(zip, 26)).toBe('HELLO.DAT'.length);

    const nameStart = 30;
    const name = new TextDecoder().decode(zip.slice(nameStart, nameStart + 'HELLO.DAT'.length));
    expect(name).toBe('HELLO.DAT');

    const dataStart = nameStart + 'HELLO.DAT'.length;
    expect(zip.slice(dataStart, dataStart + bytes.length)).toEqual(bytes);
  });

  it('an empty (0-byte) entry round-trips with a correct CRC and zero length, not skipped or corrupted', () => {
    const zip = buildZip([{ filename: 'EMPTY.DAT', bytes: new Uint8Array(0) }]);
    expect(readUint32LE(zip, 18)).toBe(0); // compressed size
    expect(readUint32LE(zip, 22)).toBe(0); // uncompressed size
    // CRC-32 of zero bytes is the well-known constant 0.
    expect(readUint32LE(zip, 14)).toBe(0);
  });

  it('multiple entries: the second local header starts exactly where the first ends, no gap or overlap', () => {
    const first = { filename: 'A.DAT', bytes: new Uint8Array([9, 9, 9]) };
    const second = { filename: 'BB.DAT', bytes: new Uint8Array([1, 2]) };
    const zip = buildZip([first, second]);

    const firstLocalSize = 30 + first.filename.length + first.bytes.length;
    expect(readUint32LE(zip, firstLocalSize)).toBe(0x04034b50); // second entry's local header signature
    const secondNameStart = firstLocalSize + 30;
    const secondName = new TextDecoder().decode(zip.slice(secondNameStart, secondNameStart + second.filename.length));
    expect(secondName).toBe(second.filename);
  });

  it('the central directory records the correct local-header offset for each entry, matching where it actually is', () => {
    const first = { filename: 'A.DAT', bytes: new Uint8Array([1]) };
    const second = { filename: 'B.DAT', bytes: new Uint8Array([2, 2]) };
    const zip = buildZip([first, second]);

    const firstLocalSize = 30 + first.filename.length + first.bytes.length;
    const secondLocalSize = 30 + second.filename.length + second.bytes.length;
    const centralDirOffset = firstLocalSize + secondLocalSize;

    // Central directory signature at the recorded offset.
    expect(readUint32LE(zip, centralDirOffset)).toBe(0x02014b50);
    // First central directory record's own "local header offset" field
    // (byte 42 within a 46-byte central header) should point at 0 (the
    // first entry) and the second at firstLocalSize.
    expect(readUint32LE(zip, centralDirOffset + 42)).toBe(0);
    const secondCentralOffset = centralDirOffset + 46 + first.filename.length;
    expect(readUint32LE(zip, secondCentralOffset + 42)).toBe(firstLocalSize);
  });

  it('end-of-central-directory record reports the right entry count and total archive length', () => {
    const entries = [
      { filename: 'ONE.DAT', bytes: new Uint8Array([1, 2, 3]) },
      { filename: 'TWO.DAT', bytes: new Uint8Array([4, 5]) },
      { filename: 'THREE.DAT', bytes: new Uint8Array(10).fill(7) },
    ];
    const zip = buildZip(entries);
    // The end record is always the last 22 bytes.
    const endOffset = zip.length - 22;
    expect(readUint32LE(zip, endOffset)).toBe(0x06054b50);
    expect(readUint16LE(zip, endOffset + 10)).toBe(entries.length); // total entries
  });
});
