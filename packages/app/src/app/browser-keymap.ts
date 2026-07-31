/**
 * DOM `KeyboardEvent.code` -> raw USB HID usage code (docs/KEYBOARD.md
 * §2/§4, src/keyboardmodule.h). This is the browser-host driver layer
 * CKeyboardModule's raw USB report parsing plays on real hardware — the
 * engine's Keyboard class only ever sees usage codes, never DOM event
 * shapes (PORTING-WEB.md §4: "never bind a hidden <input>... feed raw
 * events into a non-blocking ring buffer").
 *
 * Modifier keys map directly to the 0x80+bit pseudo-usage-codes
 * Keyboard.pushRawEvent() expects (docs/KEYBOARD.md §10's convention) —
 * there's no separate raw-HID-then-remap step needed since the browser
 * already reports each physical modifier key as its own discrete
 * keydown/keyup, unlike the USB boot-protocol modifier bitmask real
 * hardware reports.
 */

const CODE_TO_USAGE: Readonly<Record<string, number>> = {
  KeyA: 0x04, KeyB: 0x05, KeyC: 0x06, KeyD: 0x07, KeyE: 0x08, KeyF: 0x09,
  KeyG: 0x0a, KeyH: 0x0b, KeyI: 0x0c, KeyJ: 0x0d, KeyK: 0x0e, KeyL: 0x0f,
  KeyM: 0x10, KeyN: 0x11, KeyO: 0x12, KeyP: 0x13, KeyQ: 0x14, KeyR: 0x15,
  KeyS: 0x16, KeyT: 0x17, KeyU: 0x18, KeyV: 0x19, KeyW: 0x1a, KeyX: 0x1b,
  KeyY: 0x1c, KeyZ: 0x1d,

  Digit1: 0x1e, Digit2: 0x1f, Digit3: 0x20, Digit4: 0x21, Digit5: 0x22,
  Digit6: 0x23, Digit7: 0x24, Digit8: 0x25, Digit9: 0x26, Digit0: 0x27,

  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30,
  Backslash: 0x31, Semicolon: 0x33, Quote: 0x34, Backquote: 0x35,
  Comma: 0x36, Period: 0x37, Slash: 0x38,

  CapsLock: 0x39,
  F1: 0x3a, F2: 0x3b, F3: 0x3c, F4: 0x3d, F5: 0x3e, F6: 0x3f,
  F7: 0x40, F8: 0x41, F9: 0x42, F10: 0x43, F11: 0x44, F12: 0x45,
  PrintScreen: 0x46,

  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,

  // Modifiers — pseudo-usage-codes (0x80 + bit), matching
  // docs/KEYBOARD.md §2's bit layout directly rather than real hardware's
  // raw 0xE0-0xE7 HID usage codes for these keys.
  ControlLeft: 0x80, ShiftLeft: 0x81, AltLeft: 0x82, MetaLeft: 0x83,
  ControlRight: 0x84, ShiftRight: 0x85, AltRight: 0x86, MetaRight: 0x87,
};

export function codeToUsage(code: string): number | undefined {
  return CODE_TO_USAGE[code];
}
