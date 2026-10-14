/**
 * spec/07-FLOATING-POINT.md §2–§4, M78: a float is an IEEE 754 binary32
 * value held in one ordinary cell. These helpers reinterpret a cell's
 * 32 bits as a float and back, and implement the eight KERNEL words'
 * arithmetic under §3's rules.
 *
 * The bit reinterpretation uses an `Int32Array` and a `Float32Array`
 * over one shared buffer — never a `DataView`, which stays private to
 * arena.ts. Both views use the host's byte order, so the round trip is
 * the same bits on any host; a cell's in-memory little-endian layout is
 * still arena.ts's business alone.
 */

const shared = new ArrayBuffer(4);
const asInt = new Int32Array(shared);
const asFloat = new Float32Array(shared);

/** §3 rule 6: the one NaN bit pattern every float word returns. */
export const CANONICAL_NAN = 0x7fc00000;

/** A cell's bits read as a binary32 value (widened exactly to a JS
 * double). */
export function cellToFloat(cell: number): number {
  asInt[0] = cell;
  return asFloat[0];
}

/** A JS number rounded to binary32 (round-to-nearest-even, subnormals
 * kept), returned as the cell holding its bits. Any NaN becomes the
 * canonical pattern. */
export function floatToCell(value: number): number {
  if (Number.isNaN(value)) {
    return CANONICAL_NAN;
  }
  asFloat[0] = value;
  return asInt[0];
}

/** `F>S`: truncates toward zero and saturates — §4 spells this out
 * because JS's own `| 0` would wrap modulo 2^32 instead. NaN gives 0. */
export function floatToInt(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= 2147483647) return 2147483647;
  if (value <= -2147483648) return -2147483648;
  return Math.trunc(value) | 0;
}
