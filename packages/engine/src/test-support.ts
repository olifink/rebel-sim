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

/** `new Machine()` plus the bootstrap load — what any test exercising a
 * now-BOOTSTRAP word (control flow, `VARIABLE`/`CONSTANT`, stack/arithmetic
 * derivatives, ...) needs instead of a bare `new Machine()`. */
export function bootMachine(options?: MachineOptions): Machine {
  const machine = new Machine(options);
  loadSystemVocabulary(machine);
  return machine;
}
