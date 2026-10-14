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

export const CELL_SIZE = 4;

/** Rounds an offset up to the next 4-byte-aligned cell boundary
 * (FORTH-ARCHITECTURE.md §6's "alignment applies to the whole entry"). */
export function alignCell(offset: number): number {
  return (offset + (CELL_SIZE - 1)) & ~(CELL_SIZE - 1);
}

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

  /** spec/01-HAL.md §9.1's `hal_mem_fill`: sets `[offset, offset+length)`
   * to one repeated byte. Rebel-Sim's realization of the HAL's bulk
   * memory operations lives here rather than behind a host-injectable
   * interface (like `reportError`, there is exactly one implementation
   * on this target) — a typed-array `fill`, not a JS loop of
   * `writeByte()` calls, never mind a Forth `DO`/`LOOP`. Pure bytes, no
   * side effects (§9.2): filling `CHAR` this way leaves the framebuffer
   * stale until something calls `redrawAll()`. `length <= 0` is a no-op. */
  fillBytes(offset: number, length: number, value: number): void {
    if (length <= 0) return;
    new Uint8Array(this.buffer, offset, length).fill(value & 0xff);
  }

  /** spec/01-HAL.md §9.1's `hal_mem_copy`: copies `length` bytes from
   * `src` to `dst`, overlap-safe (memmove semantics, via `copyWithin`).
   * Note this is NOT `CMOVE`'s semantics for a destination inside the
   * source range — `CMOVE` (primitives.ts) handles that case itself,
   * §9.3. Same purity and `length <= 0` rule as `fillBytes`. */
  copyBytes(dst: number, src: number, length: number): void {
    if (length <= 0) return;
    if (src < 0 || dst < 0 || src + length > this.sizeBytes || dst + length > this.sizeBytes) {
      throw new RangeError(`copy of ${length} bytes ${src}->${dst} is outside the arena`);
    }
    new Uint8Array(this.buffer).copyWithin(dst, src, src + length);
  }

  /** Copies a host-side byte array (e.g. a storage asset's payload) into
   * the arena at `offset` — `hal_mem_copy` with a source outside
   * Forth-addressable memory, used by the Storage Module's asset loads
   * (spec/01-HAL.md §9.3). */
  writeBytes(offset: number, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    new Uint8Array(this.buffer, offset, bytes.length).set(bytes);
  }
}
