import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';

describe('BANK@ (DEVELOPING.md §10, M18)', () => {
  it('resolves a known bank name to the same base address findBank() reports', () => {
    const m = new Machine();
    const sysv = m.banks.findBank('SYSV')!;

    m.interpret('BANK@ SYSV');
    expect(m.stack.toArray()).toEqual([sysv.base]);
  });

  it('is case-insensitive, matching findWord/CREATE convention', () => {
    const m = new Machine();
    const dict = m.banks.findBank('DICT')!;

    m.interpret('BANK@ dict');
    expect(m.stack.toArray()).toEqual([dict.base]);
  });

  it('reaches every boot-created bank by name, not just a subset', () => {
    for (const bank of new Machine().banks.getAllBanks()) {
      const m = new Machine();
      m.interpret(`BANK@ ${bank.name}`);
      expect(m.stack.toArray()).toEqual([bank.base]);
    }
  });

  it('throws on an unknown name, same convention as \' on an unrecognized word', () => {
    const m = new Machine();
    expect(() => m.interpret('BANK@ NOPE')).toThrow('unknown bank: NOPE');
  });

  // M50 (found by Oliver): resolves by name now, not tag — name is the
  // real, uniqueness-backed identity (banks.ts), tag is expected to
  // repeat once multiple banks share one. Two DATA-tagged banks are
  // each individually reachable by their own name; a bare tag no longer
  // resolves at all (it was never a bank's actual identity).
  it('resolves each bank individually by name even when several share a tag', () => {
    const m = new Machine();
    const first = m.banks.createBank('DATA', 4096, 'FIRST');
    const second = m.banks.createBank('DATA', 4096, 'SECOND');

    m.interpret('BANK@ FIRST');
    expect(m.stack.pop()).toBe(first.base);

    m.interpret('BANK@ SECOND');
    expect(m.stack.pop()).toBe(second.base);

    expect(() => m.interpret('BANK@ DATA')).toThrow('unknown bank: DATA');
  });

  it('reaches a sysvar cell via its known bank base + group/field offset, from pure Forth source', () => {
    const m = new Machine();
    const stateAddr = m.sysvars.fieldOffset('FORTH', 'STATE');
    const sysv = m.banks.findBank('SYSV')!;
    const offset = stateAddr - sysv.base;

    m.interpret(`BANK@ SYSV ${offset} + @`);
    expect(m.stack.toArray()).toEqual([m.sysvars.getState()]);
  });

  it('arena size lives in MMAP\'s own header now, reachable the same way (DEVELOPING.md §20, M27)', () => {
    const m = new Machine();
    // ARENA-SIZE moved out of CORE.ARENA-SIZE into MMAP's header cell
    // at offset 8 (magic+version+reserved=4, NEXT-BANK=4) — arena
    // bookkeeping, not Forth-interpreter state.
    m.interpret('BANK@ MMAP 8 + @');
    expect(m.stack.toArray()).toEqual([m.arena.sizeBytes]);
  });
});

// M53 (found by Oliver, trying `: TESTING BANK@ CHAR ;`): BANK@ compiled
// as a plain non-IMMEDIATE call left the following name token for the
// compiler's own outer loop to choke on, since it was never meant to be
// looked up as an ordinary word. Fixed by making BANK@ IMMEDIATE and
// dual-mode on STATE — same S"/."-style pattern, but baking in a
// resolved LIT address rather than raw text.
describe('BANK@ compiled into a definition (M53)', () => {
  it('resolves the name at compile time and bakes its address in as a literal', () => {
    const m = new Machine();
    const sysv = m.banks.findBank('SYSV')!;

    m.interpret(': GET-SYSV BANK@ SYSV ;');
    m.interpret('GET-SYSV');
    expect(m.stack.toArray()).toEqual([sysv.base]);
  });

  it('is stack-neutral at runtime — no leftover input-consumption side effect', () => {
    const m = new Machine();
    m.interpret(': GET-DICT BANK@ DICT ;');

    m.interpret('DEPTH');
    const depthBefore = m.stack.pop();

    m.interpret('GET-DICT');
    m.stack.pop();
    m.interpret('DEPTH');
    expect(m.stack.pop()).toBe(depthBefore);
  });

  it('still resolves and pushes immediately when used interactively, unaffected by IMMEDIATE', () => {
    const m = new Machine();
    const dict = m.banks.findBank('DICT')!;

    m.interpret('BANK@ DICT');
    expect(m.stack.toArray()).toEqual([dict.base]);
  });

  it('still throws on an unknown name at compile time, before the definition is even built', () => {
    const m = new Machine();
    expect(() => m.interpret(': BAD BANK@ NOPE ;')).toThrow('unknown bank: NOPE');
  });

  it('composes with arithmetic in the same definition, same as the interactive form', () => {
    const m = new Machine();
    const stateAddr = m.sysvars.fieldOffset('FORTH', 'STATE');
    const sysv = m.banks.findBank('SYSV')!;
    const offset = stateAddr - sysv.base;

    m.interpret(`: GET-STATE BANK@ SYSV ${offset} + @ ;`);
    m.interpret('GET-STATE');
    expect(m.stack.toArray()).toEqual([m.sysvars.getState()]);
  });
});

describe('BANK-SIZE (rebel-opcodes.json 144)', () => {
  it('resolves a known bank name to the same size findBank() reports', () => {
    const m = new Machine();
    const sysv = m.banks.findBank('SYSV')!;

    m.interpret('BANK-SIZE SYSV');
    expect(m.stack.toArray()).toEqual([sysv.size]);
  });

  it('is case-insensitive, same convention as BANK@', () => {
    const m = new Machine();
    const dict = m.banks.findBank('DICT')!;

    m.interpret('BANK-SIZE dict');
    expect(m.stack.toArray()).toEqual([dict.size]);
  });

  it('reaches every boot-created bank by name, not just a subset', () => {
    for (const bank of new Machine().banks.getAllBanks()) {
      const m = new Machine();
      m.interpret(`BANK-SIZE ${bank.name}`);
      expect(m.stack.toArray()).toEqual([bank.size]);
    }
  });

  it('throws on an unknown name, same convention as BANK@', () => {
    const m = new Machine();
    expect(() => m.interpret('BANK-SIZE NOPE')).toThrow('unknown bank: NOPE');
  });

  it('reports the size class a requested size was rounded up to, not the raw request', () => {
    const m = new Machine();
    m.banks.createBank('DATA', 100, 'SMALL'); // rounds up to 2048 (MIN_BANK_SIZE, M58)
    m.interpret('BANK-SIZE SMALL');
    expect(m.stack.toArray()).toEqual([2048]);
  });
});

describe('BANKS (system.fth, M51)', () => {
  function screenText(m: Machine): string {
    const rows: string[] = [];
    for (let r = 0; r < m.screen.rows; r++) {
      rows.push(m.screen.readRowText(r));
    }
    return rows.join('');
  }

  it('lists every boot-created bank by name, MMAP itself included', () => {
    const m = bootMachine();
    m.interpret('BANKS');
    const listed = screenText(m);
    for (const bank of m.banks.getAllBanks()) {
      expect(listed).toContain(bank.name);
    }
    expect(listed).toContain('MMAP'); // bank 0, self-registered, not in getAllBanks()
  });

  it('a freshly CREATE-BANKed bank shows up too, by its real auto-generated name', () => {
    const m = bootMachine();
    m.interpret('64 CREATE-BANK DATA');
    const addr = m.stack.pop();
    // CREATE-BANK (primitives.ts case 100, M30) routes through
    // BankTable.createBank() with no name argument, so the tag typed
    // at creation ("DATA") is not the bank's real name — it gets an
    // auto-generated serial instead (banks.ts's generateSerialName()).
    const created = m.banks.getAllBanks().find((b) => b.base === addr);
    expect(created).toBeDefined();
    m.interpret('BANKS');
    expect(screenText(m)).toContain(created!.name);
  });

  it('is stack-neutral', () => {
    const m = bootMachine();
    m.interpret('DEPTH');
    const depthBefore = m.stack.pop();
    m.interpret('BANKS');
    m.interpret('DEPTH');
    expect(m.stack.pop()).toBe(depthBefore);
  });
});
