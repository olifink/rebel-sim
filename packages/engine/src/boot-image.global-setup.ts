/**
 * vitest globalSetup: compiles the bootMachine()/bootMachineWithFloat()
 * boot images once per test run, before any worker starts, and hands
 * the workers a temp directory to load them from (test-support.ts).
 * Without this every test file compiled system.fth itself (~7s, ~15s
 * with float.fth) at the same moment, and under that contention the
 * first test of a file could trip testTimeout.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { BOOT_IMAGE_KEYS, buildBootImage, bootImageSourceHash } from './test-support.js';

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'rebel-sim-boot-'));
  for (const key of BOOT_IMAGE_KEYS) {
    writeFileSync(join(dir, `${key}.bin`), buildBootImage(key));
    writeFileSync(join(dir, `${key}.hash`), bootImageSourceHash(key));
  }
  project.provide('bootImageDir', dir);
  return () => rmSync(dir, { recursive: true, force: true });
}
