/**
 * The Timing HAL (spec/01-HAL.md §7): the entire cross-target timing
 * surface is one function — monotonic milliseconds since an arbitrary
 * epoch. Unlike Screen/Storage, §7 defines no "Portable Timing Module"
 * layered on top and no delay/sleep primitive at this boundary — a
 * target choosing to build one (a Forth `DELAY`-style word) does so
 * later, in the portable layer, against this function and whatever
 * suspend mechanism it already has (inner.ts's generator `yield`s, for
 * Rebel-Sim). Nothing in the engine reads elapsed time yet, so this is
 * currently host-supplied plumbing only, establishing the HAL contract
 * for that future consumer rather than one that exists today.
 */

export interface TimingHal {
  /** Monotonic milliseconds since an arbitrary epoch (typically session
   * start). MUST be monotonic for the lifetime of one session. */
  millis(): number;
}

/** Engine-test/headless default — a fixed clock, matching NULL_SCREEN_HAL/
 * NULL_STORAGE_HAL's "correct enough for tests that don't exercise the
 * subsystem" shape. */
export const NULL_TIMING_HAL: TimingHal = {
  millis(): number {
    return 0;
  },
};
