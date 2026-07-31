/**
 * The Channel abstraction (FORTH-ARCHITECTURE.md §7a, CHANNELS-DESIGN.md):
 * what the outer loop's blocking `KEY` binds to, rather than calling a
 * specific input source directly. Deliberately **input-only** — `EMIT`/
 * `TYPE` keep calling `screen.emit()` directly, unchanged since M3
 * (CHANNELS-DESIGN.md §8's reconciliation: screen is a shared HAL surface,
 * never channel-shaped).
 *
 * This is what buys a future `RemoteChannel` (M8, WebMCP) zero
 * interpreter changes: `inner.ts` only ever asks a `Channel` for
 * `hasData()`/`readByte()`, never `Keyboard` by name.
 */

import { Keyboard } from './keyboard.js';

export interface Channel {
  /** Non-blocking poll — is a byte available right now? */
  hasData(): boolean;
  /** Non-blocking pop. -1 if none ready (mirrors the engine's TRUE/FALSE
   * convention of using a plain integer sentinel rather than a second
   * return channel). Callers that need real blocking (inner.ts's
   * generator-based step loop) check `hasData()` first and suspend
   * rather than ever seeing -1 in practice. */
  readByte(): number;
}

/** Wraps the M4 `Keyboard` class's queue, filtered to translated-char
 * events only (docs/KEYBOARD.md §4's "identification now, behavior
 * later" — an unmapped key has no byte-stream representation here,
 * exactly as it already doesn't for `KEY`/`KEY?`, primitives.ts). No new
 * debounce/edge logic — `Keyboard.pushRawEvent` already only receives
 * clean DOM keydown/keyup edges (CHANNELS-DESIGN.md §8). */
export class KeyboardChannel implements Channel {
  constructor(private readonly keyboard: Keyboard) {}

  hasData(): boolean {
    return this.keyboard.hasTranslatedEvent();
  }

  readByte(): number {
    const char = this.keyboard.readTranslatedChar();
    return char ?? -1;
  }
}

/** M9: plain FIFO of chars, fed by push() from outside the engine (a
 * WebMCP tool's execute() handler, packages/app). Unlike Keyboard's
 * ring buffer, no capacity cap — that 32-slot cap models real HID
 * hardware; programmatic remote input has no such constraint to
 * honor. */
export class RemoteChannel implements Channel {
  private readonly queue: number[] = [];

  push(text: string): void {
    for (const ch of text) {
      this.queue.push(ch.charCodeAt(0));
    }
  }

  hasData(): boolean {
    return this.queue.length > 0;
  }

  readByte(): number {
    return this.queue.length ? this.queue.shift()! : -1;
  }
}

/** M9: merges N input channels into one — first-ready-wins, scanned in
 * argument order each call. Lets keyboard and remote (WebMCP) input
 * feed the same REPL session with zero interpreter-level change; only
 * this host-side binding decides which sources exist. */
export class CompositeChannel implements Channel {
  constructor(private readonly channels: readonly Channel[]) {}

  hasData(): boolean {
    return this.channels.some((c) => c.hasData());
  }

  readByte(): number {
    const ready = this.channels.find((c) => c.hasData());
    return ready ? ready.readByte() : -1;
  }
}
