/**
 * Dictionary header layout (FORTH-ARCHITECTURE.md §6), identical shape
 * for both boot-registered primitives and user colon-definitions:
 *
 *   Link Pointer (4 bytes)   — offset of the previous entry, 0 = end of chain
 *   Flags + Length (1 byte)  — bit7 IMMEDIATE, bit6 HIDDEN, bit5 COMPILE-ONLY, bits4..0 name length (0-31)
 *   Name (N bytes)           — ASCII, zero-padded so the Code Field starts 4-byte aligned
 *   Code Field (4 bytes)     — token ID: a primitive (1..N) or DOCOL (0)
 *   Parameter Field (...)    — present only for DOCOL entries: a list of XTs
 *
 * `:`/`;`/`IMMEDIATE` are deliberately NOT modeled as dictionary words
 * here (a legitimate minimal-Forth simplification, not every classic
 * Forth's choice) — they need direct access to compiler state
 * (HERE/LATEST/STATE) that a plain primitive's stack-effect-only
 * interface (primitives.ts) doesn't expose, so the outer interpreter
 * (repl.ts) special-cases them as compiler syntax instead.
 */

import { alignCell, Arena, CELL_SIZE } from './arena.js';
import { Bank } from './banks.js';
import { Sysvars } from './sysvars.js';

export const FLAG_IMMEDIATE = 0x80;
export const FLAG_HIDDEN = 0x40;
export const FLAG_COMPILE_ONLY = 0x20;
export const NAME_LEN_MASK = 0x1f;
const MAX_NAME_LENGTH = 31;

export interface DictionaryContext {
  readonly arena: Arena;
  readonly dictBank: Bank;
  readonly sysvars: Sysvars;
}

export interface DictionaryEntry {
  readonly entryAddr: number;
  readonly cfa: number;
  readonly name: string;
  readonly immediate: boolean;
  /** M8: FLAG_COMPILE_ONLY was reserved in the header layout from the
   * start but never actually checked anywhere until control-flow words
   * (IF/DO/etc.) needed it — using one outside a definition wouldn't
   * error, it would just start corrupting HERE. Now wired up: the outer
   * interpreter (repl.ts) rejects a compile-only word found while
   * interpreting (STATE=0). */
  readonly compileOnly: boolean;
}

function decodeName(ctx: DictionaryContext, addr: number, len: number): string {
  let name = '';
  for (let i = 0; i < len; i++) {
    name += String.fromCharCode(ctx.arena.readByte(addr + 5 + i));
  }
  return name;
}

export class DictionaryOverflowError extends Error {}

/** Creates one dictionary entry, links it in as the new LATEST, and
 * advances HERE past its Code Field. Returns the new entry's Code Field
 * address (the XT callers compile into parameter fields / execute). */
export function writeHeader(
  ctx: DictionaryContext,
  name: string,
  extraFlags: number,
  codeField: number,
): DictionaryEntry {
  const upperName = name.toUpperCase();
  if (upperName.length === 0 || upperName.length > MAX_NAME_LENGTH) {
    throw new RangeError(
      `dictionary name must be 1-${MAX_NAME_LENGTH} characters, got ${upperName.length}: ${name}`,
    );
  }

  const entryAddr = ctx.sysvars.getHere();
  const cfa = alignCell(entryAddr + 5 + upperName.length);
  const entryEnd = cfa + CELL_SIZE;
  if (entryEnd > ctx.dictBank.base + ctx.dictBank.size) {
    throw new DictionaryOverflowError(`DICT bank out of space defining ${name}`);
  }

  const { arena } = ctx;
  arena.writeCellUnsigned(entryAddr, ctx.sysvars.getLatest());
  arena.writeByte(entryAddr + 4, (extraFlags & 0xe0) | (upperName.length & NAME_LEN_MASK));
  for (let i = 0; i < upperName.length; i++) {
    arena.writeByte(entryAddr + 5 + i, upperName.charCodeAt(i));
  }
  for (let p = entryAddr + 5 + upperName.length; p < cfa; p++) {
    arena.writeByte(p, 0);
  }
  arena.writeCell(cfa, codeField);

  ctx.sysvars.setHere(entryEnd);
  ctx.sysvars.setLatest(entryAddr);

  return {
    entryAddr,
    cfa,
    name: upperName,
    immediate: (extraFlags & FLAG_IMMEDIATE) !== 0,
    compileOnly: (extraFlags & FLAG_COMPILE_ONLY) !== 0,
  };
}

/** Walks the LATEST chain via link pointers, skipping HIDDEN entries,
 * most-recently-defined-wins on name collision (§6/§3's chain shape). */
export function findWord(ctx: DictionaryContext, name: string): DictionaryEntry | undefined {
  const upperName = name.toUpperCase();
  const { arena } = ctx;
  let addr = ctx.sysvars.getLatest();

  while (addr !== 0) {
    const flagsByte = arena.readByte(addr + 4);
    const len = flagsByte & NAME_LEN_MASK;
    const hidden = (flagsByte & FLAG_HIDDEN) !== 0;

    if (!hidden && len === upperName.length) {
      let match = true;
      for (let i = 0; i < len; i++) {
        if (arena.readByte(addr + 5 + i) !== upperName.charCodeAt(i)) {
          match = false;
          break;
        }
      }
      if (match) {
        const cfa = alignCell(addr + 5 + len);
        return {
          entryAddr: addr,
          cfa,
          name: upperName,
          immediate: (flagsByte & FLAG_IMMEDIATE) !== 0,
          compileOnly: (flagsByte & FLAG_COMPILE_ONLY) !== 0,
        };
      }
    }

    addr = arena.readCellUnsigned(addr);
  }

  return undefined;
}

/** Walks the LATEST chain like findWord, but collects every visible
 * (non-HIDDEN) entry instead of matching one name — for UI/debugging
 * use only (e.g. an inspector panel). Most-recently-defined first,
 * same order the Forth-level WORDS walk prints. */
export function listDictionaryEntries(ctx: DictionaryContext): DictionaryEntry[] {
  const { arena } = ctx;
  const entries: DictionaryEntry[] = [];
  let addr = ctx.sysvars.getLatest();

  while (addr !== 0) {
    const flagsByte = arena.readByte(addr + 4);
    const len = flagsByte & NAME_LEN_MASK;
    const hidden = (flagsByte & FLAG_HIDDEN) !== 0;

    if (!hidden) {
      const cfa = alignCell(addr + 5 + len);
      entries.push({
        entryAddr: addr,
        cfa,
        name: decodeName(ctx, addr, len),
        immediate: (flagsByte & FLAG_IMMEDIATE) !== 0,
        compileOnly: (flagsByte & FLAG_COMPILE_ONLY) !== 0,
      });
    }

    addr = arena.readCellUnsigned(addr);
  }

  return entries;
}

export function markLatestImmediate(ctx: DictionaryContext): void {
  const addr = ctx.sysvars.getLatest();
  if (addr === 0) {
    throw new Error('IMMEDIATE: no word has been defined yet');
  }
  const flagsAddr = addr + 4;
  ctx.arena.writeByte(flagsAddr, ctx.arena.readByte(flagsAddr) | FLAG_IMMEDIATE);
}

function clearLatestHidden(ctx: DictionaryContext): void {
  const addr = ctx.sysvars.getLatest();
  const flagsAddr = addr + 4;
  ctx.arena.writeByte(flagsAddr, ctx.arena.readByte(flagsAddr) & ~FLAG_HIDDEN);
}

/** Appends one cell to the definition currently being compiled (the
 * parameter field growing at HERE). */
export function compileCell(ctx: DictionaryContext, value: number): void {
  const here = ctx.sysvars.getHere();
  if (here + CELL_SIZE > ctx.dictBank.base + ctx.dictBank.size) {
    throw new DictionaryOverflowError('DICT bank out of space compiling a definition');
  }
  ctx.arena.writeCell(here, value);
  ctx.sysvars.setHere(here + CELL_SIZE);
}

/** `:` — begins a colon-definition: header written and linked in
 * immediately (so HERE/LATEST advance right away), but HIDDEN so
 * `findWord` can't see it mid-compilation (no self-reference/RECURSE
 * support in M2 — a deliberate scope cut, not an oversight). */
export function beginDefinition(ctx: DictionaryContext, name: string | undefined, docolToken: number): void {
  if (ctx.sysvars.getState() === -1) {
    throw new Error(': cannot nest definitions');
  }
  if (!name) {
    throw new Error(': expected a word name');
  }
  writeHeader(ctx, name, FLAG_HIDDEN, docolToken);
  ctx.sysvars.setState(-1);
}

/** `;` — compiles the trailing EXIT, unhides the word, returns to
 * interpreting. `exitXt` is the boot-registered EXIT primitive's XT. */
export function endDefinition(ctx: DictionaryContext, exitXt: number): void {
  compileCell(ctx, exitXt);
  clearLatestHidden(ctx);
  ctx.sysvars.setState(0);
}

/** Rolls back a definition left half-built by an error mid-compilation:
 * reclaims its DICT space and restores LATEST to what it linked from. */
export function abortDefinition(ctx: DictionaryContext): void {
  const abortedAddr = ctx.sysvars.getLatest();
  const prevLatest = ctx.arena.readCellUnsigned(abortedAddr);
  ctx.sysvars.setLatest(prevLatest);
  ctx.sysvars.setHere(abortedAddr);
  ctx.sysvars.setState(0);
}
