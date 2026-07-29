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

const SYSV_BANK_SIZE = 256;
const DSTK_BANK_SIZE = 4096; // 1024 cells
const RSTK_BANK_SIZE = 4096; // 1024 cells
const DICT_BANK_SIZE = 1 << 16; // 64 KiB
const DEFAULT_ARENA_SIZE = 1 << 20; // 1 MiB, plenty through M2

export class Machine implements PrimitiveContext, DictionaryContext {
  readonly arena: Arena;
  readonly banks: BankTable;
  readonly stack: DataStack;
  readonly rstack: DataStack;
  readonly sysvars: Sysvars;
  readonly dictBank: Bank;
  private readonly inner: Inner;
  private output = '';

  constructor(arenaSize = DEFAULT_ARENA_SIZE) {
    this.arena = new Arena(arenaSize);
    this.banks = new BankTable(this.arena);
    const sysvBank = this.banks.createBank('SYSV', 'main', SYSV_BANK_SIZE);
    const dstkBank = this.banks.createBank('DSTK', 'main', DSTK_BANK_SIZE);
    const rstkBank = this.banks.createBank('RSTK', 'main', RSTK_BANK_SIZE);
    this.dictBank = this.banks.createBank('DICT', 'main', DICT_BANK_SIZE);

    this.sysvars = new Sysvars(this.arena, sysvBank);
    this.sysvars.setBase(10);
    this.sysvars.setState(0);
    this.sysvars.setLatest(0);
    this.sysvars.setHere(this.dictBank.base);

    this.stack = new DataStack(this.arena, dstkBank);
    this.rstack = new DataStack(this.arena, rstkBank);
    this.inner = new Inner(this.arena, this.rstack, this);

    for (const p of opcodes.primitives) {
      writeHeader(this, p.name, 0, p.id);
    }
  }

  emit(char: string): void {
    this.output += char;
  }

  getBase(): number {
    return this.sysvars.getBase();
  }

  /** Drains and returns everything emitted since the last call. */
  takeOutput(): string {
    const out = this.output;
    this.output = '';
    return out;
  }

  /** Interprets (or compiles, if STATE is active) one line of Forth
   * source, returning what it emitted. */
  interpret(line: string): string {
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
    return this.takeOutput();
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
