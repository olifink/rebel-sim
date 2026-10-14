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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import { Machine, MachineOptions } from './repl.js';
import { ModuleHal } from './module.js';

const SYSTEM_FTH_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../app/public/system.fth');
/** M78: the float wordset's Forth layer — the app's vendored copy of
 * rebel-specs/07-FLOATING-POINT.fth (float.test.ts checks they match). */
export const FLOAT_FTH_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../app/public/float.fth');

/** M79: the module HAL tests boot with — source modules are the app's
 * own `public/<name>.fth` files, read straight off disk, never pending. */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../app/public');
export const NODE_MODULE_HAL: ModuleHal = {
  read(name: string): Uint8Array | undefined {
    const path = join(PUBLIC_DIR, `${name.toLowerCase()}.fth`);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
  },
};

function withModules(options?: MachineOptions): MachineOptions {
  return { moduleHal: NODE_MODULE_HAL, ...options };
}

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

/** Boot images. Compiling system.fth through the self-hosted INTERPRET
 * takes ~7s, and float.fth another ~7s, and most test files boot a
 * fresh Machine per test. All program state lives in the arena
 * (CLAUDE.md, "Keep the Forth engine framework-agnostic"), so a booted
 * arena is kept and every boot after that is a new Machine with the
 * arena copied in — a few ms. Any JS-side state the constructor builds
 * is identical for an identical layout, and everything else (the
 * session, the input cursor, the keyboard queue, the lazily-found
 * INTERPRET xt) is transient. Options that change the memory layout get
 * a real boot.
 *
 * The images are compiled once per run by boot-image.global-setup.ts
 * and loaded from its temp directory, so no worker compiles at all. An
 * image whose recorded source hash no longer matches system.fth/
 * float.fth (watch mode, after an edit) is ignored and compiled fresh,
 * once per worker, as is everything when the setup didn't run. */
export const BOOT_IMAGE_KEYS = ['system', 'system+float'] as const;
type BootImageKey = (typeof BOOT_IMAGE_KEYS)[number];

declare module 'vitest' {
  export interface ProvidedContext {
    bootImageDir: string;
  }
}

const bootImages = new Map<BootImageKey, Uint8Array>();

function changesLayout(options?: MachineOptions): boolean {
  return options?.arenaSize !== undefined || options?.personality !== undefined || options?.bootProject !== undefined;
}

function loadFloatWordset(machine: Machine): void {
  machine.interpret('MODULE FLOAT');
}

function loadFor(key: BootImageKey): (m: Machine) => void {
  return key === 'system'
    ? loadSystemVocabulary
    : (m) => {
        loadSystemVocabulary(m);
        loadFloatWordset(m);
      };
}

/** Identifies the sources an image was compiled from. */
export function bootImageSourceHash(key: BootImageKey): string {
  const hash = createHash('sha1').update(readFileSync(SYSTEM_FTH_PATH));
  if (key === 'system+float') hash.update(readFileSync(FLOAT_FTH_PATH));
  return hash.digest('hex');
}

/** Compiles one boot image: a default-layout Machine's whole arena. */
export function buildBootImage(key: BootImageKey): Uint8Array {
  const machine = new Machine(withModules());
  loadFor(key)(machine);
  return new Uint8Array(machine.arena.buffer).slice();
}

function prebuiltImage(key: BootImageKey): Uint8Array | undefined {
  let dir: string | undefined;
  try {
    dir = inject('bootImageDir');
  } catch {
    return undefined; // not running under the global setup
  }
  if (!dir) return undefined;
  const bin = join(dir, `${key}.bin`);
  const hashFile = join(dir, `${key}.hash`);
  if (!existsSync(bin) || !existsSync(hashFile)) return undefined;
  if (readFileSync(hashFile, 'utf8') !== bootImageSourceHash(key)) return undefined;
  return new Uint8Array(readFileSync(bin));
}

function bootFromImage(key: BootImageKey, options?: MachineOptions): Machine {
  const machine = new Machine(withModules(options));
  if (changesLayout(options)) {
    loadFor(key)(machine);
    return machine;
  }
  let image = bootImages.get(key) ?? prebuiltImage(key);
  if (image === undefined) {
    loadFor(key)(machine);
    image = new Uint8Array(machine.arena.buffer).slice();
  } else {
    machine.arena.writeBytes(0, image);
  }
  bootImages.set(key, image);
  return machine;
}

/** M78: `bootMachine()` plus the float wordset, loaded the way a user
 * loads it: `MODULE FLOAT` (M79). Opt-in, so tests that don't need
 * floats don't pay for the bigger dictionary. */
export function bootMachineWithFloat(options?: MachineOptions): Machine {
  return bootFromImage('system+float', options);
}

/** `new Machine()` plus the bootstrap load — what any test exercising a
 * now-BOOTSTRAP word (control flow, `VARIABLE`/`CONSTANT`, stack/arithmetic
 * derivatives, ...) needs instead of a bare `new Machine()`. Served from
 * the boot-image cache above after the first call. */
export function bootMachine(options?: MachineOptions): Machine {
  return bootFromImage('system', options);
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
