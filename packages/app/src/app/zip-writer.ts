/**
 * A minimal ZIP writer — "stored" (uncompressed) entries only. That's
 * the whole reason this needs no dependency and no DEFLATE
 * implementation: a stored entry is just its raw bytes plus a correct
 * header, not compressed data. Good enough for a handful of small
 * project asset files (each a few KB, per rebel-sim's own bank size
 * classes); not a general-purpose archiver — no directories-as-entries,
 * no ZIP64 (files here will never approach the 4 GiB per-entry limit
 * that would require it).
 *
 * Format reference: PKWARE's APPNOTE.TXT — local file header (per
 * entry) + entry bytes, repeated, then one central directory record
 * per entry, then a single end-of-central-directory record. Every
 * multi-byte field is little-endian, matching the spec.
 */

export interface ZipEntry {
  filename: string;
  bytes: Uint8Array;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_RECORD_SIGNATURE = 0x06054b50;
const VERSION = 20; // 2.0 — old enough that "stored" needs no extra feature flags

/** Bit-by-bit CRC-32 (the IEEE 802.3 / ZIP polynomial) — the standard
 * compact form: for each bit, XOR the polynomial in only when the
 * current LSB is set. `-(crc & 1)` is `0xFFFFFFFF` when that bit is 1
 * and `0` when it's 0, so `POLY & -(crc & 1)` is a branch-free "XOR the
 * polynomial in conditionally." */
function crc32(bytes: Uint8Array): number {
  const POLY = 0xedb88320;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (POLY & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP's own DOS-era timestamp encoding (16-bit time + 16-bit date,
 * 2-second resolution) — there's no real per-file mtime to preserve
 * here (Rebel-Sim's storage layer doesn't track one), so every entry
 * just gets "now," purely so the archive doesn't show a bogus 1980
 * date when extracted. */
function dosDateTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

/** Builds a complete ZIP archive (as bytes, ready to hand to a `Blob`)
 * from a flat list of filename/bytes entries — see this module's own
 * header comment for the format and its deliberate scope cuts. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.filename);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    local.setUint16(4, VERSION, true);
    local.setUint16(6, 0, true); // flags
    local.setUint16(8, 0, true); // method: 0 = stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed size == uncompressed, stored
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length
    localParts.push(new Uint8Array(local.buffer), nameBytes, entry.bytes);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    central.setUint16(4, VERSION, true); // version made by
    central.setUint16(6, VERSION, true); // version needed
    central.setUint16(8, 0, true); // flags
    central.setUint16(10, 0, true); // method: stored
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true); // extra field length
    central.setUint16(32, 0, true); // comment length
    central.setUint16(34, 0, true); // disk number start
    central.setUint16(36, 0, true); // internal file attrs
    central.setUint32(38, 0, true); // external file attrs
    central.setUint32(42, offset, true); // this entry's local header offset
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += local.buffer.byteLength + nameBytes.length + size;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralParts.reduce((sum, p) => sum + p.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_RECORD_SIGNATURE, true);
  end.setUint16(4, 0, true); // disk number
  end.setUint16(6, 0, true); // disk with the start of the central directory
  end.setUint16(8, entries.length, true); // entries on this disk
  end.setUint16(10, entries.length, true); // total entries
  end.setUint32(12, centralDirSize, true);
  end.setUint32(16, centralDirOffset, true);
  end.setUint16(20, 0, true); // comment length

  const allParts = [...localParts, ...centralParts, new Uint8Array(end.buffer)];
  const totalSize = allParts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of allParts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}
