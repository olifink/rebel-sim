# 01 — Hardware Abstraction Layer (HAL) Specification

**Version 1.0.** See `00-OVERVIEW.md` for normative-language definitions,
suite scope, and the portable-logic/per-target-boundary distinction this
document relies on throughout.

## 1. Purpose and scope

This document specifies the boundary between the portable Rebel Forth
system and any one target it runs on. It answers exactly one question,
subsystem by subsystem: **what is the minimum set of functions a new
target must implement, and what is already portable and must never be
reimplemented per target?**

It does not specify:

- Memory/arena/bank/cell layout (`02-MEMORY-MODEL.md`).
- Sysvar byte offsets and encoding (`03-SYSVARS.md`) — this document
  names which sysvar fields exist and what they mean where a subsystem's
  behavior depends on one, but the authoritative layout lives there.
- The Forth primitive word set, dictionary format, or exception/error
  *codes* (`04-FORTH-CORE.md`) — this document specifies only the final
  HAL-level reporting sink an error routes through, not the Forth-level
  mechanism that decides when to use it.
- Anything about a specific CPU, board, or toolchain.

## 2. General conventions

These apply to every HAL function defined below, not restated per
subsystem.

### 2.1 No raw memory addresses cross this boundary

HAL functions **MUST NOT** take or return raw arena addresses, bank
offsets, or pointers into Forth-addressable memory. Every parameter is a
plain scalar (an index, a code, a color value, a byte buffer, a path
string) or an opaque byte array the caller already extracted from
memory. This is deliberate: a target's HAL implementation has **zero**
required dependency on the memory model. A HAL author should be able to
implement this entire document without reading `02-MEMORY-MODEL.md`.

The portable layer above the HAL is what reads Forth-addressable memory
(e.g. the `CHAR` bank) and hands the HAL plain values.

### 2.2 Non-blocking by default; blocking is a layer built on top

Every HAL read primitive in this document — keyboard/input, the channel
abstraction — **MUST** be non-blocking: query-or-pop, return immediately,
never wait. Where the Forth system needs blocking behavior (a blocking
`KEY`), it is built as a *layer above* a non-blocking primitive (§5),
never by making a HAL-level read itself block. This keeps every target's
HAL implementation simple and keeps the blocking/suspend mechanism —
which is genuinely target-specific (an RTOS task wait, a JS generator
yield, a bare busy-poll main loop) — isolated to one place instead of
smeared through every I/O primitive.

The one deliberate exception is Storage (§6), which is inherently
asynchronous on most real targets (filesystem/USB/flash access) and is
scoped narrowly to project open/close boundaries specifically so this
exception never touches the interpreter's hot path.

### 2.3 Boolean convention

Any HAL function whose result ends up on the Forth data stack or written
into a sysvar cell **MUST** use `TRUE = -1` (all bits set at the
implementation's cell width), `FALSE = 0` — never C-style `1`/`0`. This
matters the moment such a value is combined with `AND`/`OR`/`INVERT` in
Forth source; converting at the HAL boundary avoids a translation step
at every call site. A HAL function whose result is consumed only by
target-internal C/C++/assembly code, never exposed as a cell value, MAY
use ordinary boolean semantics.

### 2.4 Direction of control: two shapes, not one

This document uses two distinct relationships, and is explicit about
which applies to each function:

- **Type A — the portable layer calls out.** The genuine per-target HAL:
  functions a target implements, that portable code calls when it needs
  something only target-specific code can do (paint a pixel, read a
  file, report elapsed time).
- **Type B — target code calls in.** An entry point the portable layer
  exposes, that target-specific driver code (an interrupt handler, a USB
  HID stack, a DOM event listener, a GPIO matrix scanner) calls when a
  real-world event happens. The portable layer owns everything from that
  call onward.

Conflating these is the single most common way a port ends up
reimplementing logic that was supposed to be shared. Keyboard input
(§4) is entirely Type B once raw events start arriving — there is
almost no Type A surface there at all, which surprises implementations
coming from a design where "the input HAL" is imagined as a set of
outbound calls.

### 2.5 Capability gating, not target branching

Where this document marks a HAL surface OPTIONAL (e.g. raw pixel draw
operations, hot-plug storage state), a conformant target SHOULD expose a
corresponding capability sysvar (`03-SYSVARS.md`) so portable Forth
source can detect the capability at runtime — `IF` on a flag — rather
than requiring a compile-time source variant per target. Forth source
must never need to know *which* target it's running on, only *what that
target can do*.

---

## 3. Screen

### 3.1 Model

One framebuffer, always graphics-capable in principle — never a
DOM/terminal-text UI modeled as its own thing. Text output is a
character grid (tag `CHAR` — `02-MEMORY-MODEL.md`) that write-throughs
into the framebuffer on every write, mirrored one-directionally: the
`CHAR` grid is always sufficient on its own to redraw the visible text
state (used for cursor-highlight redraws, §3.5), but the framebuffer is
never read back into `CHAR`.

### 3.2 Portable Screen Module (implement once, share everywhere)

The following is bit-for-bit identical logic on every conformant
target, built once against the four required HAL functions in §3.3.
**Do not reimplement it per target.**

- Owns the `CHAR` bank and the cursor position (`CORE` sysvar group,
  `03-SYSVARS.md`): `CURSOR-X`/`CURSOR-Y`.
- `write_char(col, row, char_code, ink, paper)` — bounds-checked write:
  out-of-range coordinates are **silently ignored**, no error. In range:
  writes the byte into `CHAR`, then calls `hal_blit_glyph` (§3.3).
- `read_char(col, row)` — bounds-checked read: out-of-range returns
  ASCII space (0x20), matching `write_char`'s silent-ignore convention
  rather than an error path. In range: reads straight from `CHAR`, never
  touches the framebuffer.
- `emit(char_code)` — the classic stream `EMIT`. `\r` (0x0D) moves the
  cursor to column 0 of the current row. `\n` (0x0A) moves to column 0
  of the next row, wrapping row to 0 at the bottom (see next bullet).
  Neither is written as a glyph. Any other byte is written at the
  current cursor position via `write_char` (using the current
  `INK`/`PAPER` sysvars) and advances the cursor.
- **Cursor advance is wrap-only — there is no scroll.** Advancing past
  the last column moves to column 0 of the next row; advancing past the
  last row wraps back to row 0, silently overwriting whatever was
  already there. A target implementer expecting classic terminal
  scrollback behavior should treat this as a deliberate, settled
  difference, not an oversight.
- `cls()` — fills the entire `CHAR` bank with spaces, calls
  `hal_clear_screen` (§3.3) with the current `PAPER` color, then resets
  the cursor to `(0, 0)`. **Order matters**: clear the framebuffer
  *before* resetting the cursor, not after — resetting first and
  clearing second would paint over a cursor-position redraw the reset
  step triggers, on any target implementing cursor highlighting (§3.5).
- `set_cursor(col, row)` — **no bounds-checking**: an out-of-range
  cursor value self-corrects on the next `emit()` via the wrap logic
  above. This is the single choke-point every cursor-movement path
  (positioned cursor moves, `emit`'s own auto-advance/`\r`/`\n`
  handling) routes through — a target implementing visible-cursor
  redraw (§3.5) hooks in exactly once here, not at every call site that
  might move the cursor.
- `ink`/`paper` accessors read/write the `SCREEN` sysvar group's
  `INK`/`PAPER` fields directly; no HAL involvement.
- `redraw_all()` — repaints every character cell from its already-stored
  `CHAR` content, in row-major order, applying cursor inversion
  (`ink`/`paper` swapped) at the current cursor position if
  `CURSOR-VISIBLE` is set (§3.5) — the whole-grid generalization of
  `redraw_cursor_at` (§3.5), built the same way: **never writes into
  `CHAR`, only reads from it.** Requires no HAL surface beyond
  `hal_blit_glyph`, already in §3.3.

  This exists because every *other* write path in this module
  (`write_char`, and therefore `emit`) keeps `CHAR` and the framebuffer
  synchronized automatically — but nothing stops a target's storage
  layer (`01-HAL.md` §6, e.g. a project restore or a single-bank
  `CHAR` load) or Forth source itself (a direct `C!` into the `CHAR`
  bank, bypassing `write_char` entirely) from overwriting `CHAR` bytes
  without going through it. `redraw_all()` is the portable recovery
  path for exactly that case: resynchronize the framebuffer from
  whatever `CHAR` now actually contains. A conformant target's storage
  module (§6.3.1's `openProject`, and any single-bank load restoring
  `CHAR` specifically) **MUST** call this after overwriting `CHAR`
  directly, for the same reason — and **SHOULD** expose it as an
  ordinary Forth primitive too (a real, cross-target concept — not a
  browser-only convenience), so Forth source that pokes `CHAR` directly
  has its own way to resynchronize without needing a storage operation
  as an excuse to reach it. `02-MEMORY-MODEL.md` §6.2 names the same
  mechanism for a future arena-attach: repointing the shared screen
  surface at a newly-attached arena's own `CHAR` bank and redrawing
  from it is exactly one `redraw_all()` call, not a new mechanism.

### 3.3 Required HAL surface (Type A)

Exactly two functions are required for text output on any
display-capable target:

```c
/* Paints one character cell: fill the cell with `paper`, then draw the
 * glyph's foreground pixels in `ink`. col/row are character-grid
 * coordinates, already bounds-checked by the portable layer before this
 * is called — a HAL implementation MUST NOT need to re-validate them. */
void hal_blit_glyph(uint16_t col, uint16_t row,
                     uint8_t char_code, uint32_t ink, uint32_t paper);

/* Clears the entire display surface to `paper`. */
void hal_clear_screen(uint32_t paper);
```

`ink`/`paper` are opaque color values at this boundary — this document
does not mandate a specific color format (indexed, RGB555, truecolor
0xRRGGBB, …); a target defines its own and documents it. The `SCREEN`
sysvar group's `INK`/`PAPER` fields carry whatever value that target's
HAL expects, unmodified, end to end.

### 3.4 Optional: raw pixel operations

```c
void hal_draw_pixel(uint32_t x, uint32_t y, uint32_t color);
void hal_draw_line(uint32_t x1, uint32_t y1, uint32_t x2, uint32_t y2, uint32_t color);
void hal_draw_rect(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t color);
void hal_draw_rect_outline(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t color);
```

Framebuffer-only — these never touch `CHAR` and have no interaction
with the character grid or cursor. **OPTIONAL**: a target with no
graphics-capable display MAY omit these, or provide no-op stubs, or
route them to a serial diagnostic console instead. Where provided, `x`/
`y` are pixel coordinates, independent of the character-cell grid.

### 3.5 Optional: visible text cursor

A target MAY implement a visible, inverse-video-style text cursor. If
it does:

- Gate it behind the `SCREEN` group's `CURSOR-VISIBLE` sysvar (HAL
  boolean convention, §2.3; default `FALSE`).
- Showing/hiding re-blits the cursor's current cell purely from its
  already-stored `CHAR` content, with `ink`/`paper` swapped when
  visible — **never** writes new content into `CHAR`; this is a redraw,
  not a write. Out-of-range coordinates silently no-op, same convention
  as `write_char`/`read_char`.
- Every cursor-position-changing path funnels through `set_cursor`
  (§3.2) specifically so this hook lives in one place.

No new HAL functions are required for this — it's built entirely from
`hal_blit_glyph` plus the portable `CHAR`-read logic already described.

### 3.6 Sysvar contract — `SCREEN` group

Field *existence and order* is the cross-target contract; exact byte
offsets and encoding are `03-SYSVARS.md`'s responsibility, not this
document's. In order:

| Field | Meaning |
|---|---|
| `SCREEN-WIDTH` | Framebuffer width in pixels. |
| `SCREEN-HEIGHT` | Framebuffer height in pixels. |
| `CHAR-CELL-W` | Glyph cell width in pixels. |
| `CHAR-CELL-H` | Glyph cell height in pixels. |
| `CHAR-COLS` | Character grid width — the addressing stride into `CHAR`. Not recomputed on the fly from `SCREEN-WIDTH`/`CHAR-CELL-W`; stored directly. |
| `CHAR-ROWS` | Character grid height. |
| `INK` | Current foreground color for character writes. |
| `PAPER` | Current background color for character writes. |
| `CURSOR-VISIBLE` | OPTIONAL (§3.5). HAL boolean. Omit the field entirely on a target that never implements a visible cursor, per `03-SYSVARS.md`'s reserved-field convention — do not wire a fixed `FALSE` in its place. |

A target with a fixed, non-indexed truecolor display has no referent
for a color-depth or palette-size field and **MUST** omit them rather
than invent a meaningless constant. A target that genuinely has an
indexed/palette display mode is out of this version's scope (§9) —
raise it against this document rather than inventing a local
extension.

### 3.7 Sysvar contract — `FONT` group

Whether a target has a Forth-addressable font bank at all is target
discretion, not required by this document — `hal_blit_glyph` (§3.3)
stays opaque about *how* a `char_code` resolves to pixels, so a target
whose font stays entirely HAL-side, compiled-in, host-owned state (no
`FONT` bank, no field below) is fully conformant. Rebel-ROM's own font
system is exactly this: compiled-in `TFont` structs chosen once at
boot, no arena-resident bank, no runtime switching yet
(`rebel-rom/docs/FONT-SYSTEM.md` §6).

A target that *does* expose a Forth-addressable font bank — Rebel-Sim
does, as of M59 — **MUST** name the field below, at this position, so a
portable tool (an inspector, a font-editing word) can find it uniformly
on any target that has one at all:

| Field | Meaning |
|---|---|
| `FONT-BASE` | Arena address of the currently-active `FONT`-tagged bank (`02-MEMORY-MODEL.md` §4.6). Switching fonts is repointing this at a different `FONT`-tagged bank — no separate switching mechanism is defined or needed. |

Glyph geometry (cell width/height, first/last character code, bytes per
row) is deliberately not a sysvar here — every target that has shipped
one so far uses a single fixed geometry decided at build time (Rebel-Sim:
8×8, 256 chars, 1 byte/row), so there's no concrete cross-target need to
make it runtime-inspectable yet. Revisit if a target's font ever needs
to vary at runtime.

---

## 4. Keyboard / Input

### 4.1 Model

Inverted relative to Screen: instead of the portable layer calling out
to paint, target-specific driver code calls **in** to push translated
raw events (§2.4, Type B). There is effectively no Type A surface for
keyboard input at all — nearly everything specified here is portable
logic, implemented once.

### 4.2 Required entry point (Type B)

```c
/* Called by target-specific driver code — a USB HID interrupt handler,
 * a DOM keydown/keyup listener, a GPIO matrix scanner, whatever a given
 * target's raw input path is — once per clean press/release edge.
 *
 * `usage_code` is a USB-HID-style usage code (Keyboard/Keypad usage
 * page) for an ordinary key, or a pseudo-code 0x80-0x87 for a modifier
 * (§4.4). `pressed` is true on press, false on release.
 *
 * The caller MUST have already reduced its raw input to clean edges —
 * auto-repeat filtered out, one call per real press and one per real
 * release, not per raw hardware report. If a target's raw input source
 * sends repeated/duplicate reports even when nothing changed (common on
 * some USB keyboards), the target's driver code is responsible for
 * diffing against its own last-seen state before calling this — the
 * portable layer does not do report-diffing, only edge-triggered event
 * handling. */
void keyboard_push_raw_event(uint8_t usage_code, bool pressed);
```

Everything from this call onward — translation, queueing, modifier
tracking — is portable (§4.3).

### 4.3 Portable Keyboard Module (implement once, share everywhere)

- **Event queue**: a ring buffer of translated events,
  RECOMMENDED minimum depth 32 (this models realistic input burst rates,
  not a hard architectural limit — a target MAY use a deeper queue). On
  a full queue, a new event **MUST** be silently dropped — never
  overwrite an unconsumed event, never block the caller.
- **Translated event record** (`KeyEvent`): `usage_code` (raw, always
  present, needed to identify non-printable keys like function keys or
  Caps Lock that have no character), `modifiers` (bitmask snapshot at
  event time, §4.4), `char` (translated character, `0` if this key/state
  has no character meaning), `pressed`.
- **`KMAP` translation table**: a `u8[2][256]` lookup — plane 0
  unshifted, plane 1 shifted, indexed by `usage_code`. Only printable
  keys plus Enter/Backspace/Tab/Space get a non-zero entry in either
  plane; everything else (Caps Lock, function keys, Print Screen,
  arrows, GUI/modifier keys) stays `0` in both planes — identifiable
  only via `usage_code`, never via a translated character. A default
  layout populating this table is portable data, out of this document's
  scope (belongs with `04-FORTH-CORE.md`'s treatment of the `KMAP` bank,
  `02-MEMORY-MODEL.md` for its bank tag/addressing) — but the table
  *shape* (2 planes × 256 entries × 1 byte, indexed by raw usage code)
  is part of this contract, since target driver code needs to know what
  it's feeding usage codes into.
- On press, the queued event's `char` is looked up from the currently
  shifted or unshifted plane (whichever the live modifier state
  indicates, §4.4) at the time of the press — not re-evaluated later.
  On release, `char` is always `0`.
- Non-blocking primitives the Forth system's `KEY?`/`KEY` are ultimately
  built from — **fully portable, MUST NOT be reimplemented per target**:
  - `keyboard_has_event()` — is the raw queue non-empty (does not
    consume).
  - `keyboard_read_event()` — non-blocking pop of the oldest queued
    event; a defined empty-sentinel if the queue is empty.
  - `keyboard_has_translated_event()` — non-destructive scan for a
    queued event with a non-zero `char`, skipping modifier-only/
    unmapped entries. This is what the input-channel abstraction (§5)
    binds to, not the raw queue — an unmapped key has no byte-stream
    representation and must stay invisible to a channel, exactly as it
    already is to `KEY?`.
  - `keyboard_read_translated_char()` — pops and discards events until
    (and including) the next one with a non-zero `char`; returns that
    char, or an empty sentinel once the queue is exhausted without
    finding one. Shares the same physical queue the raw pop uses —
    draining via one is visible to the other, correctly, since there is
    only one real queue.

### 4.4 Modifier convention

Modifier press/release is injected into the *same* raw event stream as
ordinary keys, via a pseudo-usage-code convention, rather than a
separate signal:

- `usage_code` values `0x80`–`0x87` are reserved for modifier edges.
  Bit index = `usage_code − 0x80`.
- Bit layout matches the standard USB HID boot-protocol modifier byte
  exactly, so a target already producing standard HID reports needs no
  remapping:

  | Bit | Modifier |
  |---|---|
  | 0 | Left Ctrl |
  | 1 | Left Shift |
  | 2 | Left Alt |
  | 3 | Left GUI |
  | 4 | Right Ctrl |
  | 5 | Right Shift |
  | 6 | Right Alt |
  | 7 | Right GUI |

- The portable layer maintains a live modifier bitmask, updated on every
  modifier press/release pseudo-event, and mirrors it into the
  `KEYBOARD` sysvar group's `MODIFIERS` field (§4.6) so Forth source can
  read live modifier state directly.
- Only the two Shift bits affect `KMAP` plane selection (§4.3); Ctrl/
  Alt/GUI state is tracked and exposed but does not change character
  translation at this layer — a target or portable word built later MAY
  use it for other purposes (e.g. Ctrl-chord handling), out of this
  document's scope.

### 4.5 Where physical key-matrix translation happens

A target whose raw input is not natively USB-HID-shaped — e.g. a
dedicated keyboard-matrix scanner on a co-processor — is responsible for
translating its own raw matrix events into `(usage_code, pressed)` pairs
**below** this boundary, before calling `keyboard_push_raw_event`. This
interface does not change shape for such a target: the translation is
entirely a target-driver concern, not something this boundary needs a
variant for.

### 4.6 Sysvar contract — `KEYBOARD` group

| Field | Meaning |
|---|---|
| `MODIFIERS` | Live modifier bitmask (§4.4), updated on every modifier edge. |
| `KEYBOARD-COUNT` | OPTIONAL. Count of currently attached input devices, for a target with real hot-pluggable multi-device input (e.g. USB). A target with a fixed, always-present keyboard (a browser host, an onboard matrix) has no referent for hot-plug enumeration and **MUST** omit this field rather than wire in a meaningless constant. |

---

## 5. Input-Channel Abstraction

### 5.1 Purpose

The Forth outer loop's *input* side — specifically, a blocking `KEY` —
binds to a **channel** reference rather than calling a specific input
source directly. This is what lets a second, non-keyboard input source
(a remote/programmatic connection, a UART link on a headless target)
drive the same interpreter session with **zero interpreter-level
change** — the entire reason to introduce this abstraction now rather
than wiring `KEY`/`KEY?` directly to whichever input source exists on
the first target.

### 5.2 Scope: input only

`EMIT`/`TYPE` and all screen output **do not** route through a channel —
they call the Screen HAL (§3) directly, unchanged. Screen is one shared
surface every session writes through; it was never channel-shaped, and
bundling both directions into one abstraction was a real design mistake
caught before anything shipped. Two sessions bound to different input
channels already share the one screen surface today, by construction —
this is a simplification, not a gap needing arbitration.

### 5.3 Interface (fully portable — no new HAL functions)

```c
/* Non-blocking poll — is a byte available right now? */
bool channel_has_data(Channel *ch);

/* Non-blocking pop. Returns a defined empty-sentinel (-1, in a signed
 * return wide enough to hold every valid byte value plus the sentinel)
 * if none ready. A caller needing real blocking checks has_data() first
 * and suspends (§5.5) rather than ever seeing the sentinel in practice. */
int32_t channel_read_byte(Channel *ch);
```

This interface requires **no new per-target HAL functions.** A
`KeyboardChannel` implementation is a thin, fully portable wrapper over
`keyboard_has_translated_event()`/`keyboard_read_translated_char()`
(§4.3) — filtering to translated-char events only, with no new
debounce/edge logic, since the keyboard module already only receives
clean edges. Any target with a conformant Keyboard implementation gets a
working `KeyboardChannel` for free.

### 5.4 Other channel implementations

- A `RemoteChannel` (a programmatic/network-driven input source) is a
  plain FIFO fed from outside the interpreter's normal call path —
  e.g. a management/debug connection pushing characters in. Unlike the
  keyboard's ring buffer, it has no hardware-modeled capacity cap to
  honor.
- A `CompositeChannel` merges multiple channels into one, first-ready-
  wins, scanned in a fixed order each call — letting e.g. keyboard and
  remote input feed the same session with zero interpreter-level
  change.
- Both are OPTIONAL. A target with only a keyboard implements only
  `KeyboardChannel` and binds it directly; nothing above requires more
  than one channel to exist.

### 5.5 Blocking `KEY`, built on top

A blocking Forth `KEY` is implemented as: **suspend the calling task
while `channel_has_data()` is false; resume it once true**, then
perform the non-blocking `channel_read_byte()`. This document does not
mandate *how* a target suspends and resumes — that's inherently
target-specific:

- A cooperative-multitasking target (an RTOS-style scheduler) blocks the
  interpreter task on a synchronization primitive tied to the channel's
  non-empty condition; other tasks (screen diagnostics, input polling
  itself) keep running.
- A hosted target with coroutine/generator support suspends the
  interpreter's step function and resumes it on the next scheduling
  opportunity once data is available.
- A single-tasking bare-metal target with no scheduler at all MAY
  implement this as a busy-poll of `channel_has_data()` inside `KEY`'s
  own loop, provided the ring buffer feeding it is filled by an
  interrupt/DMA path independent of that loop (so input isn't lost while
  polling) — valid, if the target genuinely has nothing else that needs
  to run concurrently.

No `hal_yield()` or equivalent function is defined by this document —
see §8 for why that's a deliberate omission, not a gap.

### 5.6 Session model

One outer-loop instance binds to exactly one input channel. Multiple
simultaneous sessions (e.g. one keyboard-bound, one remote-bound) share
memory banks, sysvars, and device state, and the one screen surface
(§5.2) — this is the default model; whether concurrent sessions ever
need explicit arbitration beyond that is genuinely open (§9), not
designed here because nothing has needed it yet.

---

## 6. Storage

### 6.1 Model: projects and carts, not a raw block device

Storage is organized as named, typed asset files inside two fixed
directories — **not** classic Forth numbered-block device access:

```
/PROJECTS/<name>/     one directory per project, one file per bank asset
/CARTS/<name>.CRT      one flat baked binary per cart (opaque, no header)
```

A project's asset file's extension declares its bank tag, and its
basename **is** the bank's own name — there is no separate mapping to
keep in sync between "what a bank is called" and "what file represents
it."

### 6.2 Required HAL surface (Type A)

Exactly five functions, all inherently asynchronous on most real
targets (filesystem, USB mass storage, flash) — the **only** part of
this entire specification permitted to take non-trivial wall-clock
time, and scoped narrowly so that permission never leaks into the
interpreter's hot path (§2.2):

```c
/* Idempotent: MUST NOT fail or error if the directory already exists. */
void hal_ensure_dir(const char *path);

/* Filenames only, not subdirectories. Empty result if the directory
 * doesn't exist — not an error. */
string_list hal_list_files(const char *path);

/* Subdirectory names only, one level deep, not filenames — the
 * "which projects exist" question hal_list_files alone can't answer,
 * since /PROJECTS/ itself holds one subdirectory per project, not
 * asset files directly. Bare names, not full paths (matching
 * hal_list_files' own convention). Empty result if the directory
 * doesn't exist — not an error. */
string_list hal_list_dirs(const char *path);

/* Full file contents, or an empty/undefined result if the file doesn't
 * exist — not an error. */
byte_buffer hal_read_file(const char *path);

void hal_write_file(const char *path, const uint8_t *bytes, size_t len);
```

Paths are POSIX-style, always absolute, e.g.
`/PROJECTS/REBELDEF/00000000.DAT`. These five functions **MUST** only
ever be called from a project open/close orchestration point (or
equivalent explicit save/load action), never from inside a running
Forth word's own execution — nothing in the portable storage model
below is (or should become) a synchronous Forth primitive.

### 6.3 Portable Storage Module (implement once, share everywhere)

- **Asset file header**: 6 bytes precede the payload in every project
  asset file — 2 magic bytes (`'R'`, `'A'`), then a 4-character ASCII
  tag (NUL-padded if the tag is logically shorter than 4 characters).
  A short or missing read **MUST** abort loading that one file (skip
  it, continue scanning). A magic/tag mismatch against what the file
  extension implies SHOULD be logged as a diagnostic but **MUST NOT**
  abort the load — the extension remains the authoritative signal for
  which tag/bank type to create, the header is a sanity net only.
- **Tag ↔ extension table** — this is part of the cross-target
  contract; any conformant target's implementation **MUST** use the
  same mapping so a project round-trips asset-for-asset between
  different targets' implementations:

  | Bank tag | Extension |
  |---|---|
  | `SCRN` | `.SCR` |
  | `FONT` | `.FNT` |
  | `SPRT` | `.SPR` |
  | `DICT` | `.DCT` |
  | `DATA` | `.DAT` |
  | `CHAR` | `.CHR` |
  | `KMAP` | `.KMP` |
  | `SYSV` | `.SYS` |
  | `DSTK` | `.DST` |
  | `RSTK` | `.RST` |
  | `MMAP` | `.MAP` |
  | `WORK` | `.WRK` |
  | `BLKS` | `.BLK` |

  Every bank tag a conformant target's memory model defines
  (`02-MEMORY-MODEL.md`) gets an entry here — this specification does
  not special-case any tag out of the persistence mechanism. Three
  groups, by what persisting them actually buys:

  - `SCRN`/`FONT`/`SPRT`/`DICT`/`DATA`/`BLKS` — ordinary content assets.
  - `CHAR`/`KMAP`/`SYSV`/`DSTK`/`RSTK` — live session state. Together
    with `MMAP` (below), these are what make §8's state-portability
    claim (`FORTH-ARCHITECTURE.md` — pause a session, dump it, resume
    identically on another conformant target) an actual save/load path
    rather than a theoretical one.
  - `MMAP`/`WORK` — see below. Included for uniformity of the
    mechanism, not because their content is normally meaningful to
    reload.

  A target's save-project action MAY choose to persist any subset of
  the non-`MMAP` tags (e.g. content banks only, leaving execution state
  to always reset on load) — this table only fixes what a given tag is
  called on disk *if* a target chooses to persist it, not which subset
  it must. `MMAP` is the one exception with its own rule, §6.3.1.

  A target adding a new asset-bearing bank tag not in this table
  **MUST** choose and document a new extension consistent with this
  table's convention (a distinct, uppercase, 3-4 character extension)
  and raise it against this document rather than inventing a silent
  local convention no other target can read.

  **On `WORK`:** transient, in-flight working state — the Terminal
  Input Buffer sub-region is the resident line buffer `ACCEPT` reads a
  REPL line into; the `PAD` sub-region is unconditionally overwritten
  by the next use with no reentrancy guarantee, so a reloaded copy is
  stale the moment anything real runs. Both share this one bank at
  fixed sub-offsets, not two independent banks — each is small enough
  that giving them separate size-class allocations would waste a whole
  extra class on padding alone (`02-MEMORY-MODEL.md` §4.3/§4.6).
  Persisting `WORK` anyway is deliberate: excluding it from an
  otherwise-generic "any bank can be saved as an asset" mechanism would
  turn this into a per-tag persistence allowlist the mechanism itself
  has to know about, for a safety problem that doesn't actually exist —
  reloading stale scratch content is harmless, since its very next real
  use overwrites whatever was restored before any Forth code could
  observe it. A conformant implementation **MUST** treat `WORK` as an
  ordinary persistable bank, identical in handling to any other tag in
  this table.

### 6.3.1 Restoring exact memory layout: `MMAP` must load first

`MMAP` is the arena's own bank table — for every other bank, which
tag/name it has, where it sits, and how large it is. This makes it
different from every other row in the table above: it isn't optional
scaffolding, it's the thing that lets a reload reconstruct the *exact*
original layout — same bases, same size classes, same slot order —
rather than a plausible-looking one freshly re-derived from whichever
files happen to be present and whatever order `hal_list_files` returns
them in. A layout re-derived from content files alone is not guaranteed
to match the original after any sequence of bank creation/reclaim
cycles (`02-MEMORY-MODEL.md`) — `MMAP` is the one artifact that
actually recorded what happened.

**`openProject(name)` is therefore two-phase whenever an `MMAP` asset
file is present:**

1. **Layout restore.** Read and header-validate the `.MAP` file exactly
   like any other asset. Its payload is the serialized bank table
   (exact slot encoding: `02-MEMORY-MODEL.md`) — a fixed-capacity list
   of slots, each recording a tag, a name, a base, a size class, and an
   active flag. For every active slot, reconstruct a bank at that
   slot's **exact recorded base**, not a freshly-allocated one, before
   reading anything else in the project directory.
2. **Content restore.** For every other recognized-extension file: if
   its (tag, basename) matches a slot phase 1 just reconstructed, load
   its payload directly into that bank's already-fixed location
   (zero-pad short payloads up to the slot's recorded size; skip
   oversized ones, same as the size-class-mismatch rule below). If it
   has no match — no `MMAP` file was present at all, or this content
   file isn't represented in the one that was (an older save, or a
   target that only ever persisted a subset) — fall back to creating a
   fresh bank sized from the payload itself, tag from the extension,
   name from the basename: today's baseline behavior, unchanged.

This makes the mechanism fully backward-compatible: a project with no
`MMAP` file behaves exactly as if phase 1 never ran. A target choosing
to persist `MMAP` alongside its content banks (via the same
`saveAsset` path — `MMAP` is a bank like any other on the save side,
no special ordering requirement there, only on load) gets exact-layout
restoration; a target that never does still round-trips correctly, just
without the layout-fidelity guarantee.

- **`listProjects()`**: every name currently under `/PROJECTS/`, via
  `hal_list_dirs`. Read-only — touches no arena/bank state, unlike
  `openProject` — the "what's actually saved" question neither
  `openProject` nor `saveAsset` alone can answer without already
  knowing a name to ask about (`04-FORTH-CORE.md`'s `PROJECTS` word).
- **`openProject(name)`**: implements §6.3.1's two-phase algorithm.
  Lists `/PROJECTS/<name>/`; if an `MMAP` asset is present, restores
  the exact bank table first, then loads matching content into the
  fixed locations it just established; any remaining recognized file
  not covered by that falls back to being created fresh, sized from its
  own payload, named from its own basename (uppercased). A file with an
  unrecognized extension is silently skipped — not an error for the
  whole open. A payload too large for the size class it would occupy
  (whether recorded by a restored slot or freshly rounded up per
  `02-MEMORY-MODEL.md`) is also skipped, not fatal to the rest of the
  open. Returns every bank it created or restored.
- **`saveAsset(project, bank)`**: writes one bank out as a project asset
  file — `hal_ensure_dir`-ing the project directory first (§6.2's
  idempotence requirement matters here: this must not fail just because
  the project already exists). The bank's own name becomes the file's
  basename; its tag maps to the extension via the table above. A target
  wanting exact-layout round-trips SHOULD `saveAsset` the arena's own
  `MMAP` bank alongside whatever content banks it saves — nothing else
  about `saveAsset` changes to do this; `MMAP` is written the same way
  as any other bank.
- **`loadCart(name)` / `saveCart(name, bytes)`**: opaque single-file
  binary I/O against `/CARTS/<name>.CRT` — read this one file in, write
  this one file out, no header, no bank creation. A cart's internal
  layout is `04-FORTH-CORE.md` territory (or later), not this document's.

### 6.4 Interoperability requirement

A project saved by one conformant target's implementation **MUST** be
loadable by any other conformant target's implementation. The asset
file format (header, tag/extension table, directory convention) is
part of this specification, not an implementation detail any one target
is free to vary. Where a saved project includes an `MMAP` asset, this
extends to exact layout: the reconstructed bank table's bases, size
classes, and slot order **MUST** match the originating target's exactly,
per §6.3.1's load order — a receiving target that instead re-derives a
plausible-looking layout from content files alone (ignoring a present
`MMAP` asset) is non-conformant, even if every individual bank's content
happens to load correctly.

### 6.5 Optional: generic block storage (`BLKS`)

`hal_block_read(n)`/`hal_block_write(n)` are **not** a raw
numbered-block device call under this model. They are redefined as
ordinary reads/writes of 1024 bytes at offset `n * 1024` within a
resident bank of tag `BLKS` (**[Renamed, 2026-08-18]** was `SCRS`;
distinct from `SCRN`, the framebuffer tag — do not confuse the two),
persisted through the ordinary asset pipeline above like any other
bank.

`BLKS` is a **generic block buffer**, addressable only at 1024-byte
granularity — it carries no assumption about what's stored in a given
block. Classic 1024-byte Forth "screens" (source-editing text, the
motivating use case this section was originally scoped around, and
still its first real consumer) are one use of it, but nothing about the
bank itself is screen- or text-specific; any block-structured data a
target wants to address this way is equally valid content.

Still **OPTIONAL** at the HAL level — a target with no need for
block-structured storage may simply not implement
`hal_block_read`/`hal_block_write` at all. **[Updated] Rebel-Sim now
has a real write path**: the portable Forth-level `BLOCK`/`BUFFER`/
`UPDATE`/`FLUSH` buffer pool (`system.fth`) is built entirely on top of
`(BLOCK-READ)`/`(BLOCK-WRITE)` (`primitives.ts` tokens 140/141), and a
full Screen Editor (`LOAD`/`LIST`/`L`/`T`/`TOP`/`CLEAR`, `EDITOR`
vocabulary) is built on top of *that* — genuinely exercised, not
theoretical. `rebel-rom` has no Forth executor yet, so it remains
unexercised there; this paragraph no longer generalizes to "no target,"
only to targets without a self-hosted outer interpreter at all yet.
`BLKS`'s extension (`.BLK`, §6.3's table) **is** assigned, ahead of a
conformant target actually needing it — worth stating explicitly since
§6.3's own rule normally has a target choose and document an extension
only once it exists.

A screen/block editor built on `BLKS` displays a block's contents by
copying its bytes into `CHAR` in bulk (one `BLKS` block's worth of text
`CMOVE`'d into the visible grid for editing) rather than one character
at a time through `emit`/`write_char` — exactly the case §3.2's
`redraw_all()` exists for; Rebel-Sim's own editor does exactly this
(`LIST`, `system.fth`), confirming the pattern predicted below rather
than needing anything new: copy the block's bytes into `CHAR`, then
call `redraw_all()` (or its Forth-level `REDRAW`) once to resynchronize
the framebuffer, the same pattern the storage module already uses for
a project restore.

### 6.6 Sysvar contract — `STORAGE` group

| Field | Meaning |
|---|---|
| `MOUNTED` | OPTIONAL. `1`/`0` (see below) — storage media currently mounted, for a target with real hot-pluggable storage (USB mass storage). |
| `LAST-ERROR` | OPTIONAL. Last underlying filesystem error code, `0` when clean. |
| `DEVICE-SEEN` | OPTIONAL. `1`/`0` — whether a storage device has been detected at least once since boot, for a target with hot-plug detection. |

All three fields are **target-gated, not universal** (§2.5). A target
whose storage is always synchronously available once granted (onboard
flash, a browser-hosted virtual filesystem) has no hot-plug/mount cycle
to report and **MUST** omit these fields entirely, per
`03-SYSVARS.md`'s reserved-field convention, rather than wiring in a
fixed "always mounted" constant. Note these three fields, where present,
are plain diagnostic scalars a subsystem sets — not the HAL boolean
convention (§2.3), since they are not currently read by Forth control
flow; a target is free to treat them as ordinary `0`/`1` C values.

---

## 7. Timing

### 7.1 Required HAL surface (Type A)

```c
/* Monotonic milliseconds since an arbitrary epoch (typically boot).
 * MUST be monotonic for the lifetime of one session. MAY wrap at the
 * implementation's return-width boundary (a uint32_t implementation
 * wraps at ~49.7 days) — callers doing elapsed-time math MUST use
 * unsigned-subtraction wraparound-safe comparisons, not direct
 * greater-than comparisons against an absolute value. */
uint32_t hal_millis(void);
```

This is the entire timing HAL. No delay/sleep function is specified —
a target building a `DELAY`-style Forth word does so in the portable
layer, spinning or yielding (§5.5's suspend mechanism, if the target has
one) against `hal_millis()`, not by adding a second HAL primitive for
it.

---

## 8. Error Reporting

### 8.1 Required HAL surface (Type A)

```c
/* Makes a human-readable diagnostic message visible via the target's
 * primary reporting surface — on-screen text, a serial/UART console, or
 * both. MUST NOT crash, hang, or perform dynamic allocation; MUST be
 * safe to call from a partially-failed interpreter state (this is the
 * function an uncaught error/ABORT path calls on its way to a clean
 * prompt). MUST be safe to call reentrantly. */
void hal_report_error(const char *message);
```

This is deliberately the **only** error-related HAL surface. A numeric
exception-code convention (`THROW`/`CATCH`-style codes for stack
underflow, unknown token, divide-by-zero, out-of-range access, …) is
`04-FORTH-CORE.md`'s responsibility — it is a Forth-source-level
mechanism that depends on this HAL function only for how a final,
uncaught error gets *reported*, not for how it's detected or
classified. Do not build a numeric-code parameter into this function in
anticipation of that mechanism; when `04-FORTH-CORE.md` defines it, it
will format its own message and call this function with the result.

---

## 9. Scheduling and cooperative yielding — a design note, not an interface

There is **no `hal_yield()`** or scheduling function in this
specification, deliberately. The requirement is narrow and already
fully stated in §5.5: a target's Forth executor must be able to suspend
while blocked on a channel and resume promptly once data arrives,
without wedging anything else on that target that needs to keep
running concurrently. *How* that's achieved is entirely target-specific
— a cooperative scheduler's task-wait primitive, a generator/coroutine
step function, or (on a genuinely single-tasking target with nothing
else concurrent) a plain busy-poll fed by an independent interrupt path.

Do not add a HAL-level yield function to a target's implementation "for
symmetry" with other subsystems here — if a target's own internal
architecture needs one, it's an internal implementation detail of that
target's executor, not something this cross-target boundary should
standardize, since nothing on the portable side calls out to it.

---

## 10. Explicitly out of scope for this version

Named here so an implementer knows these are deliberately not decided,
rather than assuming an omission is an oversight. Do not design ahead of
these — extend this document when one becomes real and load-bearing
somewhere, not before:

- **Power management.** No sleep/low-power state, no display-dimming
  primitive. Nothing in this suite needs one yet.
- **Multi-arena management exposed to Forth.** Whether/how a target
  supporting more than one arena exposes creating or switching between
  them to Forth source is unresolved on every target that might
  eventually support it. Likely a capability-gated mechanism (§2.5)
  when it lands, not assumed universal.
- **Forth-level bank introspection/creation** (`BANK@`, `BANK-SIZE`,
  `CREATE-BANK`). These exist as ordinary Forth primitives — looking up
  a bank's base address/size by name (`02-MEMORY-MODEL.md` §4.7 —
  `name` is the real, uniqueness-backed identity; `tag` is expected to
  repeat), and carving a new one at runtime — and need no new HAL
  surface at all: both operate purely on the arena-resident bank table
  (`02-MEMORY-MODEL.md`), never crossing this boundary. Full
  primitive semantics are `04-FORTH-CORE.md`'s job, not this
  document's; noted here only so their absence from every list above
  isn't mistaken for an oversight.
- **`SPRITE` sysvar group and any HAL surface for it.** No target has a
  Forth-addressable sprite bank yet. (`FONT` is no longer deferred — see
  §3.7, added M59 once Rebel-Sim actually had one.)
- **Per-channel-type configuration** (§5). A future non-keyboard channel
  with real configuration needs — a radio link's frequency/spreading-
  factor parameters, for instance — will need somewhere to hold that
  configuration. No shape is decided; the likely fit (a dedicated
  configuration bank, analogous to `KMAP`) is not designed here. Revisit
  when a first concrete such channel is actually being built.
- **A unified cross-subsystem error-code convention.** Whether
  `STORAGE`'s `LAST-ERROR` (§6.6) and any future subsystem-specific
  error fields should ever be unified with the Forth-level exception
  mechanism (§8.1's note) into one convention, or stay genuinely
  per-subsystem, is undecided. `04-FORTH-CORE.md`'s job, not this
  document's.

---

## 11. Conformance checklist

| Function | Direction | Requirement | Subsystem |
|---|---|---|---|
| `hal_blit_glyph` | A (target implements) | **REQUIRED** if display-capable | Screen §3.3 |
| `hal_clear_screen` | A | **REQUIRED** if display-capable | Screen §3.3 |
| `hal_draw_pixel`/`line`/`rect`/`rect_outline` | A | OPTIONAL | Screen §3.4 |
| `keyboard_push_raw_event` | B (target calls in) | **REQUIRED** if input-capable | Keyboard §4.2 |
| `keyboard_has_event` / `keyboard_read_event` | portable | n/a — never reimplement | Keyboard §4.3 |
| `keyboard_has_translated_event` / `keyboard_read_translated_char` | portable | n/a — never reimplement | Keyboard §4.3 |
| `channel_has_data` / `channel_read_byte` | portable | n/a — never reimplement | Channel §5.3 |
| `redraw_all` | portable | n/a — never reimplement; storage MUST call it after any direct `CHAR` overwrite | Screen §3.2 |
| `hal_ensure_dir` | A | **REQUIRED** if storage-capable | Storage §6.2 |
| `hal_list_files` | A | **REQUIRED** if storage-capable | Storage §6.2 |
| `hal_list_dirs` | A | **REQUIRED** if storage-capable | Storage §6.2 |
| `hal_read_file` | A | **REQUIRED** if storage-capable | Storage §6.2 |
| `hal_write_file` | A | **REQUIRED** if storage-capable | Storage §6.2 |
| `hal_millis` | A | **REQUIRED** | Timing §7.1 |
| `hal_report_error` | A | **REQUIRED** | Error §8.1 |

A target that is genuinely display-less, input-less, or storage-less
(e.g. a headless UART-driven build) is not in violation for omitting
that subsystem's REQUIRED row — but SHOULD advertise the omission via a
capability sysvar (§2.5) rather than leaving portable Forth source no
way to detect it at runtime.
