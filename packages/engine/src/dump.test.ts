import { describe, expect, it } from 'vitest';
import { Machine } from './repl.js';
import { bootMachine } from './test-support.js';

describe('DUMP (system.fth, M51)', () => {
  function screenText(m: Machine): string {
    const rows: string[] = [];
    for (let r = 0; r < m.screen.rows; r++) {
      rows.push(m.screen.readRowText(r));
    }
    return rows.join('\n');
  }

  it('prints one row correctly: 8-digit hex address, 8 space-separated hex bytes, 8 ASCII chars', () => {
    const m = bootMachine();
    m.interpret('64 CREATE-BANK DUMPTST');
    const addr = m.stack.pop();
    const bytes = [0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48]; // "ABCDEFGH"
    for (let i = 0; i < bytes.length; i++) {
      m.arena.writeByte(addr + i, bytes[i]);
    }

    m.interpret(`${addr} DUMP`);
    const listed = screenText(m);

    const addrHex = addr.toString(16).toUpperCase().padStart(8, '0');
    expect(listed).toContain(`${addrHex} 41 42 43 44 45 46 47 48 ABCDEFGH`);
  });

  it('renders bytes below BL (32) as a dot, not the raw control code', () => {
    const m = bootMachine();
    m.interpret('64 CREATE-BANK DUMPTST2');
    const addr = m.stack.pop();
    for (let i = 0; i < 8; i++) {
      m.arena.writeByte(addr + i, 0); // a fresh bank's own zeroed content
    }

    m.interpret(`${addr} DUMP`);
    const listed = screenText(m);

    const addrHex = addr.toString(16).toUpperCase().padStart(8, '0');
    expect(listed).toContain(`${addrHex} 00 00 00 00 00 00 00 00 ........`);
  });

  it('dumps 16 rows of 8 bytes each, addresses advancing by 8 per row', () => {
    const m = bootMachine();
    m.interpret('128 CREATE-BANK DUMPTST3');
    const addr = m.stack.pop();

    m.interpret(`${addr} DUMP`);
    const listed = screenText(m);

    for (let row = 0; row < 16; row++) {
      const rowAddrHex = (addr + row * 8).toString(16).toUpperCase().padStart(8, '0');
      expect(listed).toContain(rowAddrHex);
    }
  });

  it('is stack-neutral: consumes exactly the address it was given', () => {
    const m = bootMachine();
    m.interpret('64 CREATE-BANK DUMPTST4');
    const addr = m.stack.pop();
    m.interpret('DEPTH');
    const depthBefore = m.stack.pop();

    m.interpret(`${addr} DUMP`);
    m.interpret('DEPTH');
    expect(m.stack.pop()).toBe(depthBefore);
  });
});

describe('DUMP-NEXT: address-less DUMP pages forward (system.fth, M61)', () => {
  function screenText(m: Machine): string {
    const rows: string[] = [];
    for (let r = 0; r < m.screen.rows; r++) {
      rows.push(m.screen.readRowText(r));
    }
    return rows.join('\n');
  }

  it('a bare DUMP with an empty stack starts at 0 the first time', () => {
    const m = bootMachine();
    m.interpret('DUMP');
    const listed = screenText(m);
    expect(listed).toContain('00000000');
  });

  it('an explicit-address DUMP advances DUMP-NEXT by 128, so a following bare DUMP continues right after it', () => {
    const m = bootMachine();
    m.interpret('256 CREATE-BANK DUMPTST5');
    const addr = m.stack.pop();

    m.interpret(`${addr} DUMP`);
    m.interpret('DUMP'); // bare — should pick up where the explicit one left off
    const listed = screenText(m);

    const nextAddrHex = (addr + 128).toString(16).toUpperCase().padStart(8, '0');
    expect(listed).toContain(nextAddrHex);
  });

  it('two consecutive bare DUMPs page forward 128 bytes at a time', () => {
    const m = bootMachine();
    m.interpret('0 DUMP-NEXT !');
    m.interpret('DUMP');
    m.interpret('DUMP');
    const listed = screenText(m);

    expect(listed).toContain('00000000');
    expect(listed).toContain('00000080'); // 128 in hex
  });

  it('DUMP-NEXT is an ordinary, pokeable variable — writing it changes where the next bare DUMP starts', () => {
    const m = bootMachine();
    m.interpret('64 CREATE-BANK DUMPTST6');
    const addr = m.stack.pop();

    m.interpret(`${addr} DUMP-NEXT !`);
    m.interpret('DUMP');
    const listed = screenText(m);

    const addrHex = addr.toString(16).toUpperCase().padStart(8, '0');
    expect(listed).toContain(addrHex);
  });

  it('is stack-neutral in address-less form too, consuming nothing', () => {
    const m = bootMachine();
    m.interpret('DEPTH');
    const depthBefore = m.stack.pop();

    m.interpret('DUMP');
    m.interpret('DEPTH');
    expect(m.stack.pop()).toBe(depthBefore);
  });
});
