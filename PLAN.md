# Rebel-Sim Build Plan

This is the decision/build log — what shipped, when, and why. For how
the engine actually works (concepts, mechanisms, a worked trace), see
`IMPLEMENTATION.md` instead.

## Context

`FORTH-ARCHITECTURE.md` and `PORTING-WEB.md` specify what Rebel-Sim must
be; nothing has been built yet. This document tracks the actual build
roadmap so future sessions (human or agent) know what's done, what's
next, and why the early decisions were made the way they were. Decisions
below were made explicitly with Oliver on 2026-07-29 rather than assumed.

**Key decisions locked in:**
- **First milestone**: a minimal working REPL — real engine, plain-text
  I/O, no canvas/bitmap-font, no keyboard queue, no storage yet. Prove the
  core mechanism (arena → banks → sysvars → token-threaded dispatch) end
  to end before adding browser-presentation layers.
- **Workspace shape**: npm workspaces, two packages — `packages/engine`
  (plain TypeScript, zero Angular deps) and `packages/app` (Angular
  shell). The package boundary itself enforces
  `PORTING-WEB.md` §1's "engine doesn't know Angular exists" rule, rather
  than relying on folder-convention discipline.
- **Execution model**: interpreter runs on the main thread for now, via
  `NgZone.runOutsideAngular()`. Web Worker migration is a later, separate
  decision once something concrete needs real preemption — not designed
  in from day one.
- **Opcode/sysvar source of truth**: `FORTH-ARCHITECTURE.md` §0 expects
  one generated artifact shared with the Rebel-ROM repo; that repo isn't
  available here. We define our own provisional source-of-truth file in
  this repo now, clearly marked as provisional/to-reconcile, so work
  isn't blocked waiting on cross-repo coordination.
- **[2026-07-29, mid-M3] The Rebel-ROM reference repo turned out to be
  available after all** — a full checkout at `/home/olifink/rebel-rom`
  on this machine (real source: `screenmodule.h/.cpp`, `sysvars.h/.cpp`,
  `membank.h/.cpp`, real `docs/*.md`, and ready-to-port bitmap fonts).
  From M3 onward, new subsystems are designed by reading the real
  Rebel-ROM source first, not invented from the spec docs alone — see
  each milestone's write-up for what was matched exactly vs. deliberately
  diverged from (cell-granularity sysvars vs. Rebel-ROM's packed C
  structs remains the one standing divergence, unchanged from before).

## Roadmap (milestones beyond the current one, for context)

1. **M1 — Minimal working REPL** *(this plan's focus, detailed below)*
2. **M2 — Colon-definitions & dictionary**: `DICT` bank, dictionary header
   layout (§6), `:`/`;`/`IMMEDIATE`, real return-stack usage, a proper
   compiler/interpreter STATE split.
3. **M3 — Screen**: `CHAR` bank, canvas framebuffer, bitmap-font blitting,
   `hal_emit`/`hal_plot_char`/`hal_draw_*` (§7).
4. **M4 — Keyboard**: raw event capture → non-blocking ring buffer →
   keymap translation, blocking `KEY` word layered on top (§7, `PORTING-WEB.md` §4).
5. **M5 — Storage**: OPFS-backed projects/carts model, `SCRS` bank,
   `hal_block_read`/`write` (§7, `PORTING-WEB.md` §5).
6. **M6 — PWA packaging**: manifest, service worker precache,
   `navigator.storage.persist()` (`PORTING-WEB.md` §7).
7. **M7 — Execution loop & channel binding** — **done**: generator/
   step-function outer loop, `Channel` abstraction (`FORTH-ARCHITECTURE.md`
   §7a, `CHANNELS-DESIGN.md`), real blocking `KEY`. Shipped detail (what
   actually landed, tests, verification) to be logged by the implementing
   agent per this repo's own convention, once reported.
8. **M7a — On-screen REPL** *(next, detailed below)*: `ACCEPT`/`QUERY`-
   style line input read off `KeyboardChannel` and echoed through
   `screen.emit()`, retiring the M1-era DOM `<input>` stand-in and the
   focus-based input routing that went with it (`PORTING-WEB.md` §4).
9. **M8 — Core vocabulary** *(detailed below)*: the primitive/control-flow/
   defining-word set a "passable" Forth needs before source screens can
   build anything portable on top of it — memory access, control flow,
   return-stack words, defining words, strings, remaining stack/arithmetic
   ops.
10. **M9 — Remote channel (WebMCP)**: `RemoteChannel` binding the outer
    loop to a WebMCP-driven input source, per §7a's "zero interpreter
    changes" design goal. Deliberately sequenced after M8 — a remote/MCP
    surface is only as useful as the vocabulary it can exercise. Revisit
    REI's MCP tool-surface ideas (`execute_word`/`define_word`/
    `trace_execution`/etc.) here once there's a vocabulary worth wrapping.
11. Later/open: multi-arena isolation, `hal_error`/exception model,
    Web Worker migration — see `FORTH-ARCHITECTURE.md` §9 and
    `PORTING-WEB.md` §9 for the full open-decisions list.

Each milestone gets its own detailed plan when it starts; only M1 is
detailed now.

---

## M1 — Minimal Working REPL — **done** (2026-07-29)

Implemented as `packages/engine` (`Arena`, `BankTable`, `Sysvars`,
`DataStack`, `executePrimitive`, `Machine`) + `packages/app` (single
terminal-style Angular component). 20 primitives, `SYSV`+`DSTK` banks,
line-based outer interpreter, no dictionary/colon-definitions yet (M2).
15 engine unit tests + 3 app tests pass; verified live in a headless
Chromium browser (`2 3 + .` → `5`, `5 DUP + .` → `10`, `1 2 SWAP` →
stack `1 2`), no console errors. Original plan below, kept for record.

**Goal:** type `2 3 + .` into a browser page, see `5` printed. That proves
the arena/bank/sysvar/token-threading mechanism for real, with the
smallest possible browser-presentation layer (plain text, no canvas).

### 1. Workspace scaffolding

- npm workspaces root `package.json` (`workspaces: ["packages/*"]`).
- `packages/engine`: plain TypeScript library, own `package.json` +
  `tsconfig.json`, no Angular/DOM dependency. Built with `tsc` (or `tsup`/
  `vite` in library mode — decide when scaffolding, keep it simple).
- `packages/app`: generated via `ng new` (standalone components,
  current Angular CLI defaults — v22 is installed locally), depending on
  `packages/engine` as a workspace dependency.
- Root-level scripts to build/test both packages; confirm Angular 22's
  default unit-test runner when scaffolding (don't assume Karma vs.
  Vitest — check what `ng new` sets up) and mirror that choice for the
  engine package if reasonable, otherwise use Vitest for the engine since
  it needs no browser/DOM shimming.

### 2. Engine core (`packages/engine`)

- **`arena.ts`** — `ArrayBuffer` + `DataView` wrapper exposing
  `readCell(offset)`/`writeCell(offset, value)`/`readByte`/`writeByte`,
  the *only* place `DataView` methods are called directly, always with
  `littleEndian: true` (§2). Cap addressable region at 2^32 bytes (§1).
- **`banks.ts`** — bank table: `createBank(tag, name, sizeClass)` /
  `findBank(tag, name)`, each bank recording base offset + size within
  the arena, never relocated once created (§3). For M1, only the banks
  actually used get created: `SYSV`, `DSTK`. (`DICT`/`RSTK`/`CHAR` arrive
  in M2/M3 when something needs them — no point standing up unused banks
  now.)
- **`rebel-opcodes.json`** (or `.ts`) — the provisional source-of-truth
  file per §0, scoped to what M1 needs: primitive token IDs (`DOCOL = 0`,
  then the ~15–20 primitives below), the `FORTH` sysvar group's offsets
  (`SP0`, `HERE`, `BASE`, `STATE` — `RP0`/`LATEST` unused until M2 but
  fine to reserve now), and the two bank tags in use. Header comment
  states plainly: *provisional, authored in Rebel-Sim, needs reconciling
  against Rebel-ROM's actual layout once that's available* — not
  presented as if it were the real cross-repo artifact.
- **`sysvars.ts`** — thin accessors over the `SYSV` bank using the
  offsets from the generated table (`getBase()`, `getState()`, etc.),
  mirroring `docs/SYSVARS.md`'s grouped-offset shape at the scale M1
  needs.
- **`stack.ts`** — data stack push/pop against the `DSTK` bank, growing
  down, bounds-checked against `SP0` (§3).
- **`primitives.ts`** — the inner interpreter: a `switch` on token ID
  (§5) implementing arithmetic (`+ - * / MOD`), stack ops
  (`DUP DROP SWAP OVER ROT`), comparison (`= < > 0=`), logic
  (`AND OR INVERT`), and I/O (`. EMIT CR` — for M1, `EMIT`/`.` write to a
  simple output-string buffer the engine exposes, not a real `hal_emit`
  yet, since there's no `CHAR`/`SCRN` bank until M3). No `DOCOL`/colon-word
  case yet — M1 has no compiler, so every token dispatches straight to a
  primitive; that branch of §5's dispatch rule is proven in M2.
- **`repl.ts`** — the outer interpreter: given a line of text, whitespace-
  tokenize, and for each token either parse it as a number (push literal)
  or look it up by name in a small primitive name→token-ID table and
  execute it immediately. No dictionary search yet (no user-defined words
  until M2) — just the fixed primitive table.
- Boolean convention (`TRUE = -1`) honored anywhere a primitive produces
  a flag (`= < > 0=`), per §7, even though no HAL call exists yet — get
  the convention right at the first point flags are produced, not
  retrofitted in M3+.

### 3. Angular shell (`packages/app`)

- One component: a text input (line-at-a-time, not a raw-keydown queue —
  that's M4's job) feeding `repl.ts`, and a scrollback `<pre>`/list
  rendering the engine's output buffer plus the current stack contents
  (handy for debugging the engine itself).
- Interpreter calls wrapped in `NgZone.runOutsideAngular()`; only the
  result (new output lines, new stack snapshot) crosses back into the
  zone to trigger a render. Real payoff shows up later once the loop runs
  many primitives per keystroke, but establish the pattern now so it's
  not a retrofit.
- No canvas, no bitmap font, no PWA manifest work yet — explicitly out of
  scope for M1 per the milestone goal above.

### 4. Tests

- Engine: unit tests per primitive (stack effects), a few multi-word
  expressions end-to-end through `repl.ts` (`"2 3 + ."` → output `"5 "`),
  an endianness round-trip test (write via `writeCell`, read raw bytes,
  confirm little-endian byte order) since that's the one bug class the
  docs call out as silently working "in isolation" and breaking later.
- App: minimal — confirm the component wires input → engine → output
  without needing full Angular TestBed ceremony beyond what's necessary.

### Verification

- `npm run build` (or per-package equivalent) succeeds for both packages.
- `npm test` runs engine unit tests headless (fast, no browser).
- `ng serve` in `packages/app` boots to a page where typing
  `2 3 + .` and submitting shows `5` in the output pane, and `DUP` /
  `SWAP` / a few others behave correctly — actually run this in a browser
  before calling M1 done, per this repo's own "test the golden path in a
  browser" standard.

### Explicitly deferred out of M1 (don't build ahead)

Colon-definitions, dictionary/`DICT` bank, real return-stack usage,
canvas/`CHAR` bank, bitmap fonts, keyboard queue, storage, PWA packaging,
multi-arena, Web Worker migration, `hal_error`/exceptions. All real, all
scheduled in the roadmap above, none needed to prove M1's goal.

---

## M2 — Colon-Definitions & Dictionary — **done** (2026-07-29)

**Goal:** `: SQUARE DUP * ; 5 SQUARE .` → `25`, with a *real* dictionary
and a *real* DOCOL/return-stack threaded call, not a shortcut.

**What shipped:**
- `dictionary.ts` — the §6 header layout byte-for-byte (4-byte link
  pointer / 1-byte flags+length / zero-padded name / 4-byte-aligned Code
  Field), `writeHeader`, `findWord` (chain walk, skips `HIDDEN`,
  most-recent-wins on shadowing), `markLatestImmediate`, `compileCell`,
  and `begin`/`end`/`abortDefinition` for the `:`/`;` lifecycle.
- `inner.ts` — the real §5 DOCOL branch: `executeXT` threads through a
  DOCOL word's parameter field via an explicit IP register and the real
  `RSTK` bank (not JS call recursion), so call depth is bounded by RSTK
  size and hits `StackOverflowError` like any other bank. `EXIT`/`LIT`
  are primitive token IDs but special-cased in the loop (they need to
  mutate IP, which a plain stack-effect primitive can't touch).
- `repl.ts` — `Machine` now boot-registers every primitive as a *real*
  dictionary entry (uniform search path for primitives and user words —
  no more parallel name→token-ID table), adds `DICT`+`RSTK` banks, and
  `interpret()` is now a proper STATE-driven compile/interpret loop with
  lookahead tokenization (so `:` can consume the following token as a
  name). A compile-time error rolls the partial definition back
  (`abortDefinition`) so a REPL typo doesn't corrupt the dictionary.
- **Deliberate scope cut:** `:`/`;`/`IMMEDIATE` are handled as compiler
  syntax in `repl.ts`, not as real dictionary words — they need direct
  access to compiler state (`HERE`/`LATEST`/`STATE`) that a plain
  primitive's interface doesn't expose. `RECURSE` / self-reference inside
  a definition isn't supported (a word is `HIDDEN` until `;`, so it can't
  find itself) — noted, not needed to prove the mechanism.
- 9 new tests (colon-definitions, nested user-word calls, shadowing,
  `IMMEDIATE`-at-compile-time semantics, `:`/`;` misuse errors, rollback
  after a compile error, 31-char name limit, 50-deep nested-call chain
  through the real RSTK) — 24 engine tests total, all passing. Verified
  live in a headless browser: nested colon-definitions, `EMIT`/`CR` from
  a compiled body, and confirmed the dictionary stays usable immediately
  after a bad definition (no corruption), no console errors.

---

## M3 — Screen — **done** (2026-07-29)

**Goal:** a real `CHAR` bank + canvas framebuffer, with `.`/`EMIT`/`CR`
actually drawing to it — retiring M1's plain-text output buffer, which
was always documented as a stand-in for this.

**Built against the real Rebel-ROM reference**, not invented from the
spec docs: `/home/olifink/rebel-rom` (a sibling checkout on this
machine, not part of this repo) has the real `src/screenmodule.h/.cpp`
and `src/sysvars.h`. Matched exactly: sysvar group names/order/offsets
(`CORE` at 0x010, `SCREEN` at 0x040, `KEYBOARD`/`FONT`/`SPRITE`/`STORAGE`
reserved at their real offsets, our own `FORTH` group appended after at
0x180 since Rebel-ROM's Phase 11 doesn't exist yet); `CScreenModule`'s
exact behavior — `Emit()` special-cases `\r`(cursor-to-col-0)/`\n`
(cursor-to-next-row) as control codes rather than glyphs, `AdvanceCursor`
wraps at the last column/row but **never scrolls** (wrapping back to row
0 overwrites existing content — a deliberate Phase 5 scope cut we
inherited as-is), `WriteChar`/`ReadChar` silently bounds-check (no-op /
return space) rather than throwing, `SetCursor` does **not**
bounds-check at all. Also ported `src/fonts/font_zxspectrum.cpp`
byte-for-byte — a real, already-rasterized 8×8 bitmap font (94 glyphs,
0x21–0x7E) generated by Rebel-ROM's own `tools/ttf2font.py` — instead of
inventing or runtime-rasterizing one.

**One deliberate divergence, documented in `rebel-opcodes.json`'s
header:** Rebel-ROM packs sysvar fields into byte/`u16` C structs;
Rebel-Sim stores every field as a full 4-byte cell (consistent with
everything else in this engine), so *group*-level offsets match
Rebel-ROM exactly, *field*-level offsets within a group don't.

**What shipped:**
- `screen.ts` — the `Screen` class: `writeChar`/`readChar` (`CHAR!`/
  `CHAR@`), `emit` (cursor-based streaming write, wrap-only), `cls`,
  cursor/ink/paper accessors. Takes an optional `ScreenHal` — `{
  blitGlyph(col,row,charCode,ink,paper), clearScreen(paper) }` — called
  synchronously on every write-through, defaulting to a no-op
  (`NULL_SCREEN_HAL`) so engine tests need no canvas. This is the same
  HAL/dependency-injection shape `hal_draw_*` will eventually need too
  (see the deferred-scope note below).
- `sysvars.ts` refactored to a generic `get(group,field)`/`set(...)`
  pair (the old FORTH-specific named methods now call through it) —
  needed once SCREEN/CORE fields joined FORTH; also writes the SYSV
  bank's real magic-header bytes (`'S'`,`'V'`,version) matching
  `TSysVarsHeader`.
- `primitives.ts`/`repl.ts` — `.`/`EMIT`/`CR` now stream through
  `screen.emit()` instead of a string buffer; six new primitives:
  `CHAR!`, `CHAR@`, `CLS`, `AT-XY`, `INK`, `PAPER` (real Rebel-ROM
  naming, not invented). `Machine.interpret()` is now `void` — Forth's
  own output is visible through `screen`/`stack`, not a return value.
- `packages/app`: `canvas-screen-hal.ts` (the real `ScreenHal`
  implementation — fills each cell in `paper`, draws the glyph's set
  bits in `ink`, mirroring `BlitGlyph` exactly) and `font-zxspectrum.ts`
  (the ported font data). A `<canvas>` (320×240 native, CSS-scaled 2× with
  `image-rendering: pixelated`) replaces the old text-output role of the
  log pane, which now only echoes typed commands and errors. `INK`/
  `PAPER` are raw 24-bit `0xRRGGBB` truecolor (matching Rebel-ROM's
  `TColor` — direct/truecolor is its likely default mode per
  `docs/SCREEN-MODULE.md` §4), not a palette index, so no palette table
  was needed.
- **Scope cut, explicit:** `hal_draw_*` (raw pixel/line/rect primitives,
  `SET-PIXEL`/`DRAW-LINE`/`DRAW-RECT`) deferred to a follow-up. Nothing
  needs them yet (no Forth primitives draw pixels), and the `ScreenHal`
  boundary this milestone already built is the exact mechanism they'll
  need too — extending it later is additive, not a redesign.
- 9 new engine tests (`screen.test.ts`: `CHAR!`/`CHAR@` round-trip and
  out-of-range handling, wrap-not-scroll at both row- and screen-bottom,
  `AT-XY` with no bounds-checking, `CLS` clearing + HAL call, `INK`/
  `PAPER` affecting `blitGlyph`'s arguments, boot-time HAL paint) plus
  every M1/M2 test rewritten from string-return assertions to
  `screen.readRowText()`/cursor checks — 32 engine tests total, all
  passing. Verified live in a headless browser: multi-color text,
  `AT-XY` positioning, `CLS` respecting current `PAPER`, ink persisting
  across `CLS` (matching `Cls()` — only paper/char-bank/cursor reset),
  no console errors.

## M4 — Keyboard — **done** (2026-07-31)

**Goal:** raw keyboard events in, a translated non-blocking queue out
(`PORTING-WEB.md` §4's heading, verbatim) — `KEY?`/`KEY` primitives a
Forth program can poll directly, independent of the M1 REPL `<input>`
line-reader.

**Built against the real Rebel-ROM reference** (`docs/KEYBOARD.md`,
`src/keyboardmodule.h/.cpp`): matched the `KMAP` bank shape (`u8[2][256]`,
unshifted/shifted planes), the default US keymap byte-for-byte
(`BuildDefaultKeymap` — only printable keys plus Enter/Backspace/Tab/
Space get a translated char; Caps Lock/F-keys/PrintScreen/arrows/GUI stay
at char 0, identified only by usage code), the modifier
press/release-as-pseudo-events convention (usage code `0x80 + bit`,
folded into the *same* event queue as ordinary keys — confirmed by
browser verification below, which initially looked like a bug until
re-tracing showed it's exactly what `OnRawReport` does on real hardware),
and `PushEvent`'s full-queue behavior (drop the new event, never
overwrite or block).

**Deliberate simplifications vs. the reference**, each documented in
`keyboard.ts`'s header comment:
- No raw-report diffing needed — Circle's raw USB handler can refire
  without a real change (`docs/KEYBOARD.md` §1), so `CKeyboardModule`
  diffs each report against the last one itself to derive edges. DOM
  `keydown`/`keyup` are already clean edges; the host only needs to
  filter `KeyboardEvent.repeat` (auto-repeat) before calling in.
- `nKeyboardCount` (attached-device count) omitted from the `KEYBOARD`
  sysvar group — browser DOM APIs have no USB-hotplug-style device
  enumeration to report, so there's nothing meaningful to put there.
- `KMAP` is per-arena in Rebel-Sim even though `CLAUDE.md` classifies it
  as shared/singular like `SCRN` — moot until multi-arena isolation
  exists (there's only ever one arena today); flagged in
  `rebel-opcodes.json` as a real distinction to revisit then, not
  overlooked.

**What shipped:**
- `keyboard.ts` — the `Keyboard` class: builds the default US `KMAP`
  table into a new `KMAP` bank (4 KiB, XS class, matching
  `docs/KEYBOARD.md` §6 — the table itself is 512 bytes), `pushRawEvent
  (usageCode, pressed)` (modifier pseudo-code diffing into the
  `KEYBOARD.MODIFIERS` sysvar + KMAP-plane translation + enqueue),
  `hasEvent()`/`readEvent()` (non-blocking peek/pop against a 32-slot
  ring buffer, one slot sacrificed for full/empty detection — same as
  Rebel-ROM's `m_Queue`).
- `primitives.ts`/`rebel-opcodes.json` — two new primitives: `KEY?`
  ( `-- flag` , non-blocking, doesn't consume) and `KEY` ( `-- char` ,
  non-blocking pop). **Blocking `KEY` is explicitly deferred**: Rebel-ROM
  itself hasn't built its own blocking Forth `KEY` yet either (`docs/
  KEYBOARD.md` §10 — it'd block a task on this same queue once Phase 11
  lands there); Rebel-Sim's interpreter has no task-suspension model to
  build a blocking word on top of, so `KEY` throws on an empty queue
  rather than faking a block. Same deferral shape as M3's `hal_draw_*`.
- `packages/app`: `browser-keymap.ts` (DOM `KeyboardEvent.code` → raw USB
  HID usage code — the browser-host driver layer real hardware's USB
  report parsing plays; modifiers map straight to the `0x80+bit`
  pseudo-codes `Keyboard.pushRawEvent()` expects, since DOM already
  reports each physical modifier key as its own discrete press/release,
  unlike the boot-protocol modifier bitmask). `app.ts` wires `window`
  `keydown`/`keyup` listeners (installed `NgZone.runOutsideAngular()`) to
  `machine.keyboard.pushRawEvent()`, `preventDefault()` on every key it
  recognizes. Focus is the routing switch: while the REPL `<input>` has
  DOM focus, events are left alone for normal cooked text entry instead
  (Rebel-Sim has no multi-arena/screen-attachment model yet for
  `PORTING-WEB.md` §4's "only the attached arena receives routed input"
  to hook into — DOM focus on the REPL box is a deliberately simple
  stand-in, not a redesign to revisit once one exists).
- 12 new engine tests (`keyboard.test.ts`: unshifted/shifted translation,
  digit/symbol row, Enter/Backspace/Tab/Space, untranslated special keys
  staying at char 0, release events carrying no char, independent L/R
  modifier bit tracking, queue-full drop behavior, `KEY?`/`KEY` via
  `Machine.interpret`, `KEY` throwing on empty) — 44 engine tests total,
  all passing; 3 app tests unaffected.
- **Live browser verification surfaced a real dev-tooling gotcha, not an
  app bug**: Vite's `optimizeDeps` pre-bundle of the workspace-linked
  `@rebel-sim/engine` package is cached under
  `packages/app/.angular/cache/**/vite/deps/`, keyed off `package.json`/
  lockfile content rather than the actual resolved file contents — so
  editing `packages/engine/src/*.ts` and rebuilding its `dist/` does
  *not* invalidate a dev server already holding that cache (nor does
  starting a fresh `ng serve`, since the cache is only rebuilt when Vite
  judges the *dependency graph shape* to have changed). A stray
  already-running `ng serve` process from the M3 session, still bound to
  port 4200, made this doubly confusing at first. Fix: fully stop any
  running `ng serve`, delete `packages/app/.angular` (not just its
  `cache/` contents were being reliably removed — always verify the
  `rm -rf` actually ran, don't trust a non-error exit code alone), then
  restart. Worth remembering for M5/M6 too if a dev-server session ever
  seems to be ignoring fresh engine changes.

## M5 — Storage — **done** (2026-07-31)

**Goal:** a storage layer that round-trips (`PORTING-WEB.md` §0's own bar
for this milestone) — save/load a bank as a project asset file, backed by
OPFS.

**Built against the real Rebel-ROM reference** (`docs/STORAGE.md`,
`src/storagemodule.h/.cpp`, `src/membank.h`) — and this milestone is the
clearest example yet of why that matters: `FORTH-ARCHITECTURE.md` §7's
own porting note for `hal_block_read`/`write` originally pointed at a
classic-Forth raw-numbered-block model (an `SCRS` "screens" bank, still
referenced in `CLAUDE.md`'s summary). The *actual* Rebel-ROM Phase 9
implementation superseded that with something different: a
**projects/carts** model — named, typed asset files
(`/PROJECTS/<name>/asset.ext`, `/CARTS/<name>.CRT`) loaded whole into
banks sized from the file's own length — which `FORTH-ARCHITECTURE.md`
§7 itself already documents as "the single biggest divergence from the
original spec, now resolved in favor of the shipped `docs/STORAGE.md`
design." Built the real thing, not the superseded one: extension-based
bank-tag tagging (`.DAT`↔`DATA`, `.SCR`↔`SCRN`, etc.), the 6-byte `RA`+tag
asset header (short/missing read aborts a file's load; a magic/tag
mismatch is a diagnostic hook only, not a load failure), file-size →
size-class bank allocation (XS/S/M/L/XL/XXL, each 4x the previous), and
`CBankTable`'s Phase 9 identity change — bank uniqueness keyed on `name`
(distinct from `tag`) rather than `tag` alone, so multiple same-tag
project-asset banks coexist, each individually addressable and each
doubling as its own file's basename on save.

**Retrofit to `banks.ts`, needed to support the above faithfully:**
`Bank`'s `name` field (already present since M1, but previously required
and checked for uniqueness *together* with `tag`) is now optional at
`createBank()` — omit it and get an auto-generated 8-digit zero-padded
serial, exactly like `CBankTable::GenerateSerialName` — and uniqueness is
enforced on `name` alone, matching the real Phase 9 change. The six
existing M1-M4 bank-creation calls (`SYSV`, `DSTK`, `RSTK`, `DICT`,
`CHAR`, `KMAP`) all dropped their now-redundant explicit `'main'` name in
favor of an auto-generated serial — they never needed a *stable* name,
only M5's project assets do. Added `findBankByName` (the real
"the-one-bank" lookup once tags repeat) and `roundToSizeClass()`.

**Deliberate simplifications, each documented in `storage.ts`'s header
comment:**
- **No automatic DIRTY-flag tracking.** Real Rebel-ROM's "close only
  writes back dirty banks" needs a write path to hook; Rebel-Sim has no
  Phase-11-equivalent Forth words that write into a generic project asset
  bank yet, so there's nothing to track. `saveAsset()` always persists
  whatever bank you hand it — same deferral shape as M3's `hal_draw_*`.
- **No `TStorageSysVars`-equivalent sysvar group populated.** Its real
  fields (`nMounted`, `nDeviceSeen`) describe USB mass-storage
  enumeration/mount polling, which has no honest browser equivalent — OPFS
  is just available or not, no polling loop involved. Same reasoning as
  M4 omitting `nKeyboardCount`. `STORAGE` stays reserved/empty, like
  `FONT` since M3.
- **Storage operations are plain `async` TypeScript methods on `Storage`,
  never Forth primitives.** `FORTH-ARCHITECTURE.md` §7's porting note is
  explicit that persistence happens "at project open/close time... not a
  storage-device call on every read/write" — Forth only ever touches a
  resident bank directly. This sidesteps a real architectural tension
  cleanly: OPFS's synchronous access API only exists inside a Web Worker,
  unavailable to Rebel-Sim's current main-thread interpreter (M1's
  decision) — but since no Forth primitive needs to *be* async in this
  design, that limitation never actually bites.

**What shipped:**
- `banks.ts` (retrofit, above) — `roundToSizeClass()`, `BankSizeXS`
  through `BankSizeXXL`, optional `name`/serial auto-generation,
  `findBankByName`.
- `storage.ts` — `Storage` class: `openProject`/`saveAsset` (the
  project-asset pipeline) and `loadCart`/`saveCart` (opaque flat-file
  cart I/O). Takes a host-supplied `StorageHal` (`ensureDir`/`listFiles`/
  `readFile`/`writeFile`) — same dependency-injection shape as
  `ScreenHal` — defaulting to `NULL_STORAGE_HAL` so engine tests need no
  real filesystem. Also exports `runStorageSelfTest()`, a standalone
  function porting `CKernel::RunStorageSelfTest`'s real proof (write a
  byte-pattern `DATA` bank, save it, reopen fresh, compare) almost
  verbatim — using two throwaway internal arena/bank-tables (simulating
  two separate "boots") rather than the caller's live `Machine` state, to
  sidestep the same same-process bank-name-collision case
  `docs/STORAGE.md` §8 already flags on real hardware.
- `packages/app`: `opfs-storage-hal.ts` (`OpfsStorageHal` — translates
  `Storage`'s POSIX-style absolute paths into `getDirectoryHandle`/
  `getFileHandle`/`createWritable` calls against
  `navigator.storage.getDirectory()`; `createOpfsStorageHalIfSupported()`
  feature-detects and falls back to `undefined`, same null-guard pattern
  as M3's canvas-context check). `app.ts` runs `runStorageSelfTest()`
  once at startup and surfaces `PASS`/`FAILED`/`unavailable` in a small
  status line — the live, visible proof mirroring `CKernel`'s own
  serial-logged self-test, not just an engine unit test.
- 17 new engine tests (`banks.test.ts`: size-class rounding, serial
  auto-generation, name-only uniqueness across tags, multi-bank-per-tag
  lookup; `storage.test.ts`: full round-trip via an in-memory `StorageHal`
  fake, unrecognized-extension skip, short-file-abort skip, missing-project
  returns empty, asset header bytes, unknown-tag save error, cart
  round-trip, `runStorageSelfTest` pass/fail) — 61 engine tests total, all
  passing; 3 app tests unaffected. Verified live in a headless browser:
  `storage: OK` status after the real self-test round-trips through actual
  OPFS, still `OK` after a full page reload with the prior run's file
  already on disk, no console errors, REPL/keyboard regressions checked.

## M6 — PWA packaging — **done** (2026-07-31)

**Goal:** a genuinely installable PWA that precaches everything needed to
boot to a usable Forth prompt and requests persistent storage
(`PORTING-WEB.md` §7: "instant-on is the point, not a checkbox").

**Scaffolded via Angular's own PWA schematic** (`ng add @angular/pwa`),
not hand-rolled — `manifest.webmanifest`, `ngsw-config.json`,
`provideServiceWorker()` wiring in `app.config.ts`, and `index.html`'s
manifest/icon `<head>` tags are all standard Angular CLI output, matching
`PORTING-WEB.md`'s "current PWA schematic" assumption. Two npm quirks hit
along the way, both fixed by pinning: `ng add @angular/pwa`'s own
"compatible version" resolution picked `@angular/pwa@12.2.18` (an
Angular-12-era version, wildly incompatible) instead of the `22.x` this
workspace actually needs — pinning `@angular/pwa@22.0.9` explicitly fixed
it; the schematic's own `package.json` write for `@angular/service-worker`
used `^22.0.0`, which npm then resolved to a newer `22.1.0` with an
*exact* (not caret) `@angular/core` peer requirement, conflicting with
this workspace's actual `22.0.8` — pinned to the exact matching
`22.0.8` instead. Also hit a **fresh instance of the exact npm-workspace
hoisting bug M1 already found with `jsdom`**: after this round of
installs, `@angular/core` (needed by both `packages/app` and the newly
added `@angular/service-worker`) got hoisted to the workspace root, but
`@angular/compiler` (only ever needed by `packages/app`) didn't — so
root's hoisted `@angular/core/testing.mjs` failed to resolve its own
`@angular/compiler` import at test time, since Node's module resolution
only walks *up* from the importing file, never back down into
`packages/app/node_modules`. Same fix as M1: add `@angular/compiler` as
an explicit root-level `devDependency`, forcing it to hoist to root too.

**Icons are a real, on-brand asset, not the schematic's placeholder
Angular logo**: generated via the `ng-icon-forge` skill/schematic from a
hand-authored source SVG (`icon-src/rebel-sim-logo.svg`, kept in the
scratch directory, not committed) that draws the *exact* ZX Spectrum 'R'
glyph bitmap already shipping in `font-zxspectrum.ts` (rows `0xF8, 0x84,
0x84, 0xF8, 0x88, 0x84`), scaled up and centered on the glyph's own 6×6
bounding box rather than the font's padded 8×8 cell. Same green-on-black
(`#00ff00`/`#000000`) as the running app. `ng-icon-forge`'s own `--dry-run`
flag errored (a bug in that schematic version, unrelated to this repo —
worked fine without it) — same "pin the exact version, verify with the
real command" lesson as the `@angular/pwa` resolution issue above.

**What shipped:**
- `public/manifest.webmanifest` — `name`/`short_name: "Rebel-Sim"`, a
  real `description`, `theme_color`/`background_color: "#000000"`
  (matching the terminal chrome), 10 icons (8 `any` sizes 72–512px + 2
  `maskable` 192/512px variants with the schematic's default 20% safe-zone
  padding).
- `ngsw-config.json` — verified (not just assumed) against the real
  compiled `ngsw.json` in a production build: the `app` asset group
  (`installMode: prefetch`, so precached at install time, before first
  offline use) covers exactly `index.html` + the main JS bundle +
  `manifest.webmanifest` + CSS — everything needed to boot to a working
  Forth prompt with zero network. Icons are `lazy` — correct, since
  nothing about booting to a prompt needs them upfront.
- `app.config.ts` — `provideServiceWorker('ngsw-worker.js', { enabled:
  !isDevMode(), registrationStrategy: 'registerWhenStable:30000' })`,
  schematic default (never blocks initial render on registration).
- `app.ts` — `navigator.storage.persist()` requested once at startup
  (best-effort, alongside the existing OPFS availability check from M5)
  so a user's saved projects aren't subject to casual eviction under
  storage pressure.
- Root `package.json` — added `@angular/compiler` as an explicit
  devDependency (the hoisting fix, above).
- **Verified end-to-end against a real production build**, not just the
  dev server (which never registers the service worker,
  `enabled: !isDevMode()`): served `dist/app/browser` over plain HTTP,
  confirmed in a headless browser that the manifest resolves with the
  right identity, the service worker reaches `activated` state, Cache
  Storage holds the precached asset groups, then — the actual proof —
  went **fully offline** (`context.setOffline(true)`) and reloaded: the
  app booted, ran `2 3 + .` correctly, and the M5 storage self-test still
  reported `OK` (OPFS is a local API, unaffected by network state), all
  with zero console errors online or offline.

## M7 — Execution Loop & Channel Binding — **done**

**Status note:** confirmed done (2026-07-31). The design/goal write-up
below reflects what was planned going in — the "what shipped" detail
(concrete files, test counts, live-browser verification) that every
other milestone entry in this log carries should be appended by the
implementing agent per this repo's own convention, once reported, rather
than reconstructed here without direct knowledge of the actual diff.

**Goal:** `: WAIT-KEY BEGIN KEY DUP 0<> UNTIL ;`-style blocking `KEY`
actually suspends and resumes instead of throwing (M4's current
behavior) or running the interpreter to completion. Prove this by typing
a word that blocks on `KEY`, having the page stay responsive while it
waits, then having a keystroke unblock it — the same shape
`FORTH-ARCHITECTURE.md` §5 already anticipated ("the Forth executor is a
task... blocking on the input queue") and §7a now makes concrete.

**Design decisions locked in (2026-07-31, with Oliver):**
- **Execution model: generator/step-function on the main thread**, not a
  Web Worker. Rationale: this is the model that's actually faithful to
  both hardware targets — Rebel-ROM's Circle `CScheduler`/`CTask` is
  cooperative and single-core, and Rebel-Board (bare-metal RISC-V, no
  Circle, no OS) will need the same hand-rolled cooperative shape by
  necessity. A Web Worker's real preemption and message-passing wall
  doesn't exist on either target — building it into Rebel-Sim now would
  mean simulating a machine this project doesn't have. Web Worker
  migration remains available later (M1's original note, still
  unchanged) if a real need for preemption surfaces.
- **I/O binds through the `Channel` abstraction from `CHANNELS-DESIGN.md`
  / `FORTH-ARCHITECTURE.md` §7a**, not directly against `Keyboard`. This
  is what actually buys future WebMCP integration ease (M8) — the
  interpreter and blocking `KEY` word don't change when a `RemoteChannel`
  is added later; only a new `Channel` implementation is bound.
- **Channel scope is input-only.** `EMIT`/`TYPE` continue to call
  `screen.emit()` directly, unchanged from M3 — per §7a's reconciliation,
  output was never meant to be channel-routed.

### 1. Engine core (`packages/engine`)

- **`channel.ts`** — the `Channel` interface (`hasData(): boolean`,
  `readByte(): number`, per §7a) and `KeyboardChannel`, a thin wrapper
  around the existing `Keyboard` class: `hasData()` peeks for the next
  event with a non-zero translated char (skipping/discarding
  char-0 events, same filter rule as §7a), `readByte()` pops and returns
  it. No changes needed to `keyboard.ts` itself — M4's `hasEvent()`/
  `readEvent()` already have the right shape underneath.
- **`inner.ts`** — the real change. Rework `executeXT`'s loop into a
  resumable step function: either (a) a generator (`function*`) that
  `yield`s at defined points (start of each outer-loop iteration, and
  whenever a blocking primitive's channel has no data), or (b) an
  explicit saved-continuation object (IP, IS-BLOCKED flag, which channel
  it's waiting on) that a driving loop re-enters. Prefer (a) — generators
  give resumable-suspend for free without hand-rolling continuation
  state, and TypeScript's generator support is mature enough not to be a
  risk here.
- **`primitives.ts`** — new primitive: blocking `KEY` ( `-- char` ).
  Distinct from M4's non-blocking `KEY`/`KEY?`, which stay as-is for
  programs that want polling (`FORTH-ARCHITECTURE.md` §7's "blocking is
  layered on top, not a HAL-level choice" rule). Blocking `KEY` checks
  the bound channel's `hasData()`; if false, the generator yields a
  "blocked, waiting on channel X" signal instead of a normal step;
  `Machine` won't resume that point until the driving loop observes
  `hasData()` true again.
- **`machine.ts`** — `Machine` gains a bound `Channel` reference (default
  `KeyboardChannel` wrapping its own `keyboard`), and `interpret()`
  becomes step-driven rather than run-to-completion: a `step(budget:
  number)` method that runs up to `budget` primitives (or fewer if it
  hits a yield/block point) and returns a status (`'idle' | 'blocked' |
  'more-to-run'`). This is what the outer driving loop (below) calls
  repeatedly.
- Tests: a synthetic `Channel` test double that starts empty and gets
  fed data after N `step()` calls, proving blocking `KEY` actually
  suspends (doesn't throw, doesn't busy-loop past the block point) and
  resumes with the right value once data arrives; a step-budget test
  (long-running colon-definition split across multiple `step()` calls,
  confirming intermediate stack state is consistent between them);
  endianness/regression suite from M1-M6 unaffected.

### 2. Angular shell (`packages/app`)

- **Driving loop**: installed via `NgZone.runOutsideAngular()` (per
  `PORTING-WEB.md` §6, already the pattern since M1), calling
  `machine.step(budget)` repeatedly via `setTimeout(0)` or
  `queueMicrotask` between calls so the browser's own event loop (and
  keyboard event delivery) gets a turn between steps — this is the
  "yield periodically" half of the cooperative model.
- **Render cadence**: `requestAnimationFrame`-driven, independent of
  `step()`'s own pace — matches `PORTING-WEB.md` §6's "timer-tick-drives-
  render, independent of interpreter pace" analog to Rebel-ROM's
  `CKernel::Run()` tick. Only cross back into the Angular zone when a
  frame actually needs to render or the status line needs updating.
- REPL `<input>` submission now calls `machine.step()` in a loop until
  `'idle'` rather than a single synchronous `interpret()` call — the
  visible behavior (type `2 3 + .`, see `5`) is unchanged; what changes is
  that a blocking `KEY` inside a compiled word no longer throws.

### 3. Explicitly deferred out of M7

`RemoteChannel`/WebMCP itself (M8 — the `Channel` interface is designed
for it now, but the actual binding isn't built this milestone), Web
Worker migration (unchanged open decision, revisit only if main-thread
performance genuinely becomes a problem), `hal_error`/exception model
(§9, still genuinely open on every target), multi-arena/independent
sessions (§7a's open question — only one `Channel` binding exists until
a second one is actually needed).

### Verification

- Engine unit tests per above, all passing alongside the existing M1-M6
  suite.
- Live browser check: run a blocking-`KEY`-based word, confirm the page
  stays responsive (can still interact with other UI, scrollback still
  renders) while it waits, confirm a keystroke unblocks it and the word
  completes correctly, no console errors — same "test the golden path in
  a browser" bar M1 set.

## M7a — On-Screen REPL — **planned**

**Goal:** typing at the keyboard reads and echoes directly through the
screen — the last of M1's browser-presentation stand-ins retired.
Output moved onto the real `Screen` surface in M3; input is still the
M1-era line-buffered DOM `<input>`, always documented as temporary. M7's
`KeyboardChannel` + blocking-I/O plumbing is what finally makes retiring
it possible.

**Design:**
- New primitive: `ACCEPT` (classic Forth line-input word) — reads chars
  one at a time off the bound `Channel` (blocking `KEY` under the hood),
  echoing each through `screen.emit()` as it arrives; handles backspace
  (erase the last echoed char, per `CScreenModule`'s no-scroll cursor
  rules from M3); returns/submits the accumulated line on Enter.
- The outer loop's REPL prompt becomes: draw a prompt, `ACCEPT` a line
  onto the screen, interpret it, repeat — the visible on-screen
  interaction a real Forth machine has, not a separate scrollback pane.
- Retire `packages/app`'s `<input>` element and its submit handler.
- **Consequence, not a new decision:** M4's "DOM focus on the `<input>`
  is the routing switch" note (its own deliberately-simple stand-in) goes
  away with the element it was routing for — nothing to replace it with
  yet, since there's still only one `Channel` binding until M9.

**Deferred:** cursor/line editing beyond backspace (arrow-key recall,
insert-in-middle) — not required to prove the goal, revisit only if it
turns out to matter for actual day-to-day use.

## M8 — Core Vocabulary — **planned**

**Goal:** the primitive/control-flow/defining-word set a "passable"
Forth needs before source screens can build anything portable on top of
it. Everything is currently missing — M1-M7 shipped arithmetic, basic
stack ops, comparison, logic, screen, and keyboard primitives, but
nothing beyond that.

**Full specification: `CORE-VOCABULARY.md`** — split out as its own
document rather than kept inline here, since it's meant to be shared
verbatim across Rebel-Sim, Rebel-ROM, and Rebel-Board (same relationship
`FORTH-ARCHITECTURE.md` and `CHANNELS-DESIGN.md` already have to this
repo). Covers memory access, return-stack words, control flow (needs two
new opcode tokens — `BRANCH`/`0BRANCH`, not yet in
`FORTH-ARCHITECTURE.md` §0's canonical table), defining words
(`CREATE`/`DOES>`, needing two more — `DOVAR`/`DODOES`, flagged `[OPEN]`
there pending confirmation before implementation starts), strings, and
the remaining stack/arithmetic ops.

**Sequencing note (why this comes before M9, not after):** a remote/MCP
channel's value is in letting an agent define and exercise Forth words
interactively — with none of `CORE-VOCABULARY.md`'s words built, there's
nothing to define anything *with*. `Channel` binding (M7/M7a) and
vocabulary completeness (M8) are orthogonal axes; there's no dependency
forcing the remote channel first, and every reason to want a system
worth talking to before opening a remote surface onto it.

**Deferred out of M8:** `LOAD`/screen-source interpretation itself (a
related but distinct subsystem — reading a `SCRS` bank's contents as
Forth source, per `FORTH-ARCHITECTURE.md` §7's storage-model note) is
not in this milestone's scope; M8 is what a screen's *contents* would be
written in, not the loader that reads them in. Revisit once M8's
vocabulary makes writing something worth loading realistic.
