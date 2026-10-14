/**
 * Test-only helper — never imported by anything under `dist/`'s public
 * surface (not re-exported from `index.ts`). As of M42 (spec/04-FORTH-CORE.md
 * §6's KERNEL→BOOTSTRAP reclassification), a real chunk of what used to be
 * native primitives — the entire control-flow compiler, `VARIABLE`/
 * `CONSTANT`, several stack/arithmetic words — only exist once
 * `packages/app/public/system.fth` has been loaded into a `Machine`. A bare
 * `new Machine()` no longer has `IF`/`BEGIN`/`DO`/`VARIABLE`/etc. defined at
 * all — exactly like a real target before its own bootstrap load (§7.1).
 *
 * `packages/app/src/app/app.ts`'s `loadSystemVocabulary()` does this via
 * `fetch()`; the engine package has no DOM/fetch and must stay
 * framework-agnostic (CLAUDE.md), so this reads the same file straight off
 * disk via Node's `fs` — reasonable for test infrastructure (which already
 * runs under Node/vitest) even though the engine's actual runtime code never
 * touches the filesystem this way.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Machine, MachineOptions } from './repl.js';

const SYSTEM_FTH_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../app/public/system.fth');
/** M78: the float wordset's Forth layer — the app's vendored copy of
 * rebel-specs/07-FLOATING-POINT.fth (float.test.ts checks they match). */
export const FLOAT_FTH_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../app/public/float.fth');

let cachedSource: string | undefined;

function systemFthSource(): string {
  if (cachedSource === undefined) {
    cachedSource = readFileSync(SYSTEM_FTH_PATH, 'utf8');
  }
  return cachedSource;
}

/** Interprets `system.fth` line by line into an already-constructed
 * `Machine` — the same loop `app.ts`'s `loadSystemVocabulary()` runs. */
export function loadSystemVocabulary(machine: Machine): void {
  for (const line of systemFthSource().split('\n')) {
    machine.interpret(line);
  }
}

/** M78: `bootMachine()` plus the float wordset's Forth layer, loaded
 * after system.fth exactly as the app does. Opt-in, so tests that don't
 * need floats don't pay for the bigger dictionary. */
export function bootMachineWithFloat(options?: MachineOptions): Machine {
  const machine = bootMachine(options);
  for (const line of readFileSync(FLOAT_FTH_PATH, 'utf8').split('\n')) {
    machine.interpret(line);
  }
  machine.interpret('SEAL-BOOT');
  return machine;
}

/** `new Machine()` plus the bootstrap load — what any test exercising a
 * now-BOOTSTRAP word (control flow, `VARIABLE`/`CONSTANT`, stack/arithmetic
 * derivatives, ...) needs instead of a bare `new Machine()`. */
export function bootMachine(options?: MachineOptions): Machine {
  const machine = new Machine(options);
  loadSystemVocabulary(machine);
  return machine;
}

/** A `Machine.step()` budget generous enough for tests driving a `bootMachine()`
 * incrementally (breakpoints, mid-line pausing). Once the self-hosted
 * `INTERPRET` (M43) is what's actually dispatching a line, `FIND`'s own
 * chain-walk — O(dictionary size), ~170 entries once `system.fth` has
 * loaded — costs on the order of several thousand primitive-level
 * `'progress'` yields *per token*, not the roughly-one-token-per-step the
 * old native tokenizer gave. Still microseconds of real wall-clock time;
 * just a much finer step granularity than a small hardcoded budget like
 * `1000` assumes. */
export const AMPLE_STEP_BUDGET = 50_000;
