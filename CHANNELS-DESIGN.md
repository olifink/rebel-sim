# RebelROM: Channel & Device Architecture

Status: Draft, reconciled 2026-07-31 against shipped `CScreenModule`
(Phase 5), `CKeyboardModule` (Phase 8), and Rebel-Sim's M1-M6 engine.
**Nothing in this document is implemented in either codebase yet** — Phase
5/8 shipped their own concrete APIs directly (`Emit()`, `WriteChar()`,
`ReadEvent()`), not through an abstract `Channel` wrapper. This remains
genuinely Phase-11-equivalent work on both Rebel-ROM and Rebel-Sim, now
scheduled as Rebel-Sim's M7. See §8 for what changed in this reconciliation
pass and why.
Scope: Kernel C++ layer additions that sit beneath the Forth outer loop,
and their Rebel-Sim (`packages/engine`) equivalent.

## 1. Motivation

Phase 1 produced a sample kernel image that draws to screen and sends alive
messages over serial. To move forward — including supporting a remote
diagnostics/command path (Claude via MCP, and a local CLI fallback) — we
need a uniform way for command processors (starting with the Forth outer
loop) to read from and write to different I/O sources without knowing their
transport details.

Rather than special-case a "remote diagnostics path," this should be
first-class infrastructure: any I/O source — keyboard, serial, later a
remote/MCP connection — is a **channel**, and any of them can be bound to
a running command processor.

## 2. Layering

```
+-------------------------------------------+
|  Forth outer loop (interpreter)            |
|  - KEY, EMIT, TYPE, etc. as thin wrappers   |
+-------------------------------------------+
|  Kernel C++ layer                          |
|  - Channels (stream I/O abstraction)       |
|  - Memory banks, sysvars                   |
|  - Core devices (screen, sprites, mouse,   |
|    debounced keyboard)                     |
+-------------------------------------------+
|  Circle (bare-metal HAL)                   |
+-------------------------------------------+
```

Two distinct C++-level interfaces sit beneath Forth:

- **Channels** — byte-stream I/O (read/write/poll). Console-like *input*
  sources: keyboard, serial, eventually remote. **[Reconciled, §8]** —
  narrowed to input only; see §8 for why `EMIT` doesn't belong here.
- **Device services API** — structured, stateful hardware access with its
  own internal state and timing behavior (sprite compositing, pointer
  tracking). Not stream-shaped, so modeled separately from channels.
  **[Reconciled, §8]** — key debounce turned out not to live here; struck
  from this list.

Forth primitives are thin wrappers over both: `KEY` dispatches through
the currently bound channel; `EMIT`/`TYPE` call the screen HAL directly
(`FORTH-ARCHITECTURE.md` §7), not through a channel — see §8; hypothetical
words like `SPRITE!` or `POINTER@` call directly into the device services
API. The interpreter itself has no concept of channels or devices — it
just calls through function pointers/vtables (Rebel-ROM) or an injected
interface (Rebel-Sim) the host wires up.

## 3. Channel abstraction

**[Reconciled, §8]** Narrowed to a read-side interface. Write methods are
kept only as a reserved extension point — nothing currently needs them,
since `EMIT`/`TYPE` route through the screen HAL directly, not a channel
(§8). `read_byte()` always non-blocking now too, matching the settled HAL
rule (`FORTH-ARCHITECTURE.md` §7: `hal_get_key()` is non-blocking at the
HAL level; a blocking `KEY` is layered on top, and that layer is exactly
what binds to `Channel::has_data()` — see the new §7a there).

```cpp
class Channel {
public:
    virtual int  read_byte() = 0;      // non-blocking; -1 if none ready
    virtual bool has_data() = 0;       // poll
    // write_byte/write_string: reserved, unused for now — see §8.
};
```

Concrete implementations:

- `KeyboardChannel` — wraps `CKeyboardModule::HasEvent()`/`ReadEvent()`
  directly (Phase 8, shipped), **not** a separate debounced device-services
  layer — `CKeyboardModule` already diffs raw USB reports itself to derive
  clean press/release edges; there's no second debounce stage to defer to
  (§8 corrects the original assumption here). `read_byte()` returns the
  event's *translated* char (via the `KMAP` planes) and only surfaces
  events where that char is non-zero — an unmapped key (arrow, F-key,
  modifier-only) has no byte-stream representation and stays invisible to
  `Channel`, exactly as it already does to `KEY`/`KEY?` (`FORTH-ARCHITECTURE.md`
  §7).
- `SerialChannel` — wraps the UART (already exercised in Phase 1's alive
  messages).
- `RemoteChannel` (later) — talks to a local daemon over a Unix domain
  socket or equivalent. From the interpreter's point of view this is
  indistinguishable from any other channel — no special-casing needed
  above the kernel layer.

**Rebel-Sim equivalent (TypeScript, M7):**

```ts
interface Channel {
  hasData(): boolean;
  readByte(): number;   // -1 if none ready
}
```

- `KeyboardChannel` wraps the already-shipped `Keyboard` class (M4):
  `hasEvent()`/`readEvent()`, filtered to translated-char events only —
  same rule as the C++ side above, and no new debounce/edge logic needed
  since M4's `pushRawEvent` already only receives clean DOM `keydown`/
  `keyup` edges.
- No `SerialChannel` equivalent — nothing serial-shaped exists in-browser.
- `RemoteChannel` (later, M8) — a WebMCP-driven channel. Same interface,
  bound the same way as `KeyboardChannel`; the outer loop and blocking
  `KEY` word need zero changes when this lands, which is the whole point
  of routing M7's blocking I/O through `Channel` now rather than directly
  against `Keyboard`.

## 3a. Binary frame protocol (added 2026-09-02, revised 2026-09-02 — draft,
unreviewed)

**Revision note:** this section originally proposed a from-scratch
COBS-encoded frame with a `target`-byte router multiplexing several
subsystems over one physical link. That conflicted with a convention this
project had *already* built and shipped: `REMOTE-TERMINAL.md` §3/§4/§6
(Rebel-Sim ↔ RP2350 board, `remote-terminal-protocol.ts`). This revision
drops the from-scratch design in favor of that one. See below for what
changed and why.

Motivation, unchanged: raw `Channel` bytes are enough for keyboard-shaped
input feeding `KEY`. Some transports instead need real bidirectional
traffic — Rebel-Net-Stick's postbox requests/responses being the first
Rebel-ROM-side case. Rather than invent a second binary-framing style for
that, it should follow the same shape `REMOTE-TERMINAL.md` already
established and shipped.

**Framing convention: adopt `REMOTE-TERMINAL.md` §3/§4/§6 as-is, not a
new design.**

```
byte 0            SYNC        0xA5              fixed; never a valid MSG_ID
byte 1            MSG_ID      u8                per-protocol catalog, own to this link
byte 2            LEN         u8                payload length, 0-255
byte 3..3+LEN-1   PAYLOAD     LEN bytes          per message
byte 3+LEN        CHECKSUM    u8                (MSG_ID + LEN + Σ payload) mod 256
```

- Multi-byte payload fields little-endian, matching the same rule
  `FORTH-ARCHITECTURE.md` fixes for every Forth cell.
- Booleans: `0xFF` = TRUE, `0x00` = FALSE — the byte-width-scaled version
  of the project's `TRUE = -1` HAL convention, not a new one.
- Checksum is additive mod 256, **not** CRC — deliberately: it exists to
  catch local framing/resync bugs, not to act as forward error correction
  over a link (USB CDC) that already does bit-level integrity checking
  underneath. A stronger check is something to add only if real
  corruption is actually observed in practice.
- Resync: scan forward for `0xA5`; trust a candidate as a real frame
  boundary only once its trailing checksum validates, so a byte that
  happens to equal `0xA5` inside a payload is never misread as a false
  frame start. On checksum mismatch, discard and resume scanning from the
  very next byte — never get stuck.
- No per-message ACK/retransmit, and no wire-level heartbeat — the
  transport's own connect/disconnect signal (WebSerial's `disconnect`
  event there; the OS's USB CDC attach/detach on Rebel-ROM's side) is
  treated as sufficient, and a dropped frame is expected to be corrected
  by the next message that touches the same state, not retried.

**What's genuinely reusable is the convention, not a shared codec.**
`REMOTE-TERMINAL.md` doesn't multiplex several subsystems over one link
with a routing byte — it's single-purpose per physical link, with its own
scoped `MSG_ID` catalog (`HELLO`/`HELLO_ACK`/`PLOT_CHAR`/`CLEAR`/`CURSOR`/
`KEY_EVENT`), and deliberately pushes unrelated traffic (human-readable
debug logging) onto a *separate* physical UART rather than sharing the
binary link. Net-Stick doesn't share a wire with Remote-Terminal at all —
different physical link, different purpose — so there's no actual need
for a shared multiplexing codec between them. What Net-Stick should reuse
is the frame *shape* above (sync/id/len/checksum, endianness, booleans,
resync-by-rescan, no-ACK philosophy), while defining its own `MSG_ID`
catalog scoped to postboxes (`NET-STICK.md`, forthcoming) — the same
relationship `REMOTE-TERMINAL.md`'s catalog has to this shared shape, not
a new relationship.

One consequence worth flagging now rather than rediscovering later:
`LEN` is a `u8` (max 255-byte payload) in the adopted convention. Net-Stick
response bodies — including anything condensor/summarizer output — will
routinely exceed that and need chunking across multiple frames; that's a
`NET-STICK.md` design point, not a change to this shape.

**First real use of the reserved write side.** `SerialChannel`'s
`write_byte()`/`write_string()`, reserved-but-unused since §3, get their
first actual caller here — framed traffic needs real outbound bytes, not
just `read_byte()`. Whether that means implementing those methods as
originally reserved, or introducing a distinct duplex-capable channel
variant (`SerialChannel` gains real write; `KeyboardChannel` stays
read-only, since a keyboard has no write side to speak of) is an open
question below, not assumed here.

**Where structured, stateful consumers like postboxes live.** Not as a
`Channel` — Net-Stick's postboxes are structured and asynchronous (a fixed
number of slots, each with its own state, a ready-bitmask, no meaningful
"next byte" to hand `KEY`). That's the same shape as the **Device services
API** bucket in §2 (sprite compositing, pointer tracking) — stateful
hardware access with its own internal lifecycle, not stream-shaped. The
resulting layering:

```
Forth words (postbox-specific, e.g. NET-SEND, NET-READY?, NET-READ)
        |
Postbox device-services module (owns slot state, ready bitmask)
        |
Frame parser (this section's shape; Net-Stick's own MSG_ID catalog)
        |
SerialChannel (raw duplex bytes)
        |
Circle / USB CDC HAL
```

This mirrors how `KeyboardChannel` wraps `CKeyboardModule` today: the
*channel* is the raw transport, a *device module* above it owns real
state and exposes its own Forth words, and nothing about postboxes needs
to pretend to be `KEY`-shaped to fit.

## 4. Command processor binding

Rather than one interpreter instance multiplexing multiple channels, the
simplest model to start with: **one Forth outer-loop instance bound to
one (input) channel**. Two independent sessions (e.g. keyboard-bound and
serial-bound) share the same underlying memory banks/sysvars/device state.
**[Reconciled, §8]** The original "contend for the same screen channel"
scenario doesn't arise as stated — screen was never modeled as a channel
(§8), it's the one shared HAL surface every session already writes through
(`SCRN`/`CHAR`, classified as a shared singular resource,
`FORTH-ARCHITECTURE.md` §3/§10). So two sessions bound to different input
channels *do* already share one output surface today, by construction, not
by an arbitration mechanism this doc needs to design — genuine per-session
output would be an arena-isolation-level feature (`FORTH-ARCHITECTURE.md`
§9, items 6-7), out of scope here.

Open question to resolve once we see it in practice: whether RebelROM
needs a single shared session state driven by multiple channels (requiring
an explicit arbiter/lock), or whether independent per-channel sessions are
sufficient. Recommendation: don't build the lock now — implement
independent sessions first, revisit if a real need for shared-session
arbitration surfaces.

## 5. Remote channel: daemon design (later phase, informed by this doc)

Exclusivity model:

- A single daemon process owns the physical serial port node
  (`/dev/ttyUSB0` or equivalent) exclusively.
- The daemon exposes a local Unix domain socket API with two tiers:
  - **Low-level/raw access** — used by Claude (via MCP), sends
    arbitrary bytes/commands, reads buffered diagnostic output.
  - **High-level curated commands** — used by a local CLI fallback
    (`reset`, `load <bank>`, `dump-sysvars`, `step`, etc.), pre-validated
    before hitting the wire.
- A command queue serializes serial-originated transactions from both
  callers (Claude, CLI) so writes/reads don't interleave.
- Local keyboard input on the physical Pi does **not** route through the
  daemon — it goes straight into the kernel's `KeyboardChannel`. Any
  merge/arbitration between keyboard and serial input, if ever needed, is
  a kernel-level concern (see Section 4), not a daemon concern.

This keeps the daemon a thin transport + serial-side turn-taking layer,
and keeps RebelROM's kernel as the single source of truth for what a
coherent command/response cycle looks like.

## 6. Open questions

- ~~Debounce and pointer-state ownership~~ — **resolved, §8**: keyboard
  edge-detection lives inside `CKeyboardModule`/`Keyboard` itself, no
  separate device-services debounce stage exists. Pointer-state ownership
  is still open, but moot until a pointer device exists on either target.
- Independent-session vs shared-session model (§4) — **resolved for
  Rebel-Sim, M9**: shared session, via `CompositeChannel` merging
  keyboard and remote (WebMCP) input into the one `Machine`/`Channel`
  binding — no arbiter built, matching this doc's own recommendation.
  Rebel-ROM's serial-bound-session equivalent is still open.
- Remote channel transport — for Rebel-ROM, Unix domain socket vs TCP,
  still open, decide when the daemon is built. **For Rebel-Sim,
  resolved, M9**: no daemon/server at all — `RemoteChannel` is fed
  directly by a page-registered WebMCP tool's `execute()` handler
  (Angular's `declareExperimentalWebMcpTool`), same JS process as the
  engine, no transport layer to design.
- ~~Whether `EMIT`/`TYPE` dispatch through a channel~~ — **resolved, §8**:
  no, they call the screen HAL directly.
- **New, from §3a**: activate `SerialChannel`'s reserved write methods
  as-is, or introduce a distinct duplex-capable channel variant so
  read-only channels like `KeyboardChannel` aren't stuck implementing a
  write interface they'll never use? Open, decide when the frame parser
  is actually implemented.
- ~~Checksum choice for the binary frame trailer~~ — **resolved, §3a
  revision**: additive mod 256, adopted directly from
  `REMOTE-TERMINAL.md` §3, not decided independently.
- ~~Whether a shared `target`-byte multiplexing codec is needed across
  future binary-framed subsystems~~ — **resolved, §3a revision**: no —
  `REMOTE-TERMINAL.md` precedent is one scoped `MSG_ID` catalog per
  physical link, not multiplexing. Net-Stick gets its own catalog on its
  own link; revisit only if a real case for sharing one physical link
  across subsystems ever shows up.
- **New, from §3a revision**: `NET-STICK.md`'s own message catalog will
  need a chunking scheme for payloads over the `u8 LEN` cap (255 bytes)
  — postbox response bodies, condensor output — since the adopted frame
  shape doesn't raise that ceiling. Belongs in `NET-STICK.md`, not here.

## 7. Next-phase implementation targets

**Rebel-ROM (Phase 11):**
1. `Channel` base class (input-only, §3) + `SerialChannel` (already have
   working UART I/O from Phase 1 to adapt).
2. `KeyboardChannel` wrapping `CKeyboardModule::HasEvent()`/`ReadEvent()`
   directly (§3) — no new debounce logic needed, §8.
3. Bind the outer loop's blocking `KEY` to a channel reference; `EMIT`/
   `TYPE` stay directly on the existing screen HAL (§8), unchanged.
4. Prove out two independent sessions (keyboard-bound, serial-bound)
   sharing memory banks/sysvars.
5. `RemoteChannel` + daemon (separate design pass, informed by this doc).
6. Binary frame parser (§3a) — sync/id/len/checksum shape adopted from
   `REMOTE-TERMINAL.md` §3, implemented in C++ for the first time (that
   doc's version is TypeScript/Rebel-Sim-side only). Sits beside
   `Channel` rather than inside it. First consumer is Rebel-Net-Stick's
   postbox device-services module (`NET-STICK.md`, forthcoming), riding
   on `SerialChannel`'s now-active write side, with its own `MSG_ID`
   catalog rather than sharing one with Remote-Terminal's.

**Rebel-Sim (M7, done — see `PLAN.md`):** the TypeScript equivalent
of targets 1-3 above, run ahead of Rebel-ROM's Phase 11 in this
instance. `RemoteChannel`-as-WebMCP (target 5's analog) shipped as M9
(`PLAN.md`) — no daemon, since Rebel-Sim's "transport" is just a
page-registered WebMCP tool calling `RemoteChannel.push()` directly in
the same JS process.

## 8. Reconciliation notes (2026-07-31)

Pulled in against `FORTH-ARCHITECTURE.md` v4 and Rebel-Sim's shipped
M1-M6 engine. Three corrections from the original draft:

1. **`EMIT`/`TYPE` don't dispatch through a channel.** The original §2
   diagram and §4's "contend for the same screen channel" phrasing
   implied output was channel-routed like input. It isn't, on either
   target: `CScreenModule` (Rebel-ROM, Phase 5) and `Screen` (Rebel-Sim,
   M3) are both a single shared HAL-level surface invoked directly
   (`FORTH-ARCHITECTURE.md` §7's `hal_emit`/`hal_plot_char`/`hal_draw_*`
   three-way split), never wrapped as a `Channel`. `Channel` is narrowed
   to **input only** — this doc's actual job was always the `KEY` side;
   the `EMIT` framing was aspirational and never became true. Multiple
   input channels already share one output surface today, which is a
   simplification, not a gap.
2. **Keyboard debounce isn't a separate device-services stage.** The
   original draft assumed `KeyboardChannel` would wrap a debounced signal
   coming from some lower device-services layer. The shipped
   `CKeyboardModule` (Phase 8) and its Rebel-Sim port `Keyboard` (M4) both
   do their own edge-detection inline — there's nothing underneath to wrap
   for that purpose. `KeyboardChannel` wraps the module's event
   read/poll directly.
3. **Nothing here has been built on either target yet.** Both `Channel`
   base classes remain draft — Rebel-ROM's Phase 8 shipped
   `CKeyboardModule` without ever wrapping it in a `Channel`, and
   Rebel-Sim's M4 shipped `Keyboard` the same way. This document was
   correct that the abstraction is worth building; it just hadn't been
   needed until the execution-loop work (Phase 11 / Rebel-Sim M7) made
   blocking I/O and remote/MCP input actual, immediate requirements
   rather than anticipated ones.
