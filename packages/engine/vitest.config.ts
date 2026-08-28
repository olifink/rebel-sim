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
    // 20s was generous headroom for several bootMachine() calls under
    // load without masking a genuine hang -- until M68's GRAPHICS
    // vocabulary (system.fth) added ~34 more dictionary entries (LINE/
    // RECT/CIRCLE and their internal state VARIABLEs). Every one of
    // those definitions' own word references pays the same O(dictionary
    // -size) FIND chain-walk this comment already describes, and there
    // are now more entries to walk past -- several screen-editor tests
    // (EDITOR, a separate vocabulary branching the same way GRAPHICS
    // does) started tripping the old 20s ceiling under full-suite
    // parallel contention, not from any bug in either vocabulary. 40s
    // is the same fix M48 already applied once for the same underlying
    // reason, just doubled again rather than re-litigated.
    testTimeout: 40_000,
  },
});
