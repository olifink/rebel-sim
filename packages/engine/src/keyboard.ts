/**
 * The keyboard module: raw HID-style events in, a translated non-blocking
 * queue out (docs/KEYBOARD.md, PORTING-WEB.md §4). Mirrors
 * CKeyboardModule as closely as a browser host allows:
 *
 * - The host (packages/app) is responsible for turning DOM `keydown`/
 *   `keyup` into raw USB HID usage codes (the engine has zero DOM
 *   dependencies, same rule as screen.ts) and calling pushRawEvent() —
 *   the equivalent of CKeyboardModule::OnRawReport's per-key diffing,
 *   except the host doesn't need to diff a polled report itself: DOM
 *   keydown/keyup already are press/release edges (modulo auto-repeat,
 *   which the host filters via KeyboardEvent.repeat before calling in).
 * - Modifier press/release is folded into the same event stream as
 *   ordinary keys via the 0x80+bit pseudo-usage-code convention
 *   (docs/KEYBOARD.md §10), exactly matching Rebel-ROM.
 * - The KMAP bank holds a plain u8[2][256] table (unshifted/shifted
 *   planes) — only printable keys plus Enter/Backspace/Tab/Space/Escape
 *   get a translated char; everything else (Caps Lock, F-keys,
 *   PrintScreen, arrows, GUI) is left at 0, identified only via usageCode
 *   (docs/KEYBOARD.md §4's "identification now, behavior later").
 * - The event queue itself is a plain ring buffer, not arena/bank memory
 *   (same category as SCRN: host/module-owned, excluded from the
 *   portable-dump claim) — full queue drops the new event rather than
 *   overwriting or blocking, matching CKeyboardModule::PushEvent exactly.
 */

import { Arena } from './arena.js';
import { Bank } from './banks.js';
import { Sysvars } from './sysvars.js';

export const KEYBOARD_QUEUE_SIZE = 32;
export const KMAP_TABLE_SIZE = 512; // u8[2][256]: plane 0 unshifted, plane 1 shifted

const MOD_LSHIFT = 0x02;
const MOD_RSHIFT = 0x20;

export interface KeyEvent {
  readonly usageCode: number;
  readonly modifiers: number;
  readonly char: number; // 0 if this key has no translated character
  readonly pressed: boolean;
}

export class Keyboard {
  private readonly queue: KeyEvent[] = new Array(KEYBOARD_QUEUE_SIZE);
  private head = 0;
  private tail = 0;

  constructor(
    private readonly arena: Arena,
    private readonly sysvars: Sysvars,
    private readonly kmapBank: Bank,
  ) {
    this.buildDefaultKeymap();
    this.sysvars.setUnsigned('KEYBOARD', 'MODIFIERS', 0);
  }

  private kmapAddress(plane: 0 | 1, usageCode: number): number {
    return this.kmapBank.base + plane * 256 + usageCode;
  }

  /** US layout, printable keys + Enter/Backspace/Tab/Space (docs/
   * KEYBOARD.md §5), byte-for-byte matching CKeyboardModule::
   * BuildDefaultKeymap -- plus Escape (M57), a Rebel-Sim-side addition
   * TS needed as its own cancel key that rebel-rom's own keymap doesn't
   * have yet (not present in this checkout to confirm either way); worth
   * reconciling once a C++ Forth executor's own screen editor needs the
   * same thing, rather than something to treat as settled parity now. */
  private buildDefaultKeymap(): void {
    for (let i = 0; i < KMAP_TABLE_SIZE; i++) {
      this.arena.writeByte(this.kmapBank.base + i, 0);
    }

    const setBoth = (code: number, ch: string): void => {
      this.arena.writeByte(this.kmapAddress(0, code), ch.charCodeAt(0));
      this.arena.writeByte(this.kmapAddress(1, code), ch.charCodeAt(0));
    };
    const setPlane = (plane: 0 | 1, code: number, ch: string): void => {
      this.arena.writeByte(this.kmapAddress(plane, code), ch.charCodeAt(0));
    };

    // a-z: usage 0x04-0x1D
    for (let code = 0x04; code <= 0x1d; code++) {
      setPlane(0, code, String.fromCharCode('a'.charCodeAt(0) + (code - 0x04)));
      setPlane(1, code, String.fromCharCode('A'.charCodeAt(0) + (code - 0x04)));
    }

    // 1-9,0: usage 0x1E-0x27, shifted row is the standard US symbol row
    const digits = '1234567890';
    const symbols = '!@#$%^&*()';
    for (let i = 0; i < 10; i++) {
      setPlane(0, 0x1e + i, digits[i]);
      setPlane(1, 0x1e + i, symbols[i]);
    }

    const punct: Array<[number, string, string]> = [
      [0x2d, '-', '_'],
      [0x2e, '=', '+'],
      [0x2f, '[', '{'],
      [0x30, ']', '}'],
      [0x31, '\\', '|'],
      [0x33, ';', ':'],
      [0x34, "'", '"'],
      [0x35, '`', '~'],
      [0x36, ',', '<'],
      [0x37, '.', '>'],
      [0x38, '/', '?'],
    ];
    for (const [code, un, sh] of punct) {
      setPlane(0, code, un);
      setPlane(1, code, sh);
    }

    // Enter maps to '\n' — Screen.emit() treats '\n' as cursor-to-next-row,
    // exactly what pressing Enter should do.
    setBoth(0x28, '\n');
    setBoth(0x2a, '\b'); // Backspace
    setBoth(0x2b, '\t'); // Tab — identification only for now
    setBoth(0x2c, ' '); // Space
    setBoth(0x29, '\x1b'); // Escape — M57: TS's own cancel key, found needed
    // once TS actually tried to read it via KEY; previously unmapped like
    // every other non-printable key, so KEY/KEY? could never see it.
  }

  private readKmapByte(plane: 0 | 1, usageCode: number): number {
    if (usageCode < 0 || usageCode > 0xff) {
      return 0;
    }
    return this.arena.readByte(this.kmapAddress(plane, usageCode));
  }

  getModifiers(): number {
    return this.sysvars.getUnsigned('KEYBOARD', 'MODIFIERS');
  }

  /** Pushes one raw press/release edge. usageCode 0x80-0x87 is the
   * modifier pseudo-code convention (bit = usageCode - 0x80); anything
   * else is an ordinary key, translated through the KMAP's current
   * shift plane on press (docs/KEYBOARD.md §10, CKeyboardModule::
   * PushEvent). */
  pushRawEvent(usageCode: number, pressed: boolean): void {
    let modifiers = this.getModifiers();
    if (usageCode >= 0x80 && usageCode <= 0x87) {
      const mask = 1 << (usageCode - 0x80);
      modifiers = pressed ? modifiers | mask : modifiers & ~mask;
      this.sysvars.setUnsigned('KEYBOARD', 'MODIFIERS', modifiers);
    }
    this.enqueue(usageCode, modifiers, pressed);
  }

  private enqueue(usageCode: number, modifiers: number, pressed: boolean): void {
    const next = (this.head + 1) % KEYBOARD_QUEUE_SIZE;
    if (next === this.tail) {
      // Full — drop rather than overwrite an unconsumed event or block
      // (matches CKeyboardModule::PushEvent's interrupt-context caution;
      // Rebel-Sim has no such constraint, but the same drop policy keeps
      // behavior identical to the reference).
      return;
    }
    const shifted = (modifiers & (MOD_LSHIFT | MOD_RSHIFT)) !== 0;
    const char = pressed ? this.readKmapByte(shifted ? 1 : 0, usageCode) : 0;
    this.queue[this.head] = { usageCode, modifiers, char, pressed };
    this.head = next;
  }

  /** KEY? — non-blocking, does not consume. */
  hasEvent(): boolean {
    return this.head !== this.tail;
  }

  /** Non-blocking pop of the oldest queued event (CKeyboardModule::
   * ReadEvent). Returns undefined if the queue is empty. */
  readEvent(): KeyEvent | undefined {
    if (this.tail === this.head) {
      return undefined;
    }
    const event = this.queue[this.tail];
    this.tail = (this.tail + 1) % KEYBOARD_QUEUE_SIZE;
    return event;
  }

  /** M7/channel.ts support: non-destructively checks whether the queue
   * holds an event with a real translated character, skipping past any
   * with char 0 (modifier presses, unmapped special keys) — the filter
   * `KeyboardChannel`/`CHANNELS-DESIGN.md` §3 describes ("an unmapped key
   * has no byte-stream representation and stays invisible to Channel").
   * `KEY?` (primitives.ts) deliberately does NOT use this — it reports on
   * the raw queue, unfiltered, unchanged since M4. */
  hasTranslatedEvent(): boolean {
    for (let i = this.tail; i !== this.head; i = (i + 1) % KEYBOARD_QUEUE_SIZE) {
      if (this.queue[i].char !== 0) {
        return true;
      }
    }
    return false;
  }

  /** Pops and discards events until (and including) the next one with a
   * non-zero translated char; returns that char, or undefined once the
   * queue is exhausted without finding one. Shares the same physical
   * queue `readEvent()`/`hasEvent()` use — draining via one is visible to
   * the other, exactly as there being only one real hardware queue would
   * imply. */
  readTranslatedChar(): number | undefined {
    let event = this.readEvent();
    while (event !== undefined) {
      if (event.char !== 0) {
        return event.char;
      }
      event = this.readEvent();
    }
    return undefined;
  }
}
