/**
 * The outer interpreter for M1: no dictionary/compiler yet
 * (FORTH-ARCHITECTURE.md §5's DOCOL branch arrives in M2). Given a line
 * of text, whitespace-tokenize, and for each token either parse it as a
 * number literal or look it up by name in the fixed primitive table from
 * rebel-opcodes.json and execute it immediately.
 */

import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { DataStack } from './stack.js';
import { Sysvars } from './sysvars.js';
import { executePrimitive, PrimitiveContext } from './primitives.js';
import opcodes from './rebel-opcodes.json' with { type: 'json' };

const NAME_TO_TOKEN = new Map<string, number>(
  opcodes.primitives.map((p) => [p.name, p.id]),
);

const SYSV_BANK_SIZE = 256;
const DSTK_BANK_SIZE = 4096; // 1024 cells
const DEFAULT_ARENA_SIZE = 1 << 20; // 1 MiB, plenty for M1

export class Machine implements PrimitiveContext {
  readonly arena: Arena;
  readonly banks: BankTable;
  readonly stack: DataStack;
  readonly sysvars: Sysvars;
  private output = '';

  constructor(arenaSize = DEFAULT_ARENA_SIZE) {
    this.arena = new Arena(arenaSize);
    this.banks = new BankTable(this.arena);
    const sysvBank = this.banks.createBank('SYSV', 'main', SYSV_BANK_SIZE);
    const dstkBank = this.banks.createBank('DSTK', 'main', DSTK_BANK_SIZE);
    this.sysvars = new Sysvars(this.arena, sysvBank);
    this.sysvars.setBase(10);
    this.sysvars.setState(0);
    this.stack = new DataStack(this.arena, dstkBank);
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

  /** Interprets one line of Forth source, returning what it emitted. */
  interpret(line: string): string {
    for (const token of line.trim().split(/\s+/).filter(Boolean)) {
      const tokenId = NAME_TO_TOKEN.get(token.toUpperCase());
      if (tokenId !== undefined) {
        executePrimitive(this, tokenId);
        continue;
      }
      const n = parseNumber(token, this.getBase());
      if (n === undefined) {
        throw new Error(`? unrecognized word: ${token}`);
      }
      this.stack.push(n);
    }
    return this.takeOutput();
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
