import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { VERSION_MAJOR, VERSION_MILESTONE } from './version.js';
import { BUILD_STAMP } from './build-info.js';

describe('VERSION (rebel-opcodes.json 143)', () => {
  it('prints "Rebel Forth vMAJOR.MILESTONE.BUILD" and nothing else on the line', () => {
    const m = new Machine();
    m.interpret('VERSION');
    expect(m.screen.readRowText(0).trimEnd()).toBe(
      `Rebel Forth v${VERSION_MAJOR}.${VERSION_MILESTONE}.${BUILD_STAMP}`,
    );
  });

  it('is stack-neutral', () => {
    const m = new Machine();
    m.interpret('1 2 3');
    m.interpret('VERSION');
    expect(m.stack.toArray()).toEqual([3, 2, 1]);
  });

  it('is a native primitive, findable before system.fth loads (no bootstrap layer needed)', () => {
    // Deliberately `new Machine()`, not bootMachine() — VERSION has to be
    // printable as the very first thing app.ts does, right after
    // system.fth finishes loading but before anything else runs, so it
    // can't depend on the self-hosted layer being present.
    const m = new Machine();
    expect(() => m.interpret("' VERSION")).not.toThrow();
  });
});
