# Rebel-Sim — Web Porting Guide (for a fresh coding agent, fresh repo)

You are building **Rebel-Sim**: a browser-based, fast-iteration simulator
for **Rebel**, a bare-metal "keyboard computer" whose real hardware
implementation (**Rebel-ROM**, C++ on Raspberry Pi via
[Circle](https://github.com/rsta2/circle)) is the reference
implementation. Rebel-Sim's job is to run **identical Forth source** to
Rebel-ROM, at the word-definition level, so tool/content development can
happen at browser-refresh speed instead of flash-a-Pi speed.

**Read `FORTH-ARCHITECTURE.md` first — in full.** It is the actual
specification: cell width, memory/bank layout, sysvars, the threading
model, the dictionary header, the HAL contract, and the state-portability
claim. It already carries a **"Porting to Rebel-Sim"** note under most of
its rules — treat those as directives, not suggestions. This document is
the companion piece: it covers the parts specific to *building a web app*
that `FORTH-ARCHITECTURE.md` deliberately doesn't — Angular project shape,
canvas rendering, browser storage, PWA packaging, and the handful of
browser-runtime gotchas (Angular's zone, event loop scheduling) that will
bite you if you don't know about them going in.

**Important assumption check:** you almost certainly do **not** have the
Rebel-ROM C++ source tree available in this repo — only
`FORTH-ARCHITECTURE.md` (and whatever else was copied alongside it).
Where that document names C++ classes and methods (`CBankTable::
CreateBank`, `CScreenModule::Emit`, `CKeyboardModule::ReadEvent`, …),
read those as **precise descriptions of required behavior to replicate**,
not APIs to bind against — there is nothing to link. Your job is a
faithful reimplementation of the same semantics in TypeScript, not a
wrapper around the original code.

Stack assumed for this port: modern TypeScript, Angular (recent major —
standalone components, signals, the current PWA schematic), canvas as the
framebuffer. Nothing below is a mandate beyond that; pick concrete
patterns as you go and let real constraints (not speculative
future-proofing) drive the decisions.

---

## 0. Calibrating effort

Rebel-Sim exists to make Forth-source iteration fast, not to be a
polished consumer product. A serviceable canvas renderer, a workable
keyboard pipeline, and a storage layer that round-trips are enough to be
useful on day one. Don't gold-plate UI chrome, don't build settings
screens nobody asked for, and don't add abstraction layers "for later" —
the whole Rebel project's own stated philosophy (visible throughout
`FORTH-ARCHITECTURE.md`'s cross-checks) is to build the minimum real
thing, prove it, and let the next actual need drive the next change.
Carry that same discipline here.

## 1. Keep the engine framework-agnostic; Angular is the shell

The most important structural decision you'll make: the Forth engine
(arena/bank memory, sysvars, the inner/outer interpreter, the HAL
surface) should be a **plain TypeScript core with zero Angular
dependencies** — no `@Injectable`, no signals, no RxJS inside the engine
itself. Angular's job is to be a thin shell around it: a canvas element,
keyboard event listeners, a storage adapter, and enough UI to boot it and
watch it run.

Why this matters, concretely:

- The flat arena is the one source of truth (`FORTH-ARCHITECTURE.md` §3)
  — the same status Rebel-ROM's arena has relative to `CKernel`, which is
  itself just an orchestrator over independent modules, not the owner of
  program state. Let Angular components be *views* over that state
  (reading `SYSV`/`CHAR`/pixel data to render a frame), never the state
  itself. If dictionary/stack/sysvar data starts living in Angular
  component fields or signals instead of the arena's own backing buffer,
  you've broken the one guarantee (`FORTH-ARCHITECTURE.md` §8) that makes
  "dump this, load it on the Pi" meaningful.
- A framework-agnostic core is trivially unit-testable without spinning
  up Angular's test bed, and trivially reusable if you ever want a
  headless/CLI mode (batch-running Forth source for CI, say) alongside
  the browser UI.
- It keeps the "shared source across three targets" goal honest —
  Rebel-ROM's engine doesn't know Circle exists any more than it has to
  (banks/sysvars/HAL calls are the only boundary); Rebel-Sim's engine
  shouldn't know Angular exists any more than it has to either.

A clean split to aim for: an engine package/library that exposes memory
access, sysvar access, and the HAL call surface as plain functions/classes
operating on `ArrayBuffer`s — and an Angular app that wires a canvas,
keyboard listeners, and a storage backend to that surface. Where exactly
you draw that line (a separate npm workspace package vs. a folder
boundary within one app) is your call; the boundary mattering is the
point, not its physical shape.

## 2. Memory: arenas as `ArrayBuffer`s

Per `FORTH-ARCHITECTURE.md` §3/§3.7 (which you should have just read in
full): one arena = one `ArrayBuffer` + `DataView` pair. Multiple arenas
(the isolation model) = multiple such pairs, each with its own generated
bank-offset table. A few things worth internalizing before you write the
accessor layer:

- **Endianness is the one place a subtle bug hides for free**
  (`FORTH-ARCHITECTURE.md` §2): `DataView` defaults to big-endian; Rebel
  is little-endian everywhere, no exceptions. Build the `readCell`/
  `writeCell`-style accessor described there *first*, wrap every single
  `DataView` call through it, and never call `getUint32`/`setUint32`/etc.
  directly from anywhere else in the codebase. This is exactly the kind
  of thing that works fine in isolation and then silently produces
  garbage the moment you try to load a state dump captured on Rebel-ROM.
- **The 32-bit cell ceiling is real even though a `DataView` isn't
  hardware-limited to 4GiB** (§1's porting note) — don't let an arena's
  addressable region exceed what a 32-bit offset reaches just because the
  browser would happily let you allocate more. If it matters that a
  Rebel-Sim-authored state dump can boot on real hardware, this is a hard
  constraint, not a soft one.
- **Two different "current arena" concepts, from §3.7 — don't conflate
  them.** Which arena a running Forth task's memory belongs to is fixed
  for that task's lifetime (no mid-flight switching, no "which arena" check
  on every `@`/`!`). Which arena the *user* is currently looking at is a
  separate, genuinely-switchable piece of UI state. If you find yourself
  threading a mutable "current arena" flag through the interpreter's inner
  loop, you've reintroduced the segment:offset-style design
  `FORTH-ARCHITECTURE.md` explicitly rejected — back up.
- Bank offsets (which tag lives at which offset, per arena) should come
  from the same generated source-of-truth artifact described in
  `FORTH-ARCHITECTURE.md` §0 — don't hand-pick them independently just
  because this is a different repo. If that generated artifact isn't
  available to you yet (likely, on a fresh checkout with no shared build
  pipeline set up), that's a real gap to flag back to whoever's driving
  this port, not something to quietly work around with your own guessed
  layout.

## 3. The screen: canvas as a real framebuffer, not a text UI

Rebel's screen model (`docs/SCREEN-MODULE.md` on the Rebel-ROM side,
summarized in `FORTH-ARCHITECTURE.md` §7's HAL notes) is **one
framebuffer, always graphics**, with a character-code grid pushed
one-directionally into it via bitmap-font blitting. That's the behavior
to replicate — not an approximation using real DOM text nodes or CSS.

Concretely:

- A single `<canvas>` (2D context is almost certainly the right call —
  Rebel-ROM's own `C2DGraphics` layer is a plain blit-and-flip 2D
  abstraction, not a 3D pipeline; reach for WebGL only if you hit an
  actual performance wall, not preemptively) is your framebuffer analog.
  `ImageData`/`putImageData` gives you the kind of direct pixel access
  that matches raw framebuffer semantics most closely, if a Forth word
  ever pokes individual pixels directly.
- Keep a **separate, small in-memory character-code grid** (the `CHAR`
  bank analog) distinct from the canvas pixel buffer — text output writes
  a character code into that grid *and* blits the corresponding glyph
  onto the canvas, exactly mirroring the write-through relationship
  described in `FORTH-ARCHITECTURE.md`'s `hal_emit`/`hal_plot_char`
  porting notes. Don't let canvas pixels be the only record of what's on
  screen — you need the character grid as backing data for the
  redraw-on-arena-switch behavior below, and because a real machine's
  `CHAR` bank is itself Forth-addressable memory, not a rendering detail.
- Bitmap font rendering: rasterize your chosen font into a lookup table
  once (glyph → pixel pattern), then blit from that table on write — same
  "dumb bitmap-blit, no smarts at runtime" principle the real font
  pipeline commits to. Don't reach for canvas's own text-drawing API
  (`fillText` et al.) as the rendering path; it doesn't give you
  bitmap-exact parity with a real 8×8/16×16 font grid, and it can't
  represent a Forth program poking a glyph cell directly as memory.
- **Arena-switch redraw**: per §3.7, switching which arena is attached
  means finding-or-creating that arena's own character-grid bank and
  repainting the canvas from its contents — not clearing to blank. If
  you've kept the character grid as real backing data (above), this is a
  straightforward full-grid re-blit, not a special case.
- If/when different arenas end up wanting different resolutions (a
  parked idea on the Rebel-ROM side, gated on an open hardware question
  there — see `PLAN.md`'s Phase 10 spike if it's available to you) —
  resizing a `<canvas>` element at runtime is trivial in a browser, unlike
  on real hardware. Don't let that ease tempt you into building it ahead
  of the Rebel-ROM side actually resolving whether it's real; keep the
  two targets' capability sets honest, per `FORTH-ARCHITECTURE.md`'s
  whole framing.

## 4. Keyboard: raw events in, translated non-blocking queue out

Match `CKeyboardModule`'s shape (`FORTH-ARCHITECTURE.md` §7's porting
note), not the browser's own cooked-input conveniences:

- Listen to raw `keydown`/`keyup` — never bind a hidden `<input>` element
  and read its value, which cooks/composes input in ways that don't
  correspond to a HID usage code stream at all.
- Feed events into a small **non-blocking ring buffer**, translated
  through a keymap-equivalent table, exactly mirroring the real device's
  raw-usage-code → character pipeline. `hal_key_pressed?`/`hal_get_key`
  should be non-blocking reads against that queue; build any blocking
  `KEY` word as a layer on top (an `async`/`Promise`-based wait for
  "queue became non-empty"), not by making the queue itself block.
- Only the currently-attached arena should receive routed input — same
  "focus" principle as screen attachment.
- `preventDefault()` on keys you intend to handle (arrows, Tab, function
  keys) so the browser's own defaults (Tab moving focus, F-keys opening
  dev tools, etc.) don't fight your input model once this is running as
  an installed PWA rather than a page with other UI to tab through.

## 5. Storage: synchronous beats a closer directory-shape match

The Rebel-ROM storage model (`docs/STORAGE.md`, summarized in
`FORTH-ARCHITECTURE.md` §7's porting note) is a real directory structure —
named project folders, each holding named typed asset files — not a flat
block device. An earlier version of this section picked a browser storage
API by *shape* match (a real filesystem API over key-value storage);
**[Revised, M33]** shape turned out to be the wrong axis to optimize —
synchronicity is, for a reason specific to this project's cross-target
premise:

- **[Originally decided, then reversed, M33]** OPFS
  (`navigator.storage.getDirectory()`) was the first real implementation —
  real directory/file handles, the closer conceptual match to
  `/PROJECTS/<name>/asset.ext`. But OPFS's actual read/write calls are
  Promise-based on the main thread (its synchronous
  `FileSystemSyncAccessHandle` API is Worker-only, and `packages/app`'s
  interpreter runs on the main thread, §6's own settled M7 call — unchanged
  by this section). That async requirement didn't stay contained to the
  storage module: it forced `repl.ts`'s core `step()`/`StepStatus` to grow
  a dedicated `'storage'` suspend-and-resume state just so `SAVE`/`RESTORE`
  could exist at all, which in turn meant those had to be special
  outer-loop-only syntax rather than genuine dictionary words — unusable
  inside a colon-definition or via `EXECUTE`, a real vocabulary-level
  wart. That's a browser-platform artifact dictating the shared
  cross-target engine contract other Rebel targets are supposed to
  mirror, not a real requirement — real hardware's own storage access
  (Rebel-ROM's `CStorageModule`, bare-metal blocking FAT/USB I/O) has no
  async concept at all.
- **The fix:** swap to `localStorage` — synchronous, no Promises, no
  Worker needed, ships in every browser, still persists across reloads.
  `StorageHal` (`packages/engine/src/storage.ts`) dropped every `Promise`
  from its interface as a direct result; `repl.ts`'s `'storage'`
  `StepStatus` and its suspend/resume machinery were deleted entirely;
  `PROJECT`/`SAVE`/`RESTORE` became ordinary primitives, and `BSAVE`/
  `BLOAD` (single-bank save/load) were added the same way, with zero
  special mechanism needed. Real costs accepted deliberately: values must
  be base64-encoded strings (localStorage has no binary payload type),
  and quota is much smaller than OPFS's effective disk-backed capacity
  (~5-10MB per origin, browser-dependent) — acceptable given Rebel's own
  bank sizes (four-to-few-hundred KB size classes) are nowhere near what
  would bind on that in practice.
- **General principle this established** — worth applying to any future
  Rebel-Sim-only accommodation, not just storage: before letting a
  browser API's shape (async, or anything else genuinely absent on real
  hardware) become a requirement in the shared engine/vocabulary contract,
  check whether it's actually load-bearing for the cross-target premise or
  just the easiest-looking web implementation. Prefer a Rebel-Sim-side
  workaround — even one that trades away capacity, native ergonomics, or
  a closer conceptual match — over letting the web dictate what other
  targets are allowed to look like.
- The *addressing contract* `FORTH-ARCHITECTURE.md` establishes is
  unchanged by any of this: `hal_block_read`/`hal_block_write` operate on
  an in-memory bank, and persistence to the storage backend happens at
  project open/close time (now: `SAVE`/`RESTORE`/`BSAVE`/`BLOAD` calls) —
  a bank access, not a storage-device call on every read/write.
- For moving state in and out of the browser sandbox entirely (sharing a
  project with someone, or with a real Rebel-ROM device) — the File
  System Access API (`showOpenFilePicker`/`showSaveFilePicker`) or a
  plain download/upload flow are both reasonable "insert a USB stick"
  analogs, and both are still synchronous-vs-async-neutral to this
  section's own concern (they're one-shot user-gesture-triggered
  transfers, not something a running Forth word calls into). Neither is
  clearly correct in the abstract; pick based on which browsers/contexts
  you actually need to support.

## 6. The execution loop, and Angular's zone

Rebel-ROM's execution loop (`docs/EXECUTION-LOOP.md`, referenced in
`FORTH-ARCHITECTURE.md` §5's porting note) is a cooperative loop: the
Forth task runs, yields periodically or blocks on I/O, and a timer tick
drives rendering on its own cadence, independent of the interpreter's own
pace. Reproducing that shape in a browser has a few real gotchas:

- **Don't run the interpreter's hot loop inside Angular's zone.** Angular
  patches timers, event handlers, and promises so that change detection
  runs after (almost) everything — fine for UI code, actively harmful for
  a tight interpreter loop that might tick thousands of times before it
  next needs to touch the DOM. Use `NgZone.runOutsideAngular()` (or
  whatever the current-version equivalent is) for the interpreter's own
  loop, and only cross back into the zone when you actually have a frame
  to render or UI state to update. Getting this wrong doesn't crash
  anything — it just makes the simulator mysteriously slow, and slow in a
  way that's easy to misattribute to "the interpreter is slow" rather
  than "change detection is running every single tick."
- A `requestAnimationFrame`-driven render cadence is a reasonable analog
  to Rebel-ROM's timer-tick-drives-render split: let the interpreter
  yield on its own schedule (a `setTimeout(0)`/microtask break, a
  generator-based step function, or — if you need real preemption for a
  runaway Forth program — a Web Worker) and let `requestAnimationFrame`
  own the "when do we actually blit to canvas" decision, independent of
  how fast the interpreter itself is ticking.
- A **Web Worker** is worth seriously considering for the interpreter core
  even in v1, not just as a v2 nicety: it gets you real preemption (a
  runaway or buggy Forth program can't freeze the tab's main thread/UI),
  and it cleanly enforces the "engine doesn't know about the DOM/Angular"
  boundary from §1 by construction, since a worker literally can't touch
  either. If you do this, the canvas/keyboard/storage boundary becomes a
  message-passing protocol rather than direct calls — a real design
  decision with real tradeoffs (message-passing latency, `OffscreenCanvas`
  for worker-side rendering), not a default to reach for without
  thinking it through.
- Keep blocking-vs-non-blocking HAL semantics honest under whichever
  model you pick (§7's own boolean-convention and blocking-KEY notes) —
  a worker-based design in particular makes it tempting to fake blocking
  with `Atomics.wait`, which is a legitimate option (with `SharedArrayBuffer`
  and the cross-origin-isolation headers it requires) but a real one to
  evaluate deliberately, not stumble into.
- **[Decided, M7]** Rebel-Sim went with generator/step-function on the
  main thread, not a Web Worker — it's the model actually faithful to
  both hardware targets' cooperative, single-core execution loops, where
  a Worker's real preemption and message-passing wall has no analog.
  Blocking I/O (starting with `KEY`) binds through the `Channel`
  abstraction (`FORTH-ARCHITECTURE.md` §7a, `CHANNELS-DESIGN.md`) rather
  than directly against the keyboard — that's the part that actually
  buys easy WebMCP integration later (a `RemoteChannel` binds the same
  way `KeyboardChannel` does, no interpreter changes), independent of
  the threading decision. See `PLAN.md`'s M7 section for the
  implementation plan.
- **[Decided, COLD/WARM]** `COLD` (`FORTH-ARCHITECTURE.md` §9 item 16)
  needed a fourth value alongside `'progress'`/`'blocked'`/`'breakpoint'`
  in this same generator-based `StepSignal`/`StepStatus` yield path:
  `'cold'`. `Machine`'s memory-holding fields (`arena`/`banks`/`stack`/
  ...) are `readonly`, built once in its constructor (repl.ts) — there's
  no way for the engine to rebuild itself in place, so `inner.ts`'s
  `dispatch()` special-cases the `COLD` token before it ever reaches
  `executePrimitive` (the same shape `ACCEPT`/`EXECUTE` already get) and
  yields `'cold'` instead of doing anything. `Machine.step()` surfaces
  that as `StepStatus`'s `'cold'`, same as it already does for
  `'breakpoint'`. The host — `packages/app/src/app/app.ts`'s `tick()` —
  is the only thing that actually reacts: on seeing `'cold'`, it resets
  every polled UI snapshot (`lastStackSnapshot`, `lastLatestAddr`, ...)
  and calls `performBoot()`, the same construct-`Machine`-then-
  load-`system.fth`-then-`startRepl()` sequence `ngAfterViewInit` runs
  once for the page's real first boot — swapping `this.machine` for a
  brand new one. `WARM`, by contrast, needed none of this: it only
  touches bytes already inside existing banks (the stacks, `STATE`), so
  it's a plain primitive (`primitives.ts` case 131) that does its reset
  in place, no host involvement at all. One easy-to-miss consequence:
  `registerWebMcpTools()` used to capture `const machine = this.machine`
  once at registration time — harmless when `this.machine` was assigned
  exactly once, ever, but a real staleness bug once `COLD` can replace
  it later. Every WebMCP tool closure there now reads `this.machine`
  fresh on each call instead.

## 7. PWA: instant-on is the point, not a checkbox

Rebel's entire premise (`BRIEF.md`, if you have it available) is
instant-on, no boot ceremony — a PWA that still needs a network round
trip to become usable, or that shows a loading spinner before the
simulator appears, undermines exactly the thing this project is about.
Treat offline-first as a real requirement, not an optional enhancement:

- Precache everything needed to boot to a usable Forth prompt — the app
  shell, the compiled/bundled engine, font data, and whatever the
  generated opcode/sysvar artifact from `FORTH-ARCHITECTURE.md` §0
  compiles down to. A service-worker cache-first (or stale-while-
  revalidate, if you want updates to arrive without blocking a launch)
  strategy for these is the right default.
- Make it genuinely installable (a correct manifest, icons, the works) —
  an installed PWA that launches straight into the simulator, no browser
  chrome, no address bar, is the closest web equivalent to "power on,
  straight into Forth" that exists on this platform.
- Persistent storage: request `navigator.storage.persist()` so a user's
  projects (§5) aren't subject to casual eviction the way ordinary
  origin storage can be — losing someone's work because the browser
  decided storage was tight is a bad failure mode for a tool that's
  explicitly meant to feel like it owns its own memory.

## 8. Anti-patterns — things that will quietly compromise the port

- **Don't let the Angular component tree become the source of truth.**
  Program state lives in the arena's `ArrayBuffer`; components read it to
  render. If you catch yourself storing dictionary/stack/sysvar state in
  a signal or a service field *instead of* the arena, stop.
- **Don't render text with the DOM or canvas's native text APIs.** Bitmap
  font blitting from the character grid is the contract, not an
  implementation detail you can shortcut (§3).
- **Don't build a real text-input `<input>` element for keyboard
  handling.** Raw event capture through a translated queue is the
  contract (§4) — a cooked input box already did work (composition, IME,
  autocomplete) that has no equivalent on the real machine, and any
  behavior that depends on it will silently diverge from Rebel-ROM.
- **Don't invent your own bank/sysvar offsets independently** just
  because the generator artifact from `FORTH-ARCHITECTURE.md` §0 isn't
  wired up yet in this repo. Flag the gap; don't paper over it with a
  parallel hand-maintained layout that will drift.
- **Don't run the interpreter loop inside Angular's zone** (§6) — the
  single most likely "it works but it's inexplicably slow" trap in this
  whole port.
- **Don't build ahead of an actual need.** Multi-arena concurrency,
  per-arena display modes, worker-based preemption, IME/localization,
  settings UI — all real, all legitimate eventually, none of them worth
  building before something concrete actually needs them. This project's
  own reference implementation has a long, consistent track record of
  building the minimum real mechanism and revisiting it once a real
  consumer exists; hold this port to the same standard.

## 9. Open decisions for you to make (not gaps in this brief)

Same spirit as `FORTH-ARCHITECTURE.md` §9: these are yours to decide
once, explicitly, based on the actual constraints you're facing —
flagging them here so they get a real decision rather than an implicit
default.

1. Monorepo/workspace shape: separate `engine`/`app` packages, or a
   folder boundary within one Angular workspace.
2. OPFS vs. IndexedDB vs. a dual-path storage backend (§5).
3. Whether the interpreter runs on the main thread or in a Web Worker
   (§6), and if a worker, the message-passing protocol for canvas/
   keyboard/storage access.
4. How the `FORTH-ARCHITECTURE.md` §0 generated source-of-truth artifact
   actually gets from wherever it's authored into this repo's build
   (vendored file, published package, git submodule, manual copy) —
   this is a cross-repo coordination question with no universally right
   answer, since Rebel-Sim is explicitly a separate project/repo from
   Rebel-ROM.
5. 2D canvas vs. WebGL for rendering — default to 2D (§3) unless you hit
   a concrete, measured performance wall.
6. Exact PWA caching strategy (cache-first vs. stale-while-revalidate)
   and update-notification UX.
