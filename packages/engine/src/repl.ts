/**
 * The outer interpreter / compiler (FORTH-ARCHITECTURE.md §4's STATE
 * sysvar drives the split): tokenizes a line and, per token, either
 * executes it (interpreting) or compiles a call/literal into the
 * definition under construction (compiling) — the classic Forth
 * text-interpreter loop. `:`/`;`/`IMMEDIATE` are handled as special
 * compiler syntax rather than dictionary words (see dictionary.ts's
 * header comment for why).
 */

import { Arena } from './arena.js';
import { Bank, BankTable } from './banks.js';
import { DataStack } from './stack.js';
import { Sysvars } from './sysvars.js';
import { PrimitiveContext } from './primitives.js';
import { Screen, ScreenHal } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Inner } from './inner.js';
import {
  abortDefinition,
  beginDefinition,
  compileCell,
  DictionaryContext,
  endDefinition,
  findWord,
  markLatestImmediate,
  writeHeader,
} from './dictionary.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const DOCOL = opcodes.docolTokenId;

const SYSV_BANK_SIZE = 4096; // 4 KiB, matches Rebel-ROM's XS size class (docs/SYSVARS.md §1)
const DSTK_BANK_SIZE = 4096; // 1024 cells
const RSTK_BANK_SIZE = 4096; // 1024 cells
const DICT_BANK_SIZE = 1 << 16; // 64 KiB
const KMAP_BANK_SIZE = 4096; // 4 KiB, matches Rebel-ROM's XS size class (docs/KEYBOARD.md §6); table itself is 512 bytes
const DEFAULT_ARENA_SIZE = 1 << 20; // 1 MiB, plenty through M4

// M3 boot-time screen mode. Rebel-ROM has no runtime mode-change
// mechanism yet either (docs/SCREEN-MODULE.md §9's "mode-change
// ownership: deferred") — Rebel-Sim boots into this mode and stays.
const DEFAULT_SCREEN_WIDTH = 320;
const DEFAULT_SCREEN_HEIGHT = 240;
const DEFAULT_CHAR_CELL_W = 8; // matches the ZX Spectrum 8x8 font port
const DEFAULT_CHAR_CELL_H = 8;
const DEFAULT_INK = 0x00ff00; // green
const DEFAULT_PAPER = 0x000000; // black

export interface MachineOptions {
  arenaSize?: number;
  /** Host-supplied pixel drawing (canvas, etc). Defaults to a no-op —
   * the CHAR bank / sysvar state is fully correct without one, which is
   * all engine-level tests need. */
  screenHal?: ScreenHal;
}

export class Machine implements PrimitiveContext, DictionaryContext {
  readonly arena: Arena;
  readonly banks: BankTable;
  readonly stack: DataStack;
  readonly rstack: DataStack;
  readonly sysvars: Sysvars;
  readonly dictBank: Bank;
  readonly screen: Screen;
  readonly keyboard: Keyboard;
  private readonly inner: Inner;

  constructor(options: MachineOptions = {}) {
    this.arena = new Arena(options.arenaSize ?? DEFAULT_ARENA_SIZE);
    this.banks = new BankTable(this.arena);
    const sysvBank = this.banks.createBank('SYSV', 'main', SYSV_BANK_SIZE);
    const dstkBank = this.banks.createBank('DSTK', 'main', DSTK_BANK_SIZE);
    const rstkBank = this.banks.createBank('RSTK', 'main', RSTK_BANK_SIZE);
    this.dictBank = this.banks.createBank('DICT', 'main', DICT_BANK_SIZE);

    this.sysvars = new Sysvars(this.arena, sysvBank);
    this.sysvars.initHeader();
    this.sysvars.setBase(10);
    this.sysvars.setState(0);
    this.sysvars.setLatest(0);
    this.sysvars.setHere(this.dictBank.base);

    const charCols = DEFAULT_SCREEN_WIDTH / DEFAULT_CHAR_CELL_W;
    const charRows = DEFAULT_SCREEN_HEIGHT / DEFAULT_CHAR_CELL_H;
    this.sysvars.set('SCREEN', 'SCREEN-WIDTH', DEFAULT_SCREEN_WIDTH);
    this.sysvars.set('SCREEN', 'SCREEN-HEIGHT', DEFAULT_SCREEN_HEIGHT);
    this.sysvars.set('SCREEN', 'CHAR-CELL-W', DEFAULT_CHAR_CELL_W);
    this.sysvars.set('SCREEN', 'CHAR-CELL-H', DEFAULT_CHAR_CELL_H);
    this.sysvars.set('SCREEN', 'CHAR-COLS', charCols);
    this.sysvars.set('SCREEN', 'CHAR-ROWS', charRows);
    this.sysvars.set('SCREEN', 'INK', DEFAULT_INK);
    this.sysvars.set('SCREEN', 'PAPER', DEFAULT_PAPER);
    this.sysvars.set('CORE', 'CURSOR-X', 0);
    this.sysvars.set('CORE', 'CURSOR-Y', 0);

    const charBank = this.banks.createBank('CHAR', 'main', charCols * charRows);
    this.screen = new Screen(this.arena, charBank, this.sysvars, options.screenHal);
    this.screen.cls();

    const kmapBank = this.banks.createBank('KMAP', 'main', KMAP_BANK_SIZE);
    this.keyboard = new Keyboard(this.arena, this.sysvars, kmapBank);

    this.stack = new DataStack(this.arena, dstkBank);
    this.rstack = new DataStack(this.arena, rstkBank);
    this.inner = new Inner(this.arena, this.rstack, this);

    for (const p of opcodes.primitives) {
      writeHeader(this, p.name, 0, p.id);
    }
  }

  getBase(): number {
    return this.sysvars.getBase();
  }

  /** Interprets (or compiles, if STATE is active) one line of Forth
   * source. Output is visible through `screen`/`stack`, not a return
   * value — M1/M2's plain-text output buffer was always a stand-in for
   * this (see primitives.ts's earlier history), retired now that a real
   * CHAR-bank-backed screen exists. */
  interpret(line: string): void {
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    try {
      while (i < tokens.length) {
        const token = tokens[i++];
        const upper = token.toUpperCase();

        if (this.sysvars.getState() === -1) {
          this.interpretCompiling(upper, token);
        } else {
          if (upper === ':') {
            beginDefinition(this, tokens[i++], DOCOL);
            continue;
          }
          this.interpretExecuting(upper, token);
        }
      }
    } catch (err) {
      if (this.sysvars.getState() === -1) {
        abortDefinition(this);
      }
      throw err;
    }
  }

  private interpretExecuting(upper: string, token: string): void {
    if (upper === ';') {
      throw new Error('; used outside a definition');
    }
    if (upper === 'IMMEDIATE') {
      markLatestImmediate(this);
      return;
    }
    const found = findWord(this, upper);
    if (found) {
      this.inner.executeXT(found.cfa);
      return;
    }
    const n = parseNumber(token, this.getBase());
    if (n === undefined) {
      throw new Error(`? unrecognized word: ${token}`);
    }
    this.stack.push(n);
  }

  private interpretCompiling(upper: string, token: string): void {
    if (upper === ':') {
      throw new Error(': cannot nest definitions');
    }
    if (upper === ';') {
      endDefinition(this, findWord(this, 'EXIT')!.cfa);
      return;
    }
    const found = findWord(this, upper);
    if (found) {
      if (found.immediate) {
        this.inner.executeXT(found.cfa);
      } else {
        compileCell(this, found.cfa);
      }
      return;
    }
    const n = parseNumber(token, this.getBase());
    if (n === undefined) {
      throw new Error(`? unrecognized word: ${token}`);
    }
    compileCell(this, findWord(this, 'LIT')!.cfa);
    compileCell(this, n);
  }
}

function parseNumber(token: string, base: number): number | undefined {
  const negative = token.startsWith('-');
  const body = negative ? token.slice(1) : token;
  if (body.length === 0 || !isValidInBase(body, base)) {
    return undefined;
  }
  const n = parseInt(body, base);
  if (Number.isNaN(n)) {
    return undefined;
  }
  return negative ? -n : n;
}

function isValidInBase(s: string, base: number): boolean {
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  return [...s.toLowerCase()].every((c) => digits.includes(c));
}
