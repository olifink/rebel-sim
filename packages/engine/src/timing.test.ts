import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { NULL_TIMING_HAL, TimingHal } from './timing.js';

describe('TimingHal wiring (spec/01-HAL.md §7)', () => {
  it('defaults to NULL_TIMING_HAL when no timingHal option is given', () => {
    const m = new Machine();
    expect(m.timingHal).toBe(NULL_TIMING_HAL);
    expect(m.timingHal.millis()).toBe(0);
  });

  it('stores a host-supplied TimingHal from MachineOptions', () => {
    const fakeClock: TimingHal = { millis: () => 12345 };
    const m = new Machine({ timingHal: fakeClock });
    expect(m.timingHal).toBe(fakeClock);
    expect(m.timingHal.millis()).toBe(12345);
  });
});
