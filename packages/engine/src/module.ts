/**
 * Source modules (spec/01-HAL.md §6.7, M79): Forth source files a target
 * ships alongside its bootstrap source — `float.fth`, `memo.fth`,
 * `basic.fth` — loaded on demand with `MODULE name` (system.fth).
 *
 * The HAL read is non-blocking, like every HAL read (§2.2): it answers
 * at once with the bytes, with "missing", or with "pending" while the
 * host is still fetching. `(MODULE-READ)` builds the blocking behavior on
 * top, suspending the interpreter exactly as `KEY` does (inner.ts).
 */

/** "Still fetching — ask again later." */
export const MODULE_PENDING = 'pending' as const;

export interface ModuleHal {
  /** The module's source text, `undefined` if the target has no such
   * module, or `MODULE_PENDING` while it is still being fetched. `name`
   * is folded to upper case; matching it to a file is the host's job. */
  read(name: string): Uint8Array | undefined | typeof MODULE_PENDING;
}

/** A target with no modules. */
export const NULL_MODULE_HAL: ModuleHal = {
  read(): undefined {
    return undefined;
  },
};
