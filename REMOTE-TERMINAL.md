# REMOTE-TERMINAL.md — Rebel-Sim as a USB-serial terminal for real RP2350 hardware

## 0. What this document is (and isn't)

**Status: design-only. Nothing described here is implemented on either
side.** This is a wire-protocol and architecture spec for a feature that
doesn't exist yet in Rebel-Sim, written to be precise enough to build
against later — on this side, and on a separate, not-yet-started RP2350
firmware project.

**The scenario:** porting Rebel's Forth engine to real RP2350 hardware
means, at some point, running with only the bare module attached — no
HSTX display, no keyboard, e.g. while travelling. This document specs a
way for Rebel-Sim (the browser app) to connect to that board over USB
serial and act as a **remote terminal**: the board runs its own Forth
interpreter and its own HAL calls, but instead of driving real display/
keyboard hardware, its screen HAL calls get forwarded over the wire to
Rebel-Sim, which renders them on its existing canvas, and Rebel-Sim
forwards real keyboard input back to the board. Rebel-Sim's own local
interpreter (`Machine`/`step()`) is not involved in this mode at all —
the board is running the program; Sim is the terminal.

**Read this against `CHANNELS-DESIGN.md` — related prior art, not
reused.** That document's `Channel`/`SerialChannel`/`RemoteChannel`
sketch (Rebel-ROM-scoped) is **input-only**: it feeds a remote byte
stream into an interpreter running *locally* on the same machine as the
channel. `spec/01-HAL.md` §5 and `FORTH-ARCHITECTURE.md` §7a's `Channel`
abstraction (Rebel-Sim's own, already implemented — `packages/engine/src/
channel.ts`) is the same shape: also input-only, also feeding a locally
running interpreter. This document is the **reverse relationship**: the
interpreter runs on the far end of the wire, and *both* directions —
screen output flowing out, keyboard input flowing back — cross the
serial link. Nothing existing in this codebase does that; this is new
design surface, not an extension of `Channel`.

**Explicitly out of scope for this repo, this document:** the RP2350
firmware implementation. That is a separate, new project — not built on
`rebel-rom` (the existing Pi 400/500 Circle/Arm target), which has no
RP2350 support and isn't being used as a basis here. §8 gives that future
project a self-contained contract; it does not design its internals.

---

## 1. Motivation and shape of the problem

Rebel-Sim already renders Forth's screen output through a small,
arena-decoupled HAL interface (`ScreenHal`, `packages/engine/src/
screen.ts:20-26`) with exactly two calls: `blitGlyph(col, row, charCode,
ink, paper)` and `clearScreen(paper)`. Every visible thing the *local*
interpreter draws — text, cursor, `CLS` — goes through those two calls
and nothing else; there is no separate framebuffer/pixel HAL implemented
anywhere in this codebase yet (`spec/01-HAL.md` §3.4's optional raw-pixel
functions are unimplemented on every target).

That gives this design its central choice: **forward at the char-cell
HAL level, not raw pixels.** Concretely, this means:

- The wire protocol mirrors `blitGlyph`/`clearScreen` almost exactly —
  one wire message per HAL call, same parameters.
- Font rendering stays entirely local to Rebel-Sim, using its existing
  compiled-in 8×8/256-char glyph table — the board never sends pixel
  data, only character codes.
- No new HAL surface has to be invented on either side to get a working
  v1: the board's own screen HAL calls (whatever they're named in the new
  firmware) map directly onto this protocol's messages, because they're
  the same two operations Rebel-Sim already implements.
- Indexed-color resolution (`spec/01-HAL.md` §3.6's `PAL`/`ATTR`
  mechanism — **REQUIRED** for every display-capable target, including
  this one, as of that spec's own M62-follow-up-4 update) stays entirely
  on the board's side of the wire. The color-resolution rule already
  keeps palette lookup *above* the HAL boundary, so `PLOT_CHAR`/`CLEAR`'s
  `ink`/`paper` fields (§4) are, and always were, the same post-
  resolution `0xRRGGBB` values `blitGlyph`/`clearScreen` receive locally
  — never a raw `INK`/`PAPER` index. A board with an active palette just
  resolves before framing a message, exactly like Rebel-Sim's own local
  `Screen.writeChar()` does; this protocol carries no separate
  index-carrying message and needs no version bump for it.
- Bandwidth stays tiny — a handful of bytes per changed cell, not a
  framebuffer's worth of pixels per frame — which matters over a serial
  link.

The tradeoff, named plainly rather than glossed over: this protocol
**cannot show raw graphics** (sprites, lines, filled rects below
char-cell granularity) until a raw-pixel HAL surface exists on both sides
— today it doesn't, on either. That's a real limitation, and it's a
deliberate one: building the pixel-level version now would mean designing
a HAL surface neither side has, in a spec nobody's implemented against
yet. §10 names it as a future extension rather than pretending it's
solved here.

---

## 2. Transport: WebSerial ↔ USB CDC ACM

Rebel-Sim connects to the board using the browser's [WebSerial
API](https://wicg.github.io/serial/) (`navigator.serial`), currently
Chrome/Chromium-only. The RP2350 side exposes a standard USB CDC ACM
serial device (a USB "virtual COM port") — the same class of device
`rebel-rom`'s existing `CSerialDevice` UART logging already resembles at
the concept level, though that code is Pi-GPIO-UART, not USB-CDC, and
isn't reused here.

Scope, stated explicitly: **one board, one connection, one session.**
WebSerial's own port picker (`navigator.serial.requestPort()`) is the
only device-selection UI; this document does not design anything beyond
it (no saved-device list, no auto-reconnect scanning — see §10).

---

## 3. Framing

**Binary, not text.** This matches the project's existing byte-oriented
conventions (32-bit cells, numeric primitive token IDs rather than word
names on the wire, `rebel-opcodes.json` as the numeric source of truth)
and the fact that `PLOT_CHAR` (§4) fires once per character write — a
real hot path, not an occasional control message, once a program is
producing normal text output.

The counter-argument is real and worth stating rather than silently
dismissing: a text-based protocol would be far easier to eyeball with a
plain terminal emulator while bringing up the new RP2350 firmware from
scratch. That's a genuine debugging convenience. It is not, however, a
protocol requirement — the documented answer is that firmware bring-up
uses a **second, separate debug UART** for human-readable logging (as
`rebel-rom`'s existing serial logging already does), leaving this
protocol free to stay binary and compact. If bring-up pain turns out to
be worse than expected in practice, that's a tooling problem to solve
with a debug log, not a reason to redesign this wire format.

### Frame layout

```
byte 0            SYNC        0xA5              fixed; never a valid MSG_ID
byte 1            MSG_ID      u8                see §4
byte 2            LEN         u8                payload length, 0-255
byte 3..3+LEN-1   PAYLOAD     LEN bytes          see §4 per message
byte 3+LEN        CHECKSUM    u8                (MSG_ID + LEN + Σ payload) mod 256
```

Per-frame overhead: 4 bytes (sync + id + len + checksum).

**Byte order:** every multi-byte payload field is **little-endian** —
the same rule `FORTH-ARCHITECTURE.md` fixes for every Forth cell on every
target (`readCell`/`writeCell` with `littleEndian: true`). This protocol
doesn't get to be the one exception.

**Booleans:** the project's HAL convention is `TRUE = -1` (all bits
set), `FALSE = 0` — not C-style `1`/`0` (`FORTH-ARCHITECTURE.md` §7).
Every boolean-carrying field in this protocol is a `u8`; applying the
same "all bits set" convention at that width: **`0xFF` = TRUE, `0x00` =
FALSE.** This is the byte-width-scaled version of the existing rule, not
a new convention invented for this document.

**Checksum, not CRC — deliberately.** USB already provides link-layer
integrity checking underneath CDC ACM; this checksum's only job is
catching *local* framing/resync bugs in brand-new, unproven firmware —
not acting as forward error correction over an unreliable link. Per this
project's stated scope-calibration philosophy (build the minimum real
mechanism, revisit once a concrete need shows up), a stronger check
(CRC8/16) is something to add only if real corruption is actually
observed, not something to pre-build.

---

## 4. Message catalog

| ID | Name | Direction | Payload | Mirrors |
|------|------------|-------------|-----|--------------------------------|
| 0x01 | `HELLO` | board → sim | 7 B | connection handshake |
| 0x02 | `HELLO_ACK` | sim → board | 5 B | handshake response |
| 0x03 | `PLOT_CHAR` | board → sim | 13 B | `ScreenHal.blitGlyph` |
| 0x04 | `CLEAR` | board → sim | 4 B | `ScreenHal.clearScreen` |
| 0x05 | `CURSOR` | board → sim | 5 B | cursor bandwidth optimization |
| 0x06 | `KEY_EVENT` | sim → board | 2 B | `Keyboard.pushRawEvent` |

`0x00` is permanently reserved/invalid (never a real `MSG_ID`), so a
frame reader that stumbles onto a zero byte where it expected an ID can
recognize it as definitely-not-a-frame without waiting on the checksum.

All multi-byte fields little-endian (§3).

### `HELLO` (board → sim, sent first, always)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `protocolVersion` | u8 | `1` for this spec |
| 1 | `charCols` | u16 | board's actual character-grid width |
| 3 | `charRows` | u16 | board's actual character-grid height |
| 5 | `charCellW` | u8 | must be `8` (§5) |
| 6 | `charCellH` | u8 | must be `8` (§5) |

### `HELLO_ACK` (sim → board)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `status` | u8 | `0`=OK, `1`=VERSION_MISMATCH, `2`=UNSUPPORTED_CELL_SIZE |
| 1 | `negotiatedCols` | u16 | grid width Sim will actually render (clamped if needed) |
| 3 | `negotiatedRows` | u16 | grid height Sim will actually render |

### `PLOT_CHAR` (board → sim, one per screen-HAL char write)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `col` | u16 | |
| 2 | `row` | u16 | |
| 4 | `charCode` | u8 | 0x00–0xFF, indexes the same 256-glyph font Sim already has |
| 5 | `ink` | u32 | `0xRRGGBB`, matches `ScreenHal.blitGlyph`'s `ink` exactly |
| 9 | `paper` | u32 | `0xRRGGBB`, matches `blitGlyph`'s `paper` |

`ink`/`paper` as `0xRRGGBB` is confirmed directly against
`packages/app/src/app/canvas-screen-hal.ts`'s `toCssColor()`, which masks
the incoming HAL color to `& 0xffffff` and formats it as a CSS hex color
— the wire format needs no repacking on Sim's rendering side.

### `CLEAR` (board → sim, one per screen-HAL clear)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `paper` | u32 | `0xRRGGBB`, matches `ScreenHal.clearScreen`'s `paper` |

### `CURSOR` (board → sim, optional bandwidth optimization)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `col` | u16 | |
| 2 | `row` | u16 | |
| 4 | `visible` | u8 | `0xFF`/`0x00` |

**Why this exists even though `ScreenHal` has no dedicated cursor call.**
Confirmed directly in `screen.ts`: cursor visibility is expressed
*entirely* through ordinary `blitGlyph` calls with ink/paper swapped
(`redrawCursorAt()`, `screen.ts:101-109`) — there's no separate cursor
primitive at the HAL boundary today, on any target. `CURSOR` is a wire-
level shortcut a board *may* use instead of two full `PLOT_CHAR` frames
per cursor blink/move (un-invert the previous cell, invert the new one).
It's only usable because Sim's remote-mode renderer keeps a local shadow
of `{charCode, ink, paper}` per cell anyway (§7) and can locally re-invert
whatever's already shadowed, without the board resending glyph data. A
board is free to never send `CURSOR` and only ever use `PLOT_CHAR` — both
are valid; `CURSOR` just saves bytes for a blinking cursor specifically.

### `KEY_EVENT` (sim → board, one per real keypress/release)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `usageCode` | u8 | raw USB-HID usage code |
| 1 | `pressed` | u8 | `0xFF`/`0x00` |

`usageCode` includes the same `0x80`–`0x87` modifier pseudo-code
convention `packages/engine/src/keyboard.ts` already uses
(`pushRawEvent()`, `keyboard.ts:146-159`: bit = `usageCode - 0x80`) — no
new convention invented for the wire, and no translation needed on
either end, since `pushRawEvent`'s existing signature *is* the shape a
real hardware keyboard driver would already produce.

---

## 5. Handshake and geometry negotiation

**The board reports its real grid size; Sim adapts to it.** `HELLO`
carries the board's actual `charCols`/`charRows`, and Sim resizes its
canvas to match rather than assuming its own local defaults. This
matters because Rebel-Sim's own screen geometry constants are already
confirmed **hand-duplicated** in two places — `packages/engine/src/
repl.ts:123-126` (`DEFAULT_SCREEN_WIDTH/HEIGHT = 640/480`,
`DEFAULT_CHAR_CELL_W/H = 8` → an 80×60 grid) and `packages/app/src/app/
app.ts:26-27` (`FRAMEBUFFER_WIDTH/HEIGHT`), kept in sync only by a
comment telling a future editor to update both by hand. Hardcoding a
*third*, wire-protocol-level assumption that the remote board always
matches those same numbers would repeat exactly that fragility on a link
where it's cheapest to just ask. Negotiating cols/rows costs nothing more
than resizing a canvas.

**Char-cell pixel size (8×8) is fixed for v1, not negotiated.** This is
the one place the negotiation deliberately stops, because it collides
with §1's fixed constraint: font rendering stays local to Sim, using its
own compiled-in 8×8/256-char glyph table (`canvas-screen-hal.ts`'s
`FONT_WIDTH`/`FONT_HEIGHT` constants). A board reporting a different cell
size has no glyph source Sim can render against — there is no font-
transfer or glyph-scaling mechanism designed here. `HELLO_ACK` status `2`
(`UNSUPPORTED_CELL_SIZE`) exists specifically so that mismatch fails
cleanly and visibly rather than silently misrendering. Widening this
later (either negotiable cell size, or transferring a font over the wire)
is named in §10, not solved here.

`HELLO_ACK.negotiatedCols/negotiatedRows` lets Sim clamp to whatever
maximum grid size it's actually willing to render and tell the board what
was actually accepted — a plain clamp-and-report, not a multi-round
renegotiation protocol.

---

## 6. Error handling and resync

**No per-message ACK or retransmit**, deliberately — designing real flow
control before there's a concrete need for it would be exactly the kind
of pre-built extensibility this project's stated scope discipline warns
against.

**On checksum mismatch:** discard the frame without acting on its
payload, and return to scanning the byte stream for the next `0xA5`.
This is safe specifically because screen state here is self-correcting
— the same property `screen.ts`'s `redrawAll()` already leans on locally
("CHAR content is always enough to redraw correctly"): the next
`PLOT_CHAR` touching a given cell fixes whatever was lost, and any
full-screen `CLEAR` naturally resyncs everything visible. A dropped or
corrupted frame degrades to "a stale character was on screen briefly,"
never to permanently wrong state.

**Resync algorithm:** scan forward for a `0xA5` byte; at a candidate,
read the following `MSG_ID`/`LEN` and trust it as a real frame boundary
only once the trailing checksum actually validates. A false-positive
`0xA5` occurring inside garbage bytes just fails its checksum check, and
scanning resumes from the very next byte (not from the next apparent
sync byte) — so a bad match can never cause the reader to get stuck. In
normal, correctly-synced operation the reader never needs to scan at all
— it already knows `LEN` from a valid header and consumes exactly that
many payload bytes — so an `0xA5` value occurring naturally inside a
valid payload (e.g. as one byte of an `ink` color) is never misread as a
new frame start.

**No heartbeat/keepalive.** WebSerial already surfaces a real,
always-present unplug signal (the `SerialPort` `disconnect` event, and
`read()`/`write()` promise rejection on the underlying streams) — a
wire-level heartbeat would duplicate that for no benefit, so it's
explicitly not designed here.

**Unplug/reconnect:** on WebSerial `disconnect`, Sim tears down the
remote session entirely (stops rendering, requires an explicit
user-initiated reconnect via `requestPort()` again — no silent
background reconnect polling; see §10). On any fresh connect, Sim always
starts in a "waiting for `HELLO`" state and renders nothing until a valid
`HELLO`/`HELLO_ACK` exchange completes. This deliberately makes "the
cable got unplugged" and "the board rebooted mid-session" the exact same
recovery path — no separate reconnection sub-protocol needed.

---

## 7. Sim-side architecture (future implementation guidance)

This section is guidance for whoever implements the Rebel-Sim side later
— nothing here is built yet.

- **Entry point.** A new "connect to board" action calls
  `navigator.serial.requestPort()`. On success, this takes an alternate
  path through `app.ts` instead of the existing `constructMachine()`/
  boot/`startPump()` sequence — no `Machine` is ever constructed, and
  `Machine.step()` is never called in this mode.

- **Font rendering without a `Machine`.** `CanvasScreenHal` currently
  reads glyph pixel bits directly out of an `Arena`'s `FONT` bank via
  `arena.readByte()` (`canvas-screen-hal.ts:60`), which requires an
  `attach(arena, sysvars)` call normally made right after `Machine`
  construction. The recommended approach is to construct a **minimal
  standalone `Arena` + `BankTable` + `FONT` bank** purely to hold glyph
  data, and reuse `CanvasScreenHal` and the existing `rebel.FNT`-loading
  path completely unmodified — `BankTable`'s constructor only needs an
  `Arena`, and allocation bookkeeping is automatic, so this costs little.
  The alternative (refactoring `CanvasScreenHal`'s signature to accept
  raw glyph bytes directly, avoiding an `Arena` entirely) is not
  recommended: it would touch a class the local-`Machine` path depends on
  today, for no real savings.

- **Local shadow grid.** A plain `cols × rows` array of `{charCode, ink,
  paper}`, host/JS-owned (not arena/bank-resident — the same category
  `keyboard.ts`'s own ring buffer already documents itself as, excluded
  from any portable-dump claim). This is what makes `CURSOR` (§4) work
  without the board resending glyph data on every blink.

- **Render loop: an intentional divergence from `tick()`.** The existing
  local-interpreter loop is an idle-gated `requestAnimationFrame` pump
  (`app.ts`'s `tick()`/`wake()`/`pumping`) because it's scheduling a
  cooperative JS generator (`Inner`'s step functions) at a controlled
  budget per frame. Remote-terminal mode has no generator to schedule —
  it should instead drive directly off the WebSerial `ReadableStream`'s
  own `read()` loop (an `async` loop awaiting `reader.read()`), rendering
  frames as bytes actually arrive rather than batching to a 60 Hz
  cadence. This is a deliberate model change for this mode, not an
  oversight — a future implementer shouldn't try to force serial reads
  through the RAF pump.

- **Keyboard: forward-only.** `handleKeyEvent`'s existing `codeToUsage()`
  translation (`browser-keymap.ts`) stays as-is; in remote mode, its
  result is framed into a `KEY_EVENT` message and written to the serial
  port **instead of** calling `machine.keyboard.pushRawEvent()` — not in
  addition to it. This isn't a close call: remote mode has no local
  `Machine`/`Keyboard` to push into at all, so there's no second consumer
  to deliver to. Stated explicitly so a future implementer doesn't wonder
  whether dual delivery was considered and skipped by accident.

---

## 8. RP2350-firmware-side contract

This section is written so a new firmware project — in whatever language
or toolchain it ends up using, with no dependency on this repo's code —
can implement against it directly.

1. On entering remote-terminal mode (the board's own trigger for this —
   e.g. no HSTX display detected at boot — is a firmware decision this
   document does not dictate), open the USB CDC ACM device and send
   `HELLO` (§4) before anything else touches the wire.
2. Wait for `HELLO_ACK`. If `status != 0`, remote-terminal mode cannot
   proceed on this connection; how the board falls back (local display,
   halt, retry, log) is a firmware decision, not specified here.
3. From that point on, route every one of the board's own char-cell
   screen HAL calls — whatever they end up being named locally, but
   semantically the same two operations as Rebel-Sim's `ScreenHal`
   (paint one glyph cell; clear the whole screen) — through `PLOT_CHAR`/
   `CLEAR` frames instead of a local display driver. `CURSOR` is an
   optional, allowed substitute specifically for inversion-only cursor
   changes; it is never required. Per `spec/01-HAL.md` §3.6 — **REQUIRED**
   for every display-capable target, this board included, running in
   remote-terminal mode is not an exemption — any indexed-color
   resolution (`INK`/`PAPER` values 0-15 through an active
   `PALETTE-BASE` map) **MUST** already have happened locally by the
   time a call reaches this step: `PLOT_CHAR`'s `ink`/`paper` fields
   (§4) are the resolved `0xRRGGBB` colors, never a raw palette index.
   The board's own `PAL`/`ATTR` banks and `PALETTE-BASE` sysvar are as
   required as `CHAR`/`INK`/`PAPER` themselves — this protocol has
   nothing to say about them beyond that resolution having already
   happened.
4. Feed every incoming `KEY_EVENT` frame into the board's own keyboard-
   input pipeline at exactly the point real raw HID/co-processor
   usage-code events would normally enter it. `usageCode`/`pressed` here
   is not a translated or Sim-specific format — it's the board's own
   native raw-event shape (the same `(usageCode, pressed)` pair
   `Keyboard.pushRawEvent` already uses, chosen because it matches a real
   hardware keyboard driver's natural input), so this is a drop-in
   substitute input source, not a new code path to build.
5. Do not attempt to draw below char-cell granularity in this protocol
   version — no raw-pixel message exists yet (§10).

---

## 9. Keeping message IDs in sync across two independently-maintained codebases

This document's message catalog (§4) faces the same drift risk
`FORTH-ARCHITECTURE.md` §0 already names for primitive token IDs, sysvar
offsets, and bank tag/size-class tables: two codebases evolving
independently, each hand-tracking a numeric contract the other depends
on.

The recommended mitigation, extending rather than duplicating that
existing concern: one machine-readable source of truth — e.g. a
`remote-terminal-protocol.json` alongside `packages/engine/src/
rebel-opcodes.json`'s existing precedent — listing the sync byte,
checksum algorithm, protocol version, and the full message table (ID,
name, field layout) from §4.

One honest caveat, stated plainly rather than glossed over: unlike
`rebel-opcodes.json`, which has real (if not yet built) codegen plans
feeding both a TS const table and a future C++ header, this file's
firmware-side consumption will realistically start as **a human copying
constants into a header by hand**, since the new RP2350 project can't
depend on anything in this repo. The recommendation is to defer real
cross-language codegen for this protocol until `FORTH-ARCHITECTURE.md`
§0's own generator gets built for the primary opcode/sysvar/bank tables,
and extend that one tool to also emit this message table then — per that
section's own implied "build one generator, not several" discipline —
rather than standing up a second, protocol-specific generator now.

---

## 10. Open questions (named, not designed)

Per this project's stated scope-calibration philosophy, these are named
explicitly rather than either silently designed-in-advance or silently
ignored:

1. **Multi-session/arbitration** — a remote WebSerial connection existing
   alongside a locally-running `Machine` (e.g. split-screen, or switching
   between "local" and "remote" sessions in one tab). Not designed.
2. **Reconnect/resume mid-session** beyond "wait for a fresh `HELLO` and
   redraw everything" (e.g. a diffed resend that avoids a full
   redraw) — open.
3. **Raw-pixel graphics extension.** A `hal_draw_*`-equivalent message
   family (pixel/line/rect) is explicitly out of scope for this protocol
   version — it would need its own message-ID range and its own HAL
   surface on both sides (§1), not a redesign of what's here.
4. **Char-cell size negotiation beyond the fixed 8×8 v1 constraint** —
   open, and tied directly to Sim's font source being local-only (§5);
   solving it means either negotiable rendering or a font-transfer
   mechanism, neither designed here.
5. **Multiple attached boards / device selection beyond WebSerial's
   native picker** — single connection, single session assumed
   throughout this document.
6. **Real cross-language codegen for the message-ID table** (§9) —
   deferred until `FORTH-ARCHITECTURE.md` §0's own generator exists for
   the primary opcode/sysvar tables.
7. **The RP2350 firmware project's implementation language/toolchain** —
   out of scope for this document by design, since the wire contract
   itself (§3–§4) is language-agnostic. Flagged here since it affects how
   open item 6 actually ends up being consumed on that side.
