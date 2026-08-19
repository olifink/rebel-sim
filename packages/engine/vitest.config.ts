import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Screen Editor follow-up: bootMachine() now compiles ~150 extra
    // lines of system.fth (LOAD, the EDITOR vocabulary) through the
    // self-hosted INTERPRET's own O(dictionary-size) FIND chain-walk
    // (test-support.ts's own AMPLE_STEP_BUDGET comment already flags
    // this cost model) — a single boot now costs ~500ms, up from ~200ms,
    // and a test calling bootMachine() more than once, under full-suite
    // parallel CPU contention, was measured tripping the 5000ms default
    // (control-flow.test.ts, then empty.test.ts, on separate runs — the
    // failure moves around, it isn't one specific test's own fault).
    // 20s is generous headroom for several bootMachine() calls under
    // load without masking a genuine hang.
    testTimeout: 20_000,
  },
});
