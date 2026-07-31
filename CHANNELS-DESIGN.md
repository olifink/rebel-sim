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
- Independent-session vs shared-session model (§4) — still open, revisit
  once a second input channel (serial-bound or remote-bound Forth session)
  actually exists on either target. Recommendation unchanged: don't build
  the arbiter until a real need surfaces.
- Remote channel transport — for Rebel-ROM, Unix domain socket vs TCP,
  decide when the daemon is built. For Rebel-Sim, the equivalent decision
  is the WebMCP transport shape itself — also deferred to M8, doesn't
  affect this doc's layering either way.
- ~~Whether `EMIT`/`TYPE` dispatch through a channel~~ — **resolved, §8**:
  no, they call the screen HAL directly.

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

**Rebel-Sim (M7, in progress — see `PLAN.md`):** the TypeScript equivalent
of targets 1-3 above, running ahead of Rebel-ROM's Phase 11 in this
instance. `RemoteChannel`-as-WebMCP (target 5's analog) is scoped as M8,
deliberately not designed in now beyond the interface shape in §3, per
this doc's own "don't build ahead of a real need" recommendation.

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
