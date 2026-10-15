import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Machine } from './repl.js';
import { FLOAT_FTH_PATH, bootMachineWithFloat } from './test-support.js';

const hex = (cell: number): string => (cell >>> 0).toString(16).toUpperCase().padStart(8, '0');
const cell = (h: string): number => parseInt(h, 16) | 0;

/** Pushes the given cells (hex bit patterns or plain integers), runs
 * `words`, and returns the stack top as an 8-digit hex pattern. */
function run(m: Machine, words: string, ...args: (string | number)[]): string {
  m.stack.clear();
  for (const a of args) m.stack.push(typeof a === 'string' ? cell(a) : a);
  m.interpret(words);
  return hex(m.stack.pop());
}

describe('float KERNEL words (M78, spec/07-FLOATING-POINT.md §3, §4)', () => {
  const m = new Machine();

  it('F+ F* F/ FSQRT are correctly rounded binary32', () => {
    expect(run(m, 'F+', '3DCCCCCD', '3E4CCCCD')).toBe('3E99999A'); // 0.1 + 0.2
    expect(run(m, 'F*', '3DCCCCCD', '41200000')).toBe('3F800000'); // 0.1 * 10
    expect(run(m, 'F/', '3F800000', '40400000')).toBe('3EAAAAAB'); // 1 / 3
    expect(run(m, 'FSQRT', '40000000')).toBe('3FB504F3'); // sqrt 2
    expect(run(m, 'FSQRT', '80000000')).toBe('80000000'); // -0 stays -0
  });

  it('subnormals are kept, overflow and x/0 give infinities, and every NaN is canonical', () => {
    expect(run(m, 'F/', '00800000', '40000000')).toBe('00400000'); // smallest normal / 2
    expect(run(m, 'F*', '7F7FFFFF', '40000000')).toBe('7F800000'); // overflow -> +inf
    expect(run(m, 'F/', 'BF800000', '00000000')).toBe('FF800000'); // -1 / 0 -> -inf
    expect(run(m, 'F/', '00000000', '00000000')).toBe('7FC00000'); // 0/0
    expect(run(m, 'FSQRT', 'BF800000')).toBe('7FC00000'); // sqrt -1
    expect(run(m, 'F+', '7FC00001', '3F800000')).toBe('7FC00000'); // NaN payload dropped
  });

  it('F< and F= are numeric: NaN compares false, -0 equals +0', () => {
    expect(run(m, 'F<', '3F800000', '40000000')).toBe('FFFFFFFF');
    expect(run(m, 'F<', '7FC00000', '40000000')).toBe('00000000');
    expect(run(m, 'F=', '80000000', '00000000')).toBe('FFFFFFFF');
    expect(run(m, 'F=', '7FC00000', '7FC00000')).toBe('00000000');
  });

  it('S>F rounds to nearest-even; F>S truncates toward zero and saturates', () => {
    expect(run(m, 'S>F', 16777217)).toBe('4B800000'); // 2^24 + 1 rounds to even
    expect(run(m, 'S>F', -3)).toBe('C0400000');
    expect(m.stack.toArray()).toEqual([]);
    for (const [input, out] of [
      ['C0600000', -3], // -3.5 -> -3
      ['3FFFFFFF', 1], // 1.99999...
      ['7F800000', 2147483647], // +inf saturates
      ['DF000001', -2147483648], // below the range
      ['7FC00000', 0], // NaN
    ] as const) {
      m.stack.push(cell(input));
      m.interpret('F>S');
      expect(m.stack.pop()).toBe(out);
    }
  });
});

describe('float Forth layer (float.fth = rebel-specs/07-FLOATING-POINT.fth, M78)', () => {
  it('the vendored copy matches the spec reference source', () => {
    const spec = join(dirname(fileURLToPath(import.meta.url)), '../../../rebel-specs/07-FLOATING-POINT.fth');
    if (!existsSync(spec)) return; // checkout without the rebel-specs submodule
    expect(readFileSync(FLOAT_FTH_PATH, 'utf8')).toBe(readFileSync(spec, 'utf8'));
  });

  it('reproduces every test vector in spec §5.2 and §5.3 bit for bit', () => {
    const m = bootMachineWithFloat();
    // §5.2 elementary functions
    const fn: [string, string[], string][] = [
      ['FEXP', ['3F800000'], '402DF854'],
      ['FEXP', ['BF800000'], '3EBC5AB2'],
      ['FEXP', ['41200000'], '46AC14EE'],
      ['FLN', ['40000000'], '3F317218'],
      ['FLN', ['41200000'], '40135D8E'],
      ['FLN', ['3F000000'], 'BF317218'],
      ['FSIN', ['3F800000'], '3F576AA4'],
      ['FSIN', ['40400000'], '3E1081C4'],
      ['FSIN', ['42C80000'], 'BF01A12E'],
      ['FCOS', ['3F800000'], '3F0A5140'],
      ['FCOS', ['40400000'], 'BF7D7026'],
      ['FTAN', ['3F800000'], '3FC75923'],
      ['FATAN', ['3F800000'], '3F490FDB'],
      ['FATAN', ['3F000000'], '3EED6338'],
      ['FATAN', ['41200000'], '3FBC4DEA'],
      ['F**', ['40000000', '3FC00000'], '403504F3'],
    ];
    for (const [word, args, want] of fn) {
      expect(`${word} ${args.join(' ')} -> ${run(m, word, ...args)}`).toBe(`${word} ${args.join(' ')} -> ${want}`);
    }

    // §5.3 (F.)
    const fdot: [string, string][] = [
      ['3DCCCCCD', '0.1'],
      ['3EAAAAAB', '0.3333333'],
      ['3FB504F3', '1.414214'],
      ['40490FDB', '3.141593'],
      ['501502F9', '1E+10'],
      ['36D1B717', '6.25E-06'],
      ['C1480000', '-12.5'],
      ['0DA24260', '1E-30'],
    ];
    for (const [input, want] of fdot) {
      m.stack.clear();
      m.stack.push(cell(input));
      m.interpret('(F.)');
      const len = m.stack.pop();
      const addr = m.stack.pop();
      const text = Array.from({ length: len }, (_, i) => String.fromCharCode(m.arena.readByte(addr + i))).join('');
      expect(`${input} -> ${text}`).toBe(`${input} -> ${want}`);
    }

    // §5.3 >FLOAT
    const parse: [string, string][] = [
      ['0.1', '3DCCCCCD'],
      ['3.14159', '40490FD0'],
      ['1E-30', '0DA24260'],
      ['-2.5E7', 'CBBEBC20'],
    ];
    for (const [text, want] of parse) {
      m.stack.clear();
      m.interpret(`S" ${text}" >FLOAT`);
      expect(m.stack.pop()).toBe(-1);
      expect(`${text} -> ${hex(m.stack.pop())}`).toBe(`${text} -> ${want}`);
    }
    // Written straight into memory, not through S" (which skips leading
    // spaces), so " 1" really reaches >FLOAT with its space.
    const scratch = m.banks.createBank('DATA', 64);
    for (const bad of ['', '1.5x', ' 1', '1 ', '.', '1E', 'E5', '--1']) {
      for (let i = 0; i < bad.length; i++) m.arena.writeByte(scratch.base + i, bad.charCodeAt(i));
      m.stack.clear();
      m.stack.push(scratch.base);
      m.stack.push(bad.length);
      m.interpret('>FLOAT');
      expect(`'${bad}' -> ${m.stack.toArray()}`).toBe(`'${bad}' -> 0`);
    }
  });

  it('F# reads a literal interpreted or compiled, F. prints, and after EMPTY NEEDS FLOAT loads it again', () => {
    const m = bootMachineWithFloat();
    m.interpret('F# 1.5 F# 2 F*');
    expect(hex(m.stack.pop())).toBe('40400000'); // 3.0
    m.interpret(': HALF F# 0.5 F* ;');
    m.interpret('F# 3 HALF');
    expect(hex(m.stack.pop())).toBe('3FC00000'); // 1.5
    expect(() => m.interpret('F# nonsense')).toThrow();

    m.stack.clear();
    m.interpret('CLS F# -12.5 F.');
    expect(m.screen.readRowText(0).trimEnd()).toBe('-12.5');

    // Loaded on demand (M79), so EMPTY removes the wordset with its
    // FLOAT.FTH marker, and NEEDS FLOAT really loads it again.
    m.interpret('EMPTY');
    expect(() => m.interpret('HALF')).toThrow();
    expect(() => m.interpret('F# 2')).toThrow();
    m.interpret('NEEDS FLOAT F# 2 FSQRT');
    expect(hex(m.stack.pop())).toBe('3FB504F3');
  });
});
