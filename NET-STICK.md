# NET-STICK.md — Rebel-Net-Stick: external network/service bridge over USB serial

## 0. Status and scope

**Status: fully design-only.** Nothing in this document is implemented on
either side. It depends on `CHANNELS-DESIGN.md` §3a for the wire framing
convention (adopted, not redefined here) and anticipates USB-host support
on the Rebel-ROM/Rebel-Board side that doesn't exist yet either — same
kind of unbuilt dependency `REMOTE-TERMINAL.md` §0 names for its own
`navigator.serial` link. Not designed here.

**What Rebel-Net-Stick is:** a separate, non-Rebel-core board (ESP32-S3,
CircuitPython to start) that plugs into any Rebel target over USB and
does everything "talk to the outside world" means — WiFi, time, HTTPS,
and later Rebel-Net itself (tele-text-style info screens, inter-Rebel
messaging, spawning/managing Rebel machines in the cloud) — behind one
narrow protocol. Rebel never speaks WiFi, TLS, or HTTP; it speaks
postboxes.

**What this document does not define:** Rebel-Net's own content (screen
formats, message semantics, spawn/manage commands), which service types
beyond plain HTTP actually ship first, or the exact shape of "condensing."
Those are separate, later specs. This document only fixes the mechanism
they'll all ride on: postbox lifecycle, the target table, chunking, and
setup.

## 1. Motivation and shape of the problem

Rebel is deliberately offline-shaped at its core — flat memory, text
output, no OS. Rebel-Net-Stick is where "talk to the outside world" lives
instead, kept entirely outside that boundary and reached only through a
narrow, poke-able-shaped interface: a fixed number of **postboxes**, each
independently: idle, holding a pending request, holding a ready response,
or in error. Rebel writes a request into a box, later polls (cheaply, via
one bitmask) which boxes have something waiting, and reads. Everything
about *how* a given box's request actually got fulfilled — WiFi, HTTPS,
Rebel-Net's own wire format, a cloud-store API, whatever — is the stick's
problem, not Rebel's.

The **target table** (§5) is what makes this generic rather than
HTTP-specific: each target is a row saying "index N means this service,
reached this way, authenticated like this," and a postbox request just
names a target index. HTTP/HTTPS is the first target type, but the same
mechanism accommodates Rebel-Net's own service, cloud-store, cloud-spawn,
or messaging without any change to the postbox protocol itself — new
service types are a stick-side concern.

## 2. Hardware & firmware target

- **Board:** ESP32-S3 (already ordered) — dual-core, native USB OTG, WiFi,
  BLE. Chosen partly because commercial USB-stick hardware already exists
  on this chip.
- **Firmware:** CircuitPython to start. Its native-USB device support
  (CDC, and potentially MSC later if a bulk-data path is ever added
  alongside this protocol — see `CHANNELS-DESIGN.md` §3a's note that this
  isn't designed to multiplex with unrelated traffic) is more mature than
  stock MicroPython's on this family. Move to C/ESP-IDF only if
  CircuitPython genuinely can't do something needed — no urgency to
  switch pre-emptively.
- **Rebel-side dependency, unbuilt:** Rebel-ROM (Circle) and Rebel-Board
  (Pico 2, RISC-V) both need to act as **USB host** to talk to the stick.
  That's real, separate work this document doesn't design — it assumes
  the host side eventually presents the stick's CDC connection as a
  `SerialChannel` (`CHANNELS-DESIGN.md` §3) and stops there.

## 3. Transport & framing

USB CDC ACM, same class of device `REMOTE-TERMINAL.md` §2 already uses
for its own (unrelated) link. **Framing is not redefined here** — this
protocol uses the shape `CHANNELS-DESIGN.md` §3a adopted from
`REMOTE-TERMINAL.md` §3 as-is: `SYNC(0xA5) | MSG_ID(u8) | LEN(u8) |
PAYLOAD | CHECKSUM(u8, additive mod 256)`, little-endian multi-byte
fields, `TRUE=0xFF`/`FALSE=0x00`, resync-by-rescan, no per-message
ACK/retransmit beyond what individual messages below define, no
heartbeat (USB attach/detach is the disconnect signal).

This is a **separate physical link** from `REMOTE-TERMINAL.md`'s
Sim↔RP2350 connection — different hardware, different purpose — so its
`MSG_ID` catalog (§7) is its own numbering, starting again at `0x01`, not
a continuation of that document's.

## 4. Postbox model

A fixed number of postboxes, `POSTBOX_COUNT` — draft default **32**,
matching the original sketch; open to change (§13). Each box has state:

```
IDLE ──REQUEST accepted──▶ PENDING ──stick completes fetch──▶ READY ──rebel reads + RELEASE──▶ IDLE
                                                          └─▶ ERROR ──rebel RELEASE────────────▶ IDLE
```

- A `REQUEST` sent to a box not currently `IDLE` is rejected (`BUSY`,
  §7) — box state doesn't change. Rebel is responsible for not reusing a
  box it hasn't released.
- `RELEASE` is how Rebel tells the stick "I've read everything I need
  from this box, free it" — without it, the stick would need to hold
  response data indefinitely against the chance Rebel re-reads it.
- **Ready signaling, host-side.** The stick sends an unsolicited
  `POSTBOX_READY` frame the moment a box's request completes (success or
  error) — it does not wait to be asked. The postbox device-services
  module (`CHANNELS-DESIGN.md` §3a's layering: sits above `SerialChannel`,
  below Forth words) maintains a host-side 32-bit `NETSTICK-READY`
  sysvar, one bit per box, set on `POSTBOX_READY`, cleared on `RELEASE`.
  This is the "simple signalling which boxes received an answer" from
  the original sketch — Rebel polls one word instead of 32 boxes.

## 5. Target table

Rebel registers targets on the stick via `TARGET_SET` (§7) — not the
other way around: the stick never invents its own targets. Each entry:

| Field | Type | Meaning |
|---|---|---|
| `index` | u8 | 0..N-1, Rebel's handle for this target |
| `serviceType` | u8 | `0x01`=HTTP/HTTPS, `0x02`=Rebel-Net, `0x03`=cloud-store, `0x04`=cloud-spawn, `0x05`=messaging, `0x00`/rest reserved |
| `config` | opaque bytes | service-type-defined — for HTTP: base URL + default headers; for others: TBD by their own future specs |

The point of indirection: **credentials never have to exist in Rebel's
own memory.** `config` can reference a credential the stick already holds
(e.g. by its own internal key name) rather than Rebel embedding a token
in a Forth string. A postbox `REQUEST` (§7) names a target index plus a
verb and a short path/suffix — it never carries a full URL or a secret.

`serviceType` is deliberately open-ended past HTTP — this is what makes
the target table read as a **service list**, not an HTTP client
abstraction: Rebel-Net's own protocol, cloud-store, cloud-spawn, and
messaging are all just other rows, each defining their own `config` and
response shape independently, without touching this document's postbox
mechanism.

## 6. Chunking (shared envelope, `LEN` cap workaround)

The adopted frame shape (§3) caps a single frame's payload at 255 bytes
(`LEN` is `u8`). `TARGET_SET.config`, `POSTBOX_REQUEST` bodies, and
response bodies (condensor output very much included) will routinely
exceed that. Rather than inventing a chunking scheme per message type,
one shared shape, reused three ways:

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `key` | u8 | target `index` or postbox number, depending on which exchange is in progress |
| 1 | `offset` | u16 | byte offset this chunk starts at |
| 3 | `chunkLen` | u8 | bytes in this chunk (≤ 252, leaving room for the header within one frame) |
| 4 | `chunk` | bytes | payload bytes |
| 4+chunkLen | `more` | u8 | `0xFF` if further chunks follow, `0x00` if this is the last |

Used three ways, always keyed by whichever exchange is currently open for
that `key` — at most one multi-part exchange per box/target index at a
time, so no separate exchange-ID is needed:

1. **Outbound, `TARGET_SET` continuation** (rebel → stick) — only if
   `config` exceeds what fit in the initial `TARGET_SET` frame.
2. **Outbound, `POSTBOX_REQUEST` continuation** (rebel → stick) — only if
   the request body exceeds what fit in the initial frame.
3. **Inbound, `POSTBOX_READ` reply** (stick → rebel) — pull-based: Rebel
   asks for a chunk at a given offset (`POSTBOX_READ`, §7) and gets back
   exactly one of these per request. This is deliberately pull, not
   push, unlike the outbound cases — Rebel controls how much of a
   response it buffers at once, which matters more on the response side
   since bodies (condensed or not) are the direction most likely to be
   large and unpredictable in size.

## 7. Message catalog

All multi-byte fields little-endian (§3). `0x00` reserved/invalid, same
rule as `REMOTE-TERMINAL.md` §4.

| ID | Name | Direction | Mirrors/Purpose |
|---|---|---|---|
| 0x01 | `HELLO` | stick → rebel | handshake, sent first |
| 0x02 | `HELLO_ACK` | rebel → stick | handshake response |
| 0x03 | `TARGET_SET` | rebel → stick | register/update a target table entry |
| 0x04 | `TARGET_SET_ACK` | stick → rebel | accept/reject |
| 0x05 | `POSTBOX_REQUEST` | rebel → stick | start a request in a box |
| 0x06 | `POSTBOX_REQUEST_ACK` | stick → rebel | accepted (→ PENDING) or rejected |
| 0x07 | `CHUNK` | both | continuation/reply, shared shape (§6) |
| 0x08 | `POSTBOX_READY` | stick → rebel | unsolicited: box has a result |
| 0x09 | `POSTBOX_READ` | rebel → stick | pull one chunk of a ready box's response |
| 0x0A | `POSTBOX_RELEASE` | rebel → stick | done reading, free the box |
| 0x0B | `ERROR` | stick → rebel | general/protocol-level error, not box-specific |

### `HELLO` (stick → rebel, sent first)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `protocolVersion` | u8 | `1` |
| 1 | `postboxCount` | u8 | actual box count this stick provides |
| 2 | `capabilities` | u8 | bitfield — bit0: WiFi connected, bit1: time synced, rest reserved |

### `HELLO_ACK` (rebel → stick)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `status` | u8 | `0`=OK, `1`=VERSION_MISMATCH |

### `TARGET_SET` (rebel → stick)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `index` | u8 | |
| 1 | `serviceType` | u8 | §5 |
| 2 | `totalConfigLen` | u16 | total config size (may exceed this frame) |
| 4 | `configChunk` | bytes | as much of `config` as fits in this frame |

Continuation via `CHUNK` (§6) keyed by `index`, only if `totalConfigLen`
exceeds what fit in the initial frame.

### `TARGET_SET_ACK` (stick → rebel)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `index` | u8 | |
| 1 | `status` | u8 | `0`=OK, `1`=BAD_SERVICE_TYPE, `2`=BAD_CONFIG |

### `POSTBOX_REQUEST` (rebel → stick)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `box` | u8 | |
| 1 | `target` | u8 | index into the target table |
| 2 | `verb` | u8 | service-type-defined (for HTTP: GET/PUT/POST/DELETE) |
| 3 | `mode` | u8 | `0`=raw, `1`=condensed — a *hint*; stick/target may not honor it |
| 4 | `totalBodyLen` | u16 | total request body size (may be 0) |
| 6 | `bodyChunk` | bytes | as much of the body as fits in this frame |

Continuation via `CHUNK` (§6) keyed by `box`, only if `totalBodyLen`
exceeds what fit in the initial frame.

### `POSTBOX_REQUEST_ACK` (stick → rebel)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `box` | u8 | |
| 1 | `status` | u8 | `0`=ACCEPTED (→PENDING), `1`=BUSY, `2`=BAD_TARGET |

### `POSTBOX_READY` (stick → rebel, unsolicited)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `box` | u8 | |
| 1 | `kind` | u8 | §8 — `0`=raw, `1`=condensed, `2`=error |
| 2 | `totalLen` | u16 | total response size available to read |

### `POSTBOX_READ` (rebel → stick)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `box` | u8 | |
| 1 | `offset` | u16 | |
| 3 | `maxLen` | u8 | most bytes rebel wants back this call |

Answered by one `CHUNK` (§6) keyed by `box`.

### `POSTBOX_RELEASE` (rebel → stick)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `box` | u8 | |

No response frame — same fire-and-forget shape as `REMOTE-TERMINAL.md`'s
`KEY_EVENT`, since the box's state transition (→IDLE) is confirmed
implicitly the next time Rebel would try to reuse it.

### `ERROR` (stick → rebel)

| Offset | Field | Type | Meaning |
|---|---|---|---|
| 0 | `code` | u8 | stick-defined |
| 1 | `context` | u8 | box number, or `0xFF` for a link/global-level error |

## 8. Response envelope and condensing

`POSTBOX_READY.kind` (§7) is deliberately part of the envelope, not
buried in the body: `raw` (bytes as the target returned them), `condensed`
(the stick, or a service behind it, ran some form of summarization/
extraction before handing the result back), or `error`. Rebel-side code
doesn't need to know *how* condensing happened — a target-level setting,
a per-request `mode` hint, or a Rebel-Net-specific service that always
condenses are all just `kind=1` from Rebel's point of view. What
"condensed" actually means (format, whether it's still target-specific
structure or flattened text) is explicitly not designed here — first
concrete use case needed before that's worth fixing.

## 9. Setup: WiFi, time, credentials

**Recommendation, not yet confirmed:** keep WiFi/credential provisioning
**off** this protocol entirely, rather than inventing `SET_WIFI`-style
messages here. Typing a WiFi password through Rebel's keyboard into a
Forth REPL is a bad interface for something every commercial USB WiFi
stick already solves better — BLE provisioning (the S3 has BLE) or a
first-boot captive-portal AP, phone-driven, same as most consumer IoT
hardware. Time sync then comes for free from NTP once WiFi is up, with
no bespoke message needed — `HELLO.capabilities` (§7) already just
reports whether it's done.

Under this reading, the *only* setup traffic on this protocol is
`TARGET_SET` — registering services and credential references, not
device provisioning. That keeps this document's scope to what it's
actually about (postboxes and targets), and pushes "how do I get WiFi
creds onto the stick" to the stick's own firmware/hardware design, not
the wire protocol.

Not yet decided (§13): whether the target table itself persists in the
stick's own flash across power cycles (Rebel just re-attaches and finds
its targets already there) or is session-scoped (Rebel re-sends every
`TARGET_SET` after every `HELLO`).

## 10. Execution-loop integration

The postbox device-services module needs to actively drain
`SerialChannel` and dispatch incoming frames by `MSG_ID` — nothing pushes
data to Forth on its own. This should tie into whatever already pumps
other polled I/O each interpreter tick (keyboard, sprite/animation state),
not run on a separate mechanism. Exact hook point is a Rebel-ROM
execution-loop concern, not designed here — flagged so it isn't
forgotten when `NETSTICK-READY` (§4) is wired up.

## 11. Error handling and resync

Inherits `CHANNELS-DESIGN.md` §3a / `REMOTE-TERMINAL.md` §6's model
wholesale: a corrupted or dropped frame is discarded and the reader
resumes scanning for `0xA5` — no retransmit. This degrades less gracefully
here than for screen state (`REMOTE-TERMINAL.md`'s "next `PLOT_CHAR`
fixes it" doesn't have a postbox equivalent — a dropped `POSTBOX_READY`
just means Rebel waits and never finds out), so **`NETSTICK-READY`
staying stuck is a real, open failure mode** (§13), not fully solved by
inheriting the general resync rule.

## 12. Firmware-side contract (ESP32-S3 / CircuitPython)

Written so the stick firmware can be built against this section alone:

1. On boot, once USB CDC is up, send `HELLO` before anything else touches
   the wire — same pattern `REMOTE-TERMINAL.md` §8 uses.
2. Hold all 32 (or `POSTBOX_COUNT`) postboxes `IDLE` and the target table
   empty until `TARGET_SET`/`POSTBOX_REQUEST` frames arrive — no implicit
   default targets.
3. A `POSTBOX_REQUEST` against an unset `target` index is a
   `POSTBOX_REQUEST_ACK{status=BAD_TARGET}`, not a crash or silent drop.
4. Complete requests asynchronously — never block the CDC read loop on a
   slow HTTP call. `POSTBOX_READY` fires whenever the underlying
   WiFi/HTTP/service call actually finishes.
5. Hold a completed box's response in memory until `POSTBOX_RELEASE`
   arrives; a stick that's memory-constrained may need its own policy for
   what happens if Rebel never releases a box (timeout eviction?) — not
   specified here (§13).

## 13. Open questions (named, not designed)

1. **`POSTBOX_COUNT` = 32** — inherited from the original sketch as a
   draft default, not confirmed.
2. **Target table persistence** (§9) — session-scoped vs. stick-flash-
   persisted across power cycles. Affects whether a `TARGET_LIST`/query
   message is needed (not currently in the catalog).
3. **Dropped `POSTBOX_READY` recovery** (§11) — the general resync rule
   doesn't give Rebel a way to notice a box it's still waiting on. Options
   not yet weighed: a periodic Rebel-initiated poll of all box states as
   a fallback, vs. accepting the gap as rare enough not to guard against
   pre-emptively.
4. **Stick-side memory pressure** if Rebel never sends `POSTBOX_RELEASE`
   (§12 item 5) — no eviction/timeout policy defined.
5. **`condensed` format** (§8) — entirely undefined pending a first real
   consumer (Rebel-Net telex screens are the likely first case).
6. **Service types beyond HTTP** (`0x02`-`0x05`, §5) — reserved
   placeholders only; each needs its own `config`/response spec before
   it's real.
7. **WiFi/credential provisioning mechanism** (§9) — BLE vs.
   captive-portal AP vs. something else; a stick-firmware decision this
   document deliberately doesn't make.
