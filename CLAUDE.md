# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

**This section is stale** — it describes the repo's pre-code state.
Implementation is now underway (npm workspace, `packages/engine`,
`packages/app`); see `PLAN.md` for the milestone log and `IMPLEMENTATION.md`
for how the engine actually works. This file's build/lint/test guidance
below has not yet been refreshed to match — verify against `package.json`
scripts before relying on it.

## What this project is

**Rebel-Sim** is the browser-based (TypeScript/Angular) simulator for
**Rebel**, a bare-metal "keyboard computer." It's one implementation in
a growing family of targets that must all run **identical Forth source**
at the word-definition level — `HAL.md` (repo root) has the concrete,
code-level breakdown of the family and how far each one has actually
gotten; this list is the short version, and `HAL.md` is the one to
correct first if it drifts:

- **Rebel-Sim** (this repo) — TypeScript/Angular, browser-based,
  fast-iteration simulator. **Ahead on the interpreter**: a working
  token-threaded Forth engine (`PLAN.md`'s milestone log, M1 onward)
  with a real dictionary, compiler, and a growing primitive set — the
  design lab the hardware targets get implemented against, not a
  simulator trailing a finished reference.
- **`rebel-rom`** — C++/Circle bare-metal on Arm, the Pi 400/500
  family. Symlinked into this checkout at `rebel-rom/` (gitignored —
  a sibling repo on disk, not vendored; may not be present in every
  checkout, don't assume it without checking). **Ahead on the
  hardware substrate**: memory/banks, sysvars, screen, font, execution
  loop/scheduler, keyboard, and storage are implemented and
  hardware-verified — but its Forth executor doesn't exist yet, so
  there's no C++ Forth engine to compare Rebel-Sim's primitive
  behavior against, only the substrate it'll eventually run on.
- **Rebel Machine MkI** — custom hardware: RP2350 (RISC-V), HSTX
  display, SPI flash + RAM, with a separate RP2040 co-processor
  handling the keyboard matrix and custom controls. Does not exist in
  code yet.
- **Headless Rebel firmware** — RP2350 (Arm and RISC-V builds) /
  RP2040, UART-channel-driven, no display/keyboard. Does not exist in
  code yet.
- **Further out, unscoped:** ESP32-S2, UEFI.

Rebel-Sim's whole purpose is to let Forth engine design happen at
browser-refresh speed instead of flash-a-device speed — the other
targets catch up to what gets designed and proven here, not the
reverse.

## Required reading before writing any code

**Read `FORTH-ARCHITECTURE.md` in full before touching the engine.** It is
the actual cross-target specification — cell width, memory/bank layout,
sysvars, the threading model, the dictionary header, the HAL contract, and
the state-portability claim — and it carries an explicit "Porting to
Rebel-Sim" note under nearly every rule. Treat those as directives, not
suggestions.

**Then read `PORTING-WEB.md`** — the web-specific companion covering
Angular project shape, canvas rendering, browser storage, PWA packaging,
and browser-runtime gotchas (Angular zone/change-detection interaction
with a hot interpreter loop) that the architecture doc deliberately
doesn't cover.

**`IMPLEMENTATION.md` documents how the actually-built engine works** —
a living, concept-by-concept reference (arena/banks/sysvars, the
dictionary, token threading, compiling) grounded in the real code, kept
current across milestones. Prefer it over re-deriving mechanisms from
source when you just need to understand how something works; update it
when a milestone changes or adds a mechanism. `PLAN.md` is the separate
decision/build log (what shipped, when, why) — don't conflate the two.

**Then read `HAL.md`** (repo root) — the concrete, code-checked version
of the cross-target HAL contract `FORTH-ARCHITECTURE.md` only names
abstractly (`hal_emit`, `hal_key_pressed?`, …), verified directly
against `rebel-rom`'s real source where it names something specific.
Prefer it over re-deriving a HAL fact from scratch; extend it, don't
duplicate it, when a HAL-boundary question comes up.

Both `FORTH-ARCHITECTURE.md` and `PORTING-WEB.md` reference several
`docs/*.md` files (`docs/MEMORY-MODEL.md`, `docs/SYSVARS.md`,
`docs/SCREEN-MODULE.md`, `docs/KEYBOARD.md`, `docs/STORAGE.md`,
`docs/EXECUTION-LOOP.md`) and a `CLAUDE.md`/`PLAN.md` from the
**`rebel-rom`** repo as sources of truth for implementation detail.
**These live in a separate repo** — but as of `HAL.md`, that repo is
often reachable from here via a gitignored symlink, `rebel-rom/` (a
sibling checkout on disk, not vendored). Check whether `rebel-rom/`
actually resolves before assuming either way — it won't be present in
every checkout (e.g. a fresh clone without the sibling repo alongside
it), and `HAL.md` itself may have been written in a session that had
it and gone stale since. Where `FORTH-ARCHITECTURE.md` cites specific
C++ classes/methods (`CBankTable::CreateBank`, `CScreenModule::Emit`,
`CKeyboardModule::ReadEvent`, …) and `rebel-rom/` isn't available,
read those as precise descriptions of required *behavior* to
reimplement faithfully in TypeScript rather than something to link or
import against.

## Architectural rules that will shape any code written here

These are firm, settled rules from `FORTH-ARCHITECTURE.md` — not open
choices for a fresh implementation to relitigate:

- **32-bit cell, little-endian, always.** Every Forth cell is exactly 4
  bytes, little-endian on every target with no exceptions. `DataView`
  defaults to big-endian — wrap every access through one accessor module
  (`readCell`/`writeCell`) that passes `littleEndian: true`, and never call
  `getUint32`/`setUint32`/etc. directly anywhere else.
- **Addresses are per-arena offsets, never raw pointers.** One arena = one
  `ArrayBuffer` + `DataView` pair. Multiple arenas (isolation model) =
  multiple such pairs. A "current arena" the interpreter's inner loop
  reasons about per-access must never exist — a task is bound to one arena
  for its whole lifetime; only which arena the *user* is currently
  attached to is switchable UI state. Don't let an arena's addressable
  region exceed 2^32 bytes even though a `DataView` isn't hardware-limited
  to that.
- **Memory is organized into banks**, not a flat fixed-offset table:
  named regions (tag + name + base + size class + flags) generated from
  the same source-of-truth as Rebel-ROM's bank list, never hand-picked
  independently. Known tags: `SYSV`, `DICT`, `RSTK`, `DSTK`, `CHAR`
  (per-arena); `SCRN`, `KMAP` (shared/singular, never duplicated per
  arena).
- **Sysvars live in `SYSV`, grouped by owning subsystem** (`CORE`,
  `SCREEN`, `KEYBOARD`, `FONT`, `SPRITE`, `STORAGE`, `FORTH`), not one flat
  table. Forth words only ever read/write sysvars via `@`/`!` — they never
  branch on which target they're running on. If behavior can be expressed
  as "read a sysvar, act the same way everywhere," it belongs in Forth
  source; if it genuinely needs different code paths per target, it
  belongs in the HAL.
- **Token-threaded dispatch**: every dictionary entry's Code Field holds a
  token ID. IDs `0..N-1` are native primitives dispatched directly via
  `switch`; a single reserved sentinel token (`DOCOL`) means "this word's
  Parameter Field is a list of further token offsets" (push IP to return
  stack, execute the Parameter Field). Never guess which case based on the
  address.
- **HAL boolean convention**: `TRUE = -1` (all bits set), `FALSE = 0` — not
  C-style `1`/`0`.
- **HAL shape to match**: `hal_emit`/`hal_plot_char`/`hal_draw_*` is a
  three-way split (stream emit vs. positioned+colored char-cell write vs.
  raw pixel ops); `hal_key_pressed?`/`hal_get_key` are non-blocking reads
  against a ring buffer, with any blocking `KEY` built as an
  async/Promise-based layer on top, not by making the queue itself block;
  `hal_block_read`/`hal_block_write` operate on an in-memory "screens"
  bank (`SCRS`), not a raw device — persistence to browser storage happens
  at project open/close time, not per block access.
- **A single source-of-truth artifact** (not yet built anywhere) is
  supposed to generate primitive token IDs, sysvar offsets, dictionary
  flag bits, and bank tag/size-class tables into per-target outputs (a TS
  const table for Rebel-Sim, a C++ header for Rebel-ROM). If it isn't
  available in this repo yet, that's a real gap to flag, not something to
  quietly work around with an independently hand-maintained layout that
  will drift.

## Rebel-Sim-specific implementation guidance (from `PORTING-WEB.md`)

- **Keep the Forth engine framework-agnostic.** Arena/bank memory,
  sysvars, and the inner/outer interpreter should be plain TypeScript with
  zero Angular dependencies (no `@Injectable`, no signals, no RxJS inside
  the engine). Angular is a thin shell: canvas element, keyboard
  listeners, storage adapter, minimal UI. Program state lives in the
  arena's `ArrayBuffer`; components only ever read it to render. If
  dictionary/stack/sysvar state ends up living in a signal or service
  field instead of the arena, that's a bug to fix, not a shortcut to keep.
- **Screen is one framebuffer, always graphics** — not a DOM/CSS text UI.
  A single 2D `<canvas>` is the framebuffer analog; keep a separate
  in-memory character-code grid (`CHAR` bank analog) that text output
  write-throughs into *and* blits from, mirroring Rebel-ROM's two-buffer
  structure. Don't use `fillText`/native canvas text APIs — bitmap-blit
  from a pre-rasterized glyph table instead.
- **Keyboard**: raw `keydown`/`keyup` listeners into a non-blocking ring
  buffer, translated through a keymap table — never a hidden `<input>`
  element (composition/IME/autocomplete have no hardware equivalent).
  `preventDefault()` on keys you handle once this runs as an installed
  PWA.
- **Storage**: prefer the Origin Private File System
  (`navigator.storage.getDirectory()`) over IndexedDB as the default,
  since it more closely matches Rebel-ROM's real directory-of-named-files
  project/asset model (`/PROJECTS/<name>/asset.ext`).
- **Don't run the interpreter's hot loop inside Angular's zone** — use
  `NgZone.runOutsideAngular()`, cross back into the zone only to render a
  frame or update UI. Getting this wrong doesn't crash anything, it just
  makes the interpreter mysteriously slow in a way that's easy to
  misdiagnose. A `requestAnimationFrame`-driven render cadence, decoupled
  from however fast the interpreter itself ticks, is the target shape. A
  Web Worker for the interpreter core is worth considering from v1 (real
  preemption, and it structurally enforces the engine/DOM boundary), not
  just as a later nicety.
- **PWA is core to the premise, not a checkbox**: precache everything
  needed to boot to a usable Forth prompt, make it genuinely installable,
  and call `navigator.storage.persist()` so project data isn't subject to
  casual eviction.

## Calibrating scope

Both source documents are explicit that this project favors building the
minimum real mechanism and revisiting it once an actual need shows up —
not gold-plating UI, not adding settings screens nobody asked for, not
building ahead of a concrete need (multi-arena concurrency, per-arena
display modes, worker-based preemption, localization, etc. are all
legitimate eventually but not default starting scope). Apply the same
discipline to any implementation work here.

`FORTH-ARCHITECTURE.md` §9 and `PORTING-WEB.md` §9 each list genuinely
open decisions (not yet resolved anywhere) that an implementer will need
to make explicitly rather than guess past — check those sections before
assuming a design choice is already settled.
