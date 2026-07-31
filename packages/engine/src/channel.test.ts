import { describe, expect, it } from 'vitest';
import { Arena } from './arena.js';
import { BankTable } from './banks.js';
import { Sysvars } from './sysvars.js';
import { Keyboard } from './keyboard.js';
import { Channel, CompositeChannel, KeyboardChannel, RemoteChannel } from './channel.js';

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

describe('RemoteChannel', () => {
  it('has no data on an empty queue', () => {
    const channel = new RemoteChannel();
    expect(channel.hasData()).toBe(false);
    expect(channel.readByte()).toBe(-1);
  });

  it('queues pushed text as chars, FIFO order', () => {
    const channel = new RemoteChannel();
    channel.push('AB');
    expect(channel.hasData()).toBe(true);
    expect(channel.readByte()).toBe('A'.charCodeAt(0));
    expect(channel.readByte()).toBe('B'.charCodeAt(0));
    expect(channel.hasData()).toBe(false);
  });

  it('accumulates across multiple push() calls', () => {
    const channel = new RemoteChannel();
    channel.push('A');
    channel.push('B');
    expect(channel.readByte()).toBe('A'.charCodeAt(0));
    expect(channel.readByte()).toBe('B'.charCodeAt(0));
  });
});

describe('CompositeChannel', () => {
  it('has no data when no sub-channel has data', () => {
    const composite = new CompositeChannel([new RemoteChannel(), new RemoteChannel()]);
    expect(composite.hasData()).toBe(false);
    expect(composite.readByte()).toBe(-1);
  });

  it('reads from whichever sub-channel is ready first, in argument order', () => {
    const first = new RemoteChannel();
    const second = new RemoteChannel();
    second.push('X');
    const composite = new CompositeChannel([first, second]);
    expect(composite.hasData()).toBe(true);
    expect(composite.readByte()).toBe('X'.charCodeAt(0)); // only `second` has data

    first.push('Y');
    second.push('Z');
    expect(composite.readByte()).toBe('Y'.charCodeAt(0)); // `first` now wins (argument order)
    expect(composite.readByte()).toBe('Z'.charCodeAt(0));
  });

  it('preserves each source\'s own internal order', () => {
    const remote = new RemoteChannel();
    remote.push('12');
    const composite = new CompositeChannel([remote]);
    expect(composite.readByte()).toBe('1'.charCodeAt(0));
    expect(composite.readByte()).toBe('2'.charCodeAt(0));
  });

  it('works with a mix of KeyboardChannel and RemoteChannel', () => {
    const { keyboard, channel: keyboardChannel } = makeKeyboardChannel();
    const remote = new RemoteChannel();
    const composite: Channel = new CompositeChannel([keyboardChannel, remote]);

    remote.push('r');
    expect(composite.readByte()).toBe('r'.charCodeAt(0));

    keyboard.pushRawEvent(0x04, true); // 'a'
    expect(composite.readByte()).toBe('a'.charCodeAt(0));
  });
});
