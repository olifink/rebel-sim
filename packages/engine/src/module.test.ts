import { describe, expect, it } from 'vitest';
import { MODULE_PENDING, ModuleHal } from './module.js';
import { bootMachine } from './test-support.js';
import { BankFlagRemoved } from './banks.js';

/** In-memory modules, counting reads, optionally pending for a while. */
class FakeModules implements ModuleHal {
  reads: string[] = [];
  pendingFor = 0;
  constructor(private readonly sources: Record<string, string>) {}
  read(name: string): Uint8Array | undefined | typeof MODULE_PENDING {
    this.reads.push(name);
    if (this.pendingFor > 0) {
      this.pendingFor--;
      return MODULE_PENDING;
    }
    const text = this.sources[name];
    return text === undefined ? undefined : new TextEncoder().encode(text);
  }
}

const screenText = (m: ReturnType<typeof bootMachine>): string =>
  Array.from({ length: m.screen.rows }, (_, r) => m.screen.readRowText(r).trimEnd()).join('\n');

describe('NEEDS (system.fth over (MODULE-READ), M79, spec/04-FORTH-CORE.md §6.16)', () => {
  it('loads a module line by line, once, and records it with a NAME.FTH marker', () => {
    const modules = new FakeModules({
      GREET: ': GREET-A 1 ;\r\n: GREET-B\n  GREET-A 41 + ;\n\\ a comment line\n',
    });
    const m = bootMachine({ moduleHal: modules });
    m.interpret('NEEDS greet GREET-B');
    expect(m.stack.toArray()).toEqual([42]); // and the rest of the line ran
    m.stack.clear();
    expect(modules.reads).toEqual(['GREET']);

    m.interpret('NEEDS GREET'); // already loaded: a no-op
    expect(modules.reads).toEqual(['GREET']);
    m.interpret("' GREET.FTH DROP"); // the marker word exists

    // The source text lives in a scratch bank that is never saved.
    const source = m.banks.getAllBanks().find((b) => b.tag === 'DATA' && b.flags & BankFlagRemoved);
    expect(source).toBeDefined();

    // EMPTY removes the marker with the words, so it loads again.
    m.interpret('EMPTY NEEDS GREET GREET-B');
    expect(m.stack.toArray()).toEqual([42]);
    expect(modules.reads).toEqual(['GREET', 'GREET']);
  });

  it('a module can load another module it needs', () => {
    const modules = new FakeModules({
      BASE1: ': ONE 1 ;',
      TOP: 'NEEDS BASE1\n: TWO ONE ONE + ;',
    });
    const m = bootMachine({ moduleHal: modules });
    m.interpret('NEEDS TOP TWO');
    expect(m.stack.toArray()).toEqual([2]);
    m.interpret("' TOP.FTH DROP ' BASE1.FTH DROP");
  });

  it('suspends while the host is still fetching, like KEY', () => {
    const modules = new FakeModules({ SLOW: ': SLOW-WORD 7 ;' });
    modules.pendingFor = 3;
    const m = bootMachine({ moduleHal: modules });
    m.beginLine('NEEDS SLOW SLOW-WORD');
    let status = '';
    let blocked = 0;
    for (let i = 0; i < 50 && status !== 'idle'; i++) {
      status = m.step(1_000_000);
      if (status === 'blocked') blocked++;
    }
    expect(blocked).toBe(3);
    expect(status).toBe('idle');
    expect(m.stack.toArray()).toEqual([7]);
  });

  it('a missing module or a bad name aborts, defining nothing', () => {
    const m = bootMachine({ moduleHal: new FakeModules({}) });
    m.interpret('CLS');
    expect(() => m.interpret('NEEDS NOPE')).toThrow();
    expect(screenText(m)).toContain('NOPE - no such module');
    expect(() => m.interpret("' NOPE.FTH")).toThrow();
    expect(() => m.interpret('NEEDS TOOLONGNAME')).toThrow();
  });
});

describe('LOAD-ASSET (M86, spec/04-FORTH-CORE.md §6.16)', () => {
  it('loads a project-asset file beside the modules into a bank named for its basename, tag from its header', () => {
    const m = bootMachine(); // NODE_MODULE_HAL: packages/app/public
    m.interpret('LOAD-ASSET ROGUE.SPR');
    const bank = m.banks.findBankByName('ROGUE')!;
    expect(bank.tag).toBe('SPRT');
    expect(String.fromCharCode(m.arena.readByte(bank.base), m.arena.readByte(bank.base + 1))).toBe('SP');
    expect(m.arena.readCell(bank.base + 4)).toBe(16); // entry count

    // Loading again reuses the bank, refreshing its contents.
    m.arena.writeByte(bank.base + 8, 0xee);
    m.interpret('LOAD-ASSET rogue.spr');
    expect(m.banks.getAllBanks().filter((b) => b.name === 'ROGUE')).toHaveLength(1);
    expect(m.arena.readByte(bank.base + 8)).not.toBe(0xee);
  });

  it('reports failure: (LOAD-ASSET) returns 0 and LOAD-ASSET aborts for a missing file or one that is not an asset', () => {
    const modules = new FakeModules({ 'NOTASSET.DAT': 'plain text' });
    const m = bootMachine({ moduleHal: modules });
    expect(() => m.interpret('LOAD-ASSET NOSUCH.SPR')).toThrow();
    expect(() => m.interpret('LOAD-ASSET NOTASSET.DAT')).toThrow();
    m.interpret('S" X" S" NOTASSET.DAT" (LOAD-ASSET)');
    expect(m.stack.toArray()).toEqual([0]);
    expect(m.banks.findBankByName('NOTASSET')).toBeUndefined();
  });
});
