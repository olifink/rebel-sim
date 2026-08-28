# 05-REMOTE-TRANSPORTS.md — a transport contract for `REMOTE-TERMINAL.md`'s wire protocol

## 0. What this document is (and isn't)

**Status: design-only, extracted from what the existing implementation
already proved, not from a new mechanism.** Note also, unlike `01`-`04`
in this suite: this document is **not** part of the portable,
target-generic specification those four are (`00-OVERVIEW.md` §2/§5 —
"deliberately generic: names no specific CPU, board, toolchain, or
vendor SDK"). It's Rebel-Sim-implementation-specific — it cites real
`packages/engine` TypeScript files and lines throughout, the way
`REMOTE-TERMINAL.md` itself does, and it uses no RFC 2119 requirement
language. It lives in `spec/` for numbering and discoverability
alongside the rest of the remote-terminal design work, not because it
conforms to the same portability contract as `01`-`04`. `REMOTE-TERMINAL.md` specs one
wire protocol (its §3/§4) and, so far, one real transport binding —
WebSerial ↔ USB CDC ACM (its §2), still unbuilt against actual hardware.
But the protocol implementation in `packages/engine` (`remote-terminal-
protocol.ts`, `remote-board.ts`, `remote-terminal.ts`) was never written
against WebSerial at all: both roles talk to a five-line `ByteSink`
interface (`remote-terminal-protocol.ts:47-49`) and a plain
`receiveBytes(bytes: Uint8Array)` method, and `remote-terminal-loopback
.test.ts` already exercises the entire protocol — handshake, `PLOT_CHAR`/
`CLEAR`/`CURSOR` forwarding, `KEY_EVENT` round-trip — over a same-process
function-call transport instead of a serial port. That test isn't a mock
standing in for a missing real transport; it *is* a second, real transport
implementation, and its existence is the evidence this document works
from: **the wire protocol and the byte pipe underneath it are already
decoupled in practice, just not yet decoupled in writing.**

This document does two things REMOTE-TERMINAL.md deliberately doesn't:

1. Names the transport boundary as a formal contract (§2), including the
   half of it that's currently informal — inbound delivery and connection
   lifecycle, which today exist only as call-a-method-when-convenient
   conventions inside `RemoteBoard`/`RemoteTerminal`, not a typed
   interface.
2. Surveys concrete transports beyond WebSerial (§4) that the same
   protocol could run over — because the family this project targets
   (`CLAUDE.md`'s target list) includes a **headless Rebel firmware**
   variant that is explicitly "UART-channel-driven, no display/keyboard"
   and may never sit behind a browser-visible USB port at all, and because
   WebSerial itself is Chrome/Chromium-only (`REMOTE-TERMINAL.md` §2),
   which is a real reachability gap for anyone not on that browser.

**What this document does not do:** redesign the wire protocol. §3/§4's
frame layout, checksum, resync algorithm, and message catalog are settled
by `REMOTE-TERMINAL.md` and are treated here as fixed inputs — the entire
point of a transport contract is that swapping the byte pipe underneath
never touches them. Nor does it pick a second transport to build next;
per this project's stated scope discipline (`CLAUDE.md`, "Calibrating
scope"), building a WebSocket or Bluetooth transport before a concrete
board needs one would be exactly the kind of ahead-of-need work that
philosophy warns against. §4 surveys candidates and names their real
tradeoffs; it does not schedule any of them.

---

## 1. Why this is worth writing down now, not later

The temptation to skip this document is real: WebSerial is the only
transport REMOTE-TERMINAL.md actually needs for its stated scenario (a
real RP2350 board, no display, plugged into the machine running Rebel-
Sim), and it isn't built yet either. Writing a transport contract before
a second real transport exists risks designing an abstraction against
zero concrete use cases beyond the loopback test.

Two things make it worth doing anyway, now:

- **The abstraction already exists and already has two implementations**
  (loopback, and — via `BoardScreenHal`/`RemoteBoard`'s use of a bare
  `ByteSink` — anything else that can hand bytes to a callback). This
  document isn't proposing new design surface; it's writing down a
  boundary the code already drew, so the next implementor doesn't have to
  reverse-engineer it from `remote-terminal-loopback.test.ts`.
- **Half of that boundary — lifecycle — is missing, not just informal.**
  §6's disconnect/reconnect behavior ("tear down the remote session
  entirely... on any fresh connect, Sim always starts in a 'waiting for
  `HELLO`' state") is written in `REMOTE-TERMINAL.md` as prose describing
  what the *app* should do, not as something `RemoteBoard`/`RemoteTerminal`
  expose a hook for. Neither class has a `disconnect()`/`onDisconnect()`
  of any kind today. A real WebSerial implementation, or any other
  transport, needs somewhere to plug that in — §2 proposes where.

---

## 2. The transport contract

### 2.1 What stays exactly as it is

`RemoteBoard` and `RemoteTerminal` keep taking a bare `ByteSink` in their
constructors, unchanged:

```ts
export interface ByteSink {
  writeBytes(bytes: Uint8Array): void;
}
```

This document does **not** propose changing that constructor signature,
and a new transport implementation should never need to. `ByteSink` is
already the minimal outbound contract — one method, no return value, no
transport-specific options leaking in. Any richer transport behavior
(connect, disconnect, error) belongs one layer up, in whatever
constructs the `ByteSink` and wires it to a role instance — not inside
the roles themselves. Keeping `RemoteBoard`/`RemoteTerminal` ignorant of
which transport they're running over is precisely what already let the
loopback test swap WebSerial out for a function call with zero changes to
either role's code; a formal `Transport` layer must preserve that, not
erode it by threading transport concerns into the roles.

### 2.2 What's missing today: inbound delivery and lifecycle

Right now, "inbound delivery" means: whoever owns the transport calls
`.receiveBytes(bytes)` on the role instance directly, whenever bytes show
up, by whatever mechanism that transport uses to notice bytes have
arrived. That's fine as an internal detail, but it's not written down
anywhere as a contract a new transport author can implement against
without reading `remote-terminal-loopback.test.ts` first.

Proposed shape — a `Transport` interface, implemented once per transport,
constructed by whatever glue code owns a `RemoteBoard`/`RemoteTerminal`
instance (`app.ts`'s eventual `connectToRemote()`, per
`REMOTE-TERMINAL.md` §7, is the concrete example on the terminal side):

```ts
export interface Transport extends ByteSink {
  /** Begin connecting. Resolves once the transport is ready to carry
   *  bytes — not once a HELLO/HELLO_ACK has happened, which is a
   *  protocol-level concern the roles already own (§8 step 1-2). */
  connect(): Promise<void>;

  /** Bytes that arrived from the far end, in order, exactly as received —
   *  never re-chunked to message boundaries even if the transport is
   *  itself message-oriented (§3.1). The owner's only job with this
   *  callback is forwarding straight into `role.receiveBytes(bytes)`. */
  onData(callback: (bytes: Uint8Array) => void): void;

  /** Fires exactly once per connection, whether the cause was a real
   *  unplug, an explicit `disconnect()` call, or a transport-level error
   *  — REMOTE-TERMINAL.md §6 deliberately treats all three identically
   *  ("the cable got unplugged" and "the board rebooted mid-session" are
   *  the same recovery path). The owner's only correct response, for
   *  every transport, is §6's: tear down the session state and require a
   *  fresh HELLO on the next connect. A transport must never invent its
   *  own partial-recovery signal here (e.g. "temporarily unreachable,
   *  keep state") — see §5, item 1. */
  onDisconnect(callback: (reason?: unknown) => void): void;

  /** Explicit, user-initiated teardown (§6: "requires an explicit
   *  user-initiated reconnect... no silent background reconnect
   *  polling"). Must trigger the same `onDisconnect` callback as an
   *  unplug, not a separate code path. */
  disconnect(): Promise<void>;
}
```

This is additive, not a replacement: `RemoteBoard`/`RemoteTerminal` still
only see the `ByteSink` half of it. The `connect`/`onData`/`onDisconnect`/
`disconnect` half is consumed entirely by the owning glue code, which is
also where §5's checksum-mismatch resync (`FrameDecoder`, already
transport-independent) and the "waiting for HELLO" reset-on-reconnect
state (§6) already have to live regardless of transport.

### 2.3 What every transport implementation must guarantee

Independent of which concrete transport §4 below is about:

- **Byte order and content pass through unmodified.** A `Transport` is a
  pipe, never a re-encoder. It must not translate, buffer-and-coalesce
  past OS/API-level chunking, or reframe bytes — `FrameDecoder` already
  handles arbitrary chunk boundaries (`remote-terminal-protocol.ts:221-
  232`), so a transport has nothing to gain and correctness to lose by
  doing its own buffering logic.
- **No transport may swallow the `SYNC` byte's meaning.** Some
  transports (§4.3, §4.4) already deliver discrete, framed messages
  rather than a raw byte stream. Even then, run every message's bytes
  through the same `FrameDecoder`/`encodeFrame` path unmodified rather
  than skipping §3's framing "because this transport already frames
  things" — see §3 below for why.
- **Disconnect is always total, never partial.** §2.2's `onDisconnect`
  contract applies uniformly; a transport must not offer a "reconnect
  and resume" mode that skips a fresh `HELLO` (§6, §10 item 2 in
  REMOTE-TERMINAL.md — resume-without-full-redraw is explicitly still
  open, for every transport, not solved by picking a better one).
- **Connection authorization is a per-transport concern the contract
  doesn't standardize.** WebSerial's `requestPort()` picker is itself an
  adequate authorization step for a physically-plugged device — a user
  had to be sitting at the machine to grant it. A transport that isn't
  gated by physical presence (§4.5) needs its own answer to "should this
  board accept this connection," and `Transport.connect()` is where that
  answers gets decided — but this document doesn't design one, per §4.5.

---

## 3. Why the wire protocol itself must never vary by transport

Stated plainly, because it's the one rule most likely to get relitigated
by whoever builds the second transport: **§3/§4's framing, checksum, and
message catalog run unchanged over every transport, including ones that
already provide their own message boundaries (WebSocket, BLE
notifications).** Concretely, a `PLOT_CHAR` still goes out as a full
`0xA5`-prefixed, checksummed frame even inside a single WebSocket binary
message, even though the WebSocket layer below it already knows exactly
where that message starts and ends.

This looks redundant on a message-oriented transport, and it is — a few
bytes of overhead that a transport-specific encoding could shave off.
The reason to keep it anyway: **one wire protocol implementation, tested
once.** `remote-terminal-protocol.ts` is the only place `PLOT_CHAR`'s 13-
byte layout is encoded or decoded anywhere in this codebase, and
`remote-terminal-loopback.test.ts` is the only place that encoding is
exercised. A transport that reframes messages in its own way (skip
`SYNC`/checksum because "WebSocket already frames this") creates a
second, untested encoding path per transport added, and turns "does
`PLOT_CHAR` still work" into a question with as many answers as there are
transports. §9's cross-target message-ID drift risk (`REMOTE-TERMINAL.md`,
"two codebases evolving independently") is exactly the failure mode a
second encoding path would reproduce a second time, inside one codebase,
for no bandwidth win worth naming — §4's per-transport notes flag actual
bandwidth-relevant limits (BLE MTU, §4.4) separately, and none of them
are solved by dropping the checksum.

---

## 4. Transport survey

Each entry below states what exists today, what a `Transport`
implementation for it looks like, and its real tradeoffs — named, not
glossed over, per this project's own stated preference for calling out
counter-arguments rather than silently deciding past them
(`REMOTE-TERMINAL.md` §3 does exactly this for binary-vs-text framing;
this section does the same for transport choice).

### 4.1 In-process loopback (built)

What `remote-terminal-loopback.test.ts` already is: a `Transport` whose
`writeBytes()` calls the other role's `receiveBytes()` directly, no
serialization boundary at all. Not a stand-in for a "real" transport in
the sense of being incomplete — it's the correct, permanent transport for
testing the protocol itself, and for `packages/app`'s `TERMINAL` word
(`REMOTE-TERMINAL.md` §0), which connects a real running REPL session to
an in-process simulated board specifically so no real hardware or serial
port is needed to exercise remote-terminal mode end to end. Reference
implementation for what a minimal `Transport` looks like; every other
transport in this section is validated against producing the same
observable behavior this one already does.

### 4.2 WebSerial ↔ USB CDC ACM (specced, unbuilt)

Already fully specced in `REMOTE-TERMINAL.md` §2/§7/§8 — nothing to add
to the wire-level design here. In `Transport` terms: `connect()` wraps
`navigator.serial.requestPort()` + `port.open()`; `onData` wraps the
`ReadableStream`'s `read()` loop (§7's "drive directly off the WebSerial
`ReadableStream`'s own `read()` loop" guidance already anticipates this);
`onDisconnect` wraps both the `SerialPort` `disconnect` event and
`read()`/`write()` promise rejection (§6, already named as the two real
unplug signals this transport surfaces). One-board-one-session scope
(§2) carries over unchanged. Chrome/Chromium-only remains this
transport's real limitation, not something a `Transport` wrapper can
paper over.

### 4.3 WebSocket to a local bridge process (unbuilt, not scheduled)

Not specced anywhere yet, and not proposed for building now — named here
because it's the natural answer to two gaps WebSerial can't close by
itself:

- **Non-Chrome browsers.** WebSerial has no equivalent in Firefox or
  Safari. A small local bridge process (owning the real serial port or
  UART itself, in whatever language) exposing a WebSocket that Rebel-Sim
  connects to from any browser sidesteps that entirely — at the cost of
  requiring a separately-running process instead of a direct browser-to-
  device connection.
- **The headless Rebel firmware target** (`CLAUDE.md`'s target list:
  "UART-channel-driven, no display/keyboard... does not exist in code
  yet"). If that target's UART isn't exposed as a browser-visible USB CDC
  device at all (e.g. it's a bare GPIO UART, or the host machine running
  Rebel-Sim isn't the machine physically wired to it), a bridge process
  is the only way to reach it from a browser regardless of WebSerial
  support.

`Transport` mapping is direct: a `WebSocket`'s `send()`/`onmessage` are
`writeBytes`/`onData`; `onclose`/`onerror` are `onDisconnect`. §3's rule
still applies in full — bytes crossing the WebSocket are still full
`SYNC`-framed protocol frames, not a parallel JSON or length-prefixed
encoding, even though WebSocket messages are already discrete.

**Named tradeoff, not solved here:** unlike a physically-plugged USB
cable, a WebSocket endpoint is reachable by anything that can reach the
bridge process's host and port — `navigator.serial.requestPort()`'s
implicit "a person is sitting at this machine" authorization has no
equivalent here. §5 item 3 names this as genuinely unsolved; a real
implementation must not skip past it by assuming localhost-only is
automatically safe (a browser running on the same machine as an
attacker-controlled webpage can still reach `ws://localhost:PORT`).

### 4.4 Web Bluetooth / BLE (unexplored, real unknowns named)

Not specced, not validated against any real numbers — named here as a
candidate specifically because the RP2350 target line (Rebel Machine
MkI, headless firmware) is battery/portable-adjacent hardware where a
wireless link is a plausible eventual ask, not because anything today
points at building it next.

Two real, unresolved constraints worth naming rather than discovering
mid-implementation:

- **MTU.** A BLE GATT characteristic write/notification is commonly
  capped well under 20 bytes unless both sides negotiate a larger MTU.
  `PLOT_CHAR`'s full frame is 17 bytes (13-byte payload + 4-byte
  overhead, §3) — it likely fits inside a default-MTU notification, but
  barely, and with zero margin for any future message added to the
  catalog. This needs measuring against a real BLE stack, not assumed.
- **Packetization is still a raw byte pipe, not a message boundary
  guarantee.** BLE notifications are discrete at the API level the same
  way WebSocket messages are, but §3's rule still applies — frames still
  carry their own `SYNC`/checksum, and a `Transport`'s `onData` must
  still hand raw bytes to the same `FrameDecoder`, never assume "one
  notification == one complete frame" as an invariant to skip resync
  logic on.

No `Transport` sketch is given for this one, deliberately — the MTU
question needs answering against real hardware/OS behavior before an
interface sketch would mean anything.

### 4.5 What's explicitly not surveyed here

Raw UART access from a headless-firmware-side daemon, USB HID, WebUSB,
and any wired transport not USB-CDC-shaped are all real possibilities
this document doesn't rule in or out — they're firmware/bridge-process
concerns more than Rebel-Sim-side ones (a browser tab has no way to open
a raw UART or arbitrary USB endpoint without WebSerial/WebUSB regardless
of what this document says), and per §0 this document doesn't schedule
transport work, only contracts for it.

---

## 5. Checklist for implementing a new transport

1. Implement `Transport` (§2.2) — `writeBytes`, `onData`, `onDisconnect`,
   `connect`, `disconnect`. Do not add methods beyond these to be
   consumed by `RemoteBoard`/`RemoteTerminal` directly; anything
   transport-specific stays behind this interface, consumed only by the
   glue code that owns it (§2.1).
2. Never re-frame, re-encode, or skip §3/§4's wire protocol because the
   transport already provides message boundaries or its own integrity
   check. Run every byte through `encodeFrame`/`FrameDecoder` exactly as
   the loopback transport does.
3. Treat every disconnect cause (explicit, unplug, error) identically:
   one `onDisconnect` firing, full session teardown, fresh `HELLO`
   required on the next `connect()` (§6). Do not build a resume-without-
   `HELLO` path for a specific transport — that's REMOTE-TERMINAL.md §10
   item 2's open question, unsolved for every transport equally, not a
   place for one transport to quietly get ahead of the others.
4. State the transport's real per-message overhead/limits explicitly if
   they're anywhere close to binding (§4.4's BLE MTU is the concrete
   example) rather than assuming §3's fixed frame sizes always have
   headroom.
5. Name this transport's connection-authorization model explicitly,
   even if the answer is "physical presence, same as WebSerial's picker"
   — don't leave it implicit for a transport where that assumption
   doesn't hold (§4.3).

---

## 6. Open questions (extends `REMOTE-TERMINAL.md` §10, doesn't duplicate)

1. **Security/authorization model for non-physical-presence transports**
   (§4.3's WebSocket bridge, and any future network-reachable transport)
   — named in §2.3 and §4.3, not designed. A real implementation needs an
   explicit answer before it ships, not an assumption that "it's only
   localhost."
2. **BLE MTU/throughput viability** (§4.4) — unmeasured against real
   hardware; this document only names the risk.
3. **Multi-transport failover or coexistence** (e.g. falling back from
   WebSerial to a WebSocket bridge for the same board) — not designed,
   and not obviously needed until a concrete scenario asks for it.
4. **Where `Transport` construction actually lives in `app.ts`** — this
   document proposes the interface (§2.2) but not its concrete wiring
   into `connectToRemote()`; that's implementation work for whoever
   builds the first non-loopback transport, informed by
   `REMOTE-TERMINAL.md` §7's existing guidance on that function.
