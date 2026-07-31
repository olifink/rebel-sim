import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { Sysvars } from './sysvars.js';
import { Keyboard } from './keyboard.js';
import { KeyboardChannel } from './channel.js';

function makeKeyboardChannel() {
  const arena = new Arena(1 << 16);
  const banks = new BankTable(arena);
  const sysvBank = banks.createBank('SYSV', 4096);
  const sysvars = new Sysvars(arena, sysvBank);
  sysvars.initHeader();
  const kmapBank = banks.createBank('KMAP', 4096);
  const keyboard = new Keyboard(arena, sysvars, kmapBank);
  return { keyboard, channel: new KeyboardChannel(keyboard) };
}

describe('KeyboardChannel', () => {
  it('has no data on an empty queue', () => {
    const { channel } = makeKeyboardChannel();
    expect(channel.hasData()).toBe(false);
    expect(channel.readByte()).toBe(-1);
  });

  it('surfaces a printable key press as its translated character', () => {
    const { keyboard, channel } = makeKeyboardChannel();
    keyboard.pushRawEvent(0x04, true); // 'a'
    expect(channel.hasData()).toBe(true);
    expect(channel.readByte()).toBe('a'.charCodeAt(0));
  });

  it('skips over char-0 events (modifier presses, unmapped keys) transparently', () => {
    const { keyboard, channel } = makeKeyboardChannel();
    keyboard.pushRawEvent(0x39, true); // Caps Lock press — identified only, char 0
    keyboard.pushRawEvent(0x39, false); // Caps Lock release — also char 0
    keyboard.pushRawEvent(0x04, false); // release of 'a' — char 0
    keyboard.pushRawEvent(0x05, true); // 'b' — the first real one
    expect(channel.hasData()).toBe(true);
    expect(channel.readByte()).toBe('b'.charCodeAt(0));
  });

  it('hasData() does not consume the event readByte() later returns', () => {
    const { keyboard, channel } = makeKeyboardChannel();
    keyboard.pushRawEvent(0x06, true); // 'c'
    expect(channel.hasData()).toBe(true);
    expect(channel.hasData()).toBe(true); // still there
    expect(channel.readByte()).toBe('c'.charCodeAt(0));
  });

  it('reports no data when only char-0 events are queued', () => {
    const { keyboard, channel } = makeKeyboardChannel();
    keyboard.pushRawEvent(0x39, true); // Caps Lock
    keyboard.pushRawEvent(0x39, false);
    expect(channel.hasData()).toBe(false);
    expect(channel.readByte()).toBe(-1);
  });

  it('shares the underlying queue with Keyboard.hasEvent()/readEvent() — draining via one is visible to the other', () => {
    const { keyboard, channel } = makeKeyboardChannel();
    keyboard.pushRawEvent(0x39, true); // Caps Lock, char 0
    keyboard.pushRawEvent(0x07, true); // 'd'
    expect(keyboard.hasEvent()).toBe(true); // raw queue sees the Caps Lock event
    channel.readByte(); // drains both the Caps Lock event and 'd'
    expect(keyboard.hasEvent()).toBe(false); // queue now empty from the raw side too
  });
});
