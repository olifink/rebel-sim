/**
 * A `performance.now()`-backed TimingHal (spec/01-HAL.md §7) — monotonic
 * within one page session, unlike `Date.now()`, which can jump backward
 * on a wall-clock adjustment and would violate the spec's "MUST be
 * monotonic for the lifetime of one session" requirement.
 */

import { TimingHal } from '@rebel-sim/engine';

export const PERFORMANCE_TIMING_HAL: TimingHal = {
  millis(): number {
    return Math.floor(performance.now());
  },
};
