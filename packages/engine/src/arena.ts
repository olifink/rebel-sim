/**
 * One arena = one ArrayBuffer + DataView pair (FORTH-ARCHITECTURE.md §3).
 * This is the ONLY module allowed to call DataView read/write methods
 * directly. Every multi-byte access is little-endian, with no exceptions
 * (§2) — DataView defaults to big-endian, so every call here passes
 * `littleEndian: true` explicitly.
 */

/** Forth cells are 32-bit; an arena's addressable region must never
 * exceed what an unsigned 32-bit offset reaches, even though a
 * DataView/ArrayBuffer isn't hardware-limited to that (§1). */
export const MAX_ARENA_SIZE = 0x1_0000_0000;

export class Arena {
  readonly buffer: ArrayBuffer;
  private readonly view: DataView;

  constructor(sizeBytes: number) {
    if (sizeBytes <= 0 || sizeBytes > MAX_ARENA_SIZE) {
      throw new RangeError(
        `arena size ${sizeBytes} out of range (0, ${MAX_ARENA_SIZE}]`,
      );
    }
    this.buffer = new ArrayBuffer(sizeBytes);
    this.view = new DataView(this.buffer);
  }

  get sizeBytes(): number {
    return this.buffer.byteLength;
  }

  readCell(offset: number): number {
    return this.view.getInt32(offset, true);
  }

  writeCell(offset: number, value: number): void {
    this.view.setInt32(offset, value, true);
  }

  readCellUnsigned(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  writeCellUnsigned(offset: number, value: number): void {
    this.view.setUint32(offset, value, true);
  }

  readByte(offset: number): number {
    return this.view.getUint8(offset);
  }

  writeByte(offset: number, value: number): void {
    this.view.setUint8(offset, value);
  }
}
