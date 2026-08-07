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
   §7a, `CHANNELS-DESIGN.md`), real blocking `KEY`. Detailed below.
8. **M7a — On-screen REPL** — **done**: `ACCEPT`-based line input read
   off the bound `Channel` and echoed through `screen.emit()`, retiring
   the M1-era DOM `<input>` stand-in and the focus-based input routing
   that went with it (`PORTING-WEB.md` §4). Detailed below.
9. **M8 — Core vocabulary** *(detailed below)*: the primitive/control-flow/
   defining-word set a "passable" Forth needs before source screens can
   build anything portable on top of it — memory access, control flow,
   return-stack words, defining words, strings, remaining stack/arithmetic
   ops.
10. **M9 — Remote channel (WebMCP)** — **done**: `RemoteChannel`/
    `CompositeChannel` binding the outer loop to a WebMCP-driven input
    source via Angular's own `declareExperimentalWebMcpTool`, per §7a's
    "zero interpreter changes" design goal — no `execute_word`/
    `define_word`/`trace_execution` tools needed, a plain `type()` plus
    reads over the M8 inspector panel's introspection surface covers it
    (Forth's homoiconic). Detailed below.
11. **M10 — Breakpoints/debugging** — **done**:
    word-level breakpoints built on a third `StepSignal`
    (`'breakpoint'`) alongside M7's existing `'progress'`/`'blocked'`
    generator yields, plus the WebMCP tools to drive them
    (`debug_set_breakpoint`/`debug_continue`/etc.). Full design in
    `DEBUGGING.md`, including the one easy-to-miss required change:
    `App.startPump`'s `tick()` currently ignores `step()`'s return
    value entirely, so without an explicit "stop pumping while paused"
    flag a breakpoint would resume on the very next animation frame
    rather than actually holding.
12. **M11 — Comments compiled as retained data** — **done**
    (`DEVELOPING.md` §2.4): a new `IMMEDIATE` primitive, `(` (token 93
    — every current word, including every `IMMEDIATE` one, is a native
    primitive; there's no bootstrap-Forth-source loader yet, correcting
    this entry's earlier framing), compiling a Jupiter-Ace-style inline
    comment string instead of discarding it (comments didn't exist at
    all before this, confirmed by reading `tokenizeAndRun`'s plain
    whitespace tokenizer). Reuses `S"`'s existing `(SLIT)` compile
    mechanism via a shared `consumeQuotedText`/`compileSlit` refactor
    (fixing `S"`'s own single-token limitation for free — `S" hello
    world"` didn't actually work before) followed by a compiled
    `2DROP` call, making the comment a genuine no-op at runtime — zero
    `inner.ts`/`dictionary.ts`/`repl.ts` changes, dispatched through
    the same `IMMEDIATE`-primitive path `IF`/`S"` already use.
    Prerequisite for the `SEE`/screen-editor work sketched (not scoped)
    in `DEVELOPING.md` §3-§5. Detailed below.
13. **M12 — System vocabulary: `WORDS`/`SEE`, loaded from
    `system.fth`** — **done** (`DEVELOPING.md` §3/§6): the app now
    fetches `packages/app/public/system.fth` and feeds it through
    `machine.interpret()` line by line before `startRepl()` — the
    interim host-text-file step `DEVELOPING.md` §1 always meant to
    reach before screens exist. `WORDS` (`CORE-VOCABULARY.md` §12's
    own worked example, with one real fix — `1F AND` is a hex literal
    but `BASE` defaults to decimal, so `31` is used instead) and `SEE`
    (a real decompiler: `>CFA`/`XT-NAME` reverse-walk the dictionary,
    `LIT`/`BRANCH`/`0BRANCH`/`(SLIT)` special-cased via named
    constants captured at load time) both ship as genuine Forth
    source, not native primitives. One new primitive was still needed
    — `'` (tick, token 94) — since nothing let Forth-level code
    resolve a typed name to an `xt` at runtime before this. Detailed
    below.
14. **M13 — `VOCABULARY`/`USE`: branching dictionary chains** —
    **done** (`DEVELOPING.md` §8): one new primitive, `LATEST-ADDR`
    (token 95, `( -- addr )`), exposing the `LATEST` sysvar's own
    cell address so ordinary `@`/`!` can manipulate it — the same
    gap the (dropped) `FORGET` exploration hit, fixed generally
    rather than with a bespoke setter. `VOCABULARY`/`USE` themselves
    are genuine Forth source in `system.fth`: each vocabulary is a
    `CREATE`d cell that captures the *current* chain position at
    creation time (a branch point, not an empty chain), so switching
    into one never loses access to words that already existed —
    zero `dictionary.ts`/`findWord` changes needed, `WORDS` becomes
    vocabulary-scoped for free. Detailed below.
15. **M14 — `HIDE`: decluttering `SEE`'s own support words** — **done**
    (`DEVELOPING.md` §8.5's follow-up, resolved differently than
    originally sketched there): re-filing `>CFA`/`XT-NAME`/the `-XT`
    constants into a `SYSTEM` vocabulary turned out not to work —
    branching chains only let a *later* vocabulary see an *earlier*
    one, never the reverse, so `SEE` would become uncallable from
    `FORTH` without an explicit `USE SYSTEM` first, and even the
    other sequencing order doesn't separate "callable" from "listed
    in `WORDS`," since they're the same chain-walk. `HIDE` (pure
    Forth, zero engine changes — reuses `FLAG_HIDDEN`, the exact bit
    `findWord`/`WORDS` already skip for a colon-definition
    mid-compilation) is the right-sized tool instead: an
    already-compiled caller like `SEE` is unaffected by hiding a word
    it calls, since compiled calls are raw addresses, not names to
    re-resolve. Detailed below.
16. **M15 — `EXECUTE`** — **done**: one new primitive (token 96,
    `( xt -- )`), the gap M13/M14's write-ups both flagged and
    deferred (indirect calls only worked via manual `8 +` arithmetic
    in `USE`, and `EXECUTE` itself was confirmed absent — checked, not
    assumed). Special-cased in `inner.ts`'s `dispatch()`, not a plain
    `primitives.ts` case: it recurses into `executeXT()` itself so
    DOCOL/DOVAR/DOCON/DODOES dispatch, breakpoints, and nested
    blocking (`KEY`/`ACCEPT`) all behave identically to a direct call,
    reusing the shared `rstack` sentinel push/pop `threadFrom` already
    does for every nested call. Detailed below.
17. **M16 — `S"`/`."` real interpret-time behavior** — **done**:
    `compileOnly` removed from both (`immediate` kept — they still need
    to run at "compile" time to parse the quoted text either way);
    `S"`/`."` now each dispatch to one of two case bodies depending on
    `STATE`, not a single throw-if-interpreting path. A new `PAD` bank
    (128 bytes, same size as `TIB`) holds the text `S"` copies in while
    interpreting, exposed to Forth via a new primitive 97, `PAD ( --
    addr )`. `."` needs no PAD at all while interpreting — it emits
    directly. Closes `DEVELOPING.md` §7, open since the Canon Cat
    split-off. Detailed below.
18. **M17 — `ABORT`** — **done**: originally scoped as a full
    `THROW`/`CATCH`/`ABORT` exception model, then deliberately trimmed
    — `THROW`/`CATCH` tabled ("probably not, unless a real need shows
    up"), since none of that machinery has a consumer without `CATCH`
    itself and this project doesn't need to track ANS Forth conformance
    closely. Just `ABORT ( -- )` (token 98): empties the data stack,
    throws a plain `Error('ABORT')`, surfaces via the same
    uncaught-error path every error already used. Along the way, found
    and fixed a real, independent bug: `threadFrom`'s rstack sentinel
    push had no `try`/`finally`, so it leaked one entry per uncaught
    error, forever — confirmed empirically (0 → 1 → 2 across two
    errors) before fixing it. Detailed below.
19. **M18 — `BANK@`** — **done**: `BANK@ ( "tag" -- addr )` (token
    99), the API-mediated primitive scoped in `DEVELOPING.md` §10 —
    parses the next input token like `'`/`CREATE` do, uppercases it,
    looks up via `ctx.banks.findBank()`, pushes `addr` or throws
    `? unknown bank: <TAG>`. Addr only, not `addr size` — matches the
    `SOMETHING@` convention (fetch one value); `size` deliberately not
    returned, left to a future bank-inspection word if a real need
    shows up. Reaches shared and per-arena banks identically, no
    special-casing (isolation stays a confirmed non-goal). The
    concrete need that finally justified building it: reaching any
    sysvar from pure Forth source via `BANK@ SYSV <offset> + @`, using
    each sysvar group's known `baseOffset` (`rebel-opcodes.json`) — a
    hardcoded-offset approach the user explicitly preferred over a
    second named-lookup primitive (`SYSV@`), to avoid a redirection
    layer for no real gain. Detailed below.
20. **M19 — `MMAP`** — **done**: an arena-resident bank table (bank 0,
    64 slots, matching `rebel-rom`'s existing `BANK_TABLE_MAX_BANKS`)
    — the original Phase 3 design on the `rebel-rom` side, per its own
    `docs/MEMORY-MODEL.md` §3.2, deliberately deferred until Forth
    needed raw address access to it. Shipped as a **mirror**:
    `BankTable.createBank()` (`banks.ts`) writes every bank it creates,
    including `MMAP` itself (self-referential bootstrap, slot 0), into
    a new arena-resident `MemoryMap` (`mmap.ts`) in addition to its
    existing host-side array — `findBank()`/`getAllBanks()` are
    unchanged, still the real read path. `Bank` gained a real `flags`
    field (`RESIDENT`/`EXTERNAL`/`SWAPPABLE`/`DIRTY` matching
    `rebel-rom`'s real `TBankFlags` bit-for-bit; `ACTIVE`, bit 4, a
    Rebel-Sim-first addition — atomic exclusion during flush instead of
    finally wiring up `DIRTY`, which is confirmed genuinely inert on
    both sides). Forth-side bank creation and rewriting `BANK@`
    (M18)/`Machine.banks` to read `MMAP` directly are explicit,
    deliberate follow-on work, not done here. Found and fixed a real
    circular-import bug (`mmap.ts` importing back from `banks.ts`) along
    the way. Exact slot byte layout isn't a finalized cross-target
    contract yet — mirrored into `rebel-rom/CHANGES.md` for whoever
    picks this up on that side. Detailed below.
21. **M20 — `BANK@` reads `MMAP` directly** — **done**: a pure
    read-path swap, `BANK@` calling a new `MemoryMap.findBankAddr()`
    (walks `MMAP`'s slots directly) instead of `ctx.banks.findBank()`
    (the host TS array) — same observable behavior, proven by the
    existing `bank-access.test.ts` suite passing completely unmodified.
    The smaller, more contained half of M19's "Follow-on, not
    resolved" note; Forth-side bank creation stays separately scoped,
    not touched here. Detailed below.
22. **M21 — `CREATE-BANK`** — **done**: Forth-side bank creation, the
    larger, harder-to-walk-back half of M19's own follow-on note.
    `CREATE-BANK ( size "tag" -- addr )` calls the exact same
    `MemoryMap.addBank()` `BankTable.createBank()` already uses
    internally, invoked straight from a primitive — genuinely no host
    round-trip, matching `DEVELOPING.md` §11's original design.
    Real, named consequence: a bank created this way is invisible to
    `BankTable.getAllBanks()`/`findBank()` and everything built on
    them (`storage.ts`, `read_banks`, the inspector panel) — only
    `BANK@` (M20) and raw `MMAP` reads see it, confirmed live via
    WebMCP, not just asserted. Name always equals the (possibly
    truncated) tag, no auto-serial, no uniqueness check, no
    out-of-space validation beyond `MMAP`'s own 64-slot cap — all
    deliberate, matching "no host validation." Found a real gotcha
    while testing: a tag over 4 characters truncates on write but
    `BANK@` never truncates its search string, so it's only findable
    by its first 4 characters — not a new inconsistency, the first
    time anything could actually create a tag violating the
    already-existing 4-character convention. Detailed below.
23. **M22 — `BankTable` reads/allocates through `MMAP`, no cached
    state anywhere** — **done**: `getAllBanks()`/`findBank()`/
    `findBankByName()` read `MMAP` instead of the private `banks`
    array, closing M21's documented visibility gap — a `CREATE-BANK`
    bank now shows up in `read_banks`/the inspector panel too,
    confirmed live. **The real overlap bug found while scoping this is
    fixed**: `ACTIVE` is occupancy per slot, full stop (flush-safety
    is explicitly out of scope), so there's no cursor cell at all —
    both the next free slot and the next free memory address are
    derived by scanning all 64 fixed slots for their own `ACTIVE` bit,
    every allocation. `MMAP`'s header shrunk to just magic+version
    (`MMAP_SIZE` 1540, down from 1548 — confirmed live, every other
    bank's base shifted by exactly 8 bytes); `getNextFree()`/
    `getSlotCount()` deleted outright. `BankFlag*` constants moved from
    `banks.ts` to `mmap.ts` to avoid repeating M19's own
    circular-import bug in the other direction. **A second real bug
    found while implementing** (not scoping): `allocate()` forces
    `ACTIVE` into what it writes, but an early version built the
    returned `Bank` from the caller's raw `flags` instead of what got
    persisted — caught immediately by the pre-existing "caller-supplied
    flags" test, fixed by having `allocate()` return the actual stored
    descriptor. Detailed below.
24. Later/open: multi-arena isolation (deliberately unenforced — full
    mutual access across arenas is the intended v1 model, not a gap,
    `DEVELOPING.md` §10), `THROW`/`CATCH` (tabled, M17), a named
    sysvar lookup (`SYSV@`, considered and explicitly declined —
    `BANK@` + a hardcoded offset covers the real need), whether
    `storage.ts` should be able to `saveAsset()` a Forth-created bank
    (a new question item 23 itself raises, not decided), Web Worker
    migration — see `FORTH-ARCHITECTURE.md` §9 and `PORTING-WEB.md` §9
    for the full open-decisions list.
25. **M23 — a batch of 13 low-level primitives** — **done**: `XOR`,
    `.S`, `2SWAP`, `2OVER`, `CELLS`, `CELL+`, `FILL`, `CMOVE`, `BL`,
    `SPACE`, `WITHIN`, `PICK`, `ROLL` — tokens 101-113, same
    "STANDARD-for-now, native for now" categorization
    `CORE-VOCABULARY.md` §9 already used for the M8 batch, since
    `packages/engine` still has no `LOAD` subsystem to shift these
    into Forth source instead. Zero interpreter-loop/`repl.ts`/
    `dictionary.ts` changes needed — `repl.ts`'s boot-registration
    already walks `opcodes.primitives` generically, and none of these
    13 are `immediate`/`compileOnly`. `WITHIN` deliberately ships
    plain-signed, non-wraparound (not full ANS semantics); `CMOVE` is
    low-to-high only, no `CMOVE>` added (nothing needs it yet). New
    `low-level-batch.test.ts` (13 cases + edge cases: `0`/`1`/`2 ROLL`
    against `SWAP`/`ROT`, `0`/`1 PICK` against `DUP`/`OVER`, `.S`
    non-destructiveness, `FILL`+`CMOVE`+readback on a real
    `CREATE-BANK`'d region). Full engine suite: 232 passed (219+13).
    Live-verified via WebMCP end to end, zero console errors — see
    `DEVELOPING.md` §15 for the full transcript.
26. **M24 — `BASE`/`HEX`/`DECIMAL`** — **done**: `BASE ( -- addr )`
    (token 114) exposes the `FORTH.BASE` sysvar cell's address the
    same way `LATEST-ADDR` (M13) did for `LATEST` — read with
    `BASE @`, write with `n BASE !`, matching real Forth's own
    variable-style `BASE`, not a read-only value word. `HEX`/`DECIMAL`
    (tokens 115/116) are thin `setBase(16)`/`setBase(10)` sugar on
    top, reusing `Sysvars.setBase()`, already used by `repl.ts`'s own
    boot code. Zero `repl.ts`/`dictionary.ts`/`inner.ts` changes.
    A first-draft test (`HEX 255 .`) tripped over the exact
    every-subsequent-token-parses-as-the-new-base gotcha §16 itself
    documents — `255`'s digits are all valid hex, so it parsed as hex
    under the just-switched `BASE` before `.` ever ran; fixed by
    reordering to `255 HEX .`, and the gotcha itself got its own
    explicit test (`HEX 10 DECIMAL` leaves `16`, not `10`). Full
    engine suite: 237 passed (232+5). Live-verified via WebMCP, zero
    console errors — see `DEVELOPING.md` §16.
27. **M25 — `CURSEN`/`CURSDIS`: a visible, inverse-video text cursor**
    — **done**: neither target has ever rendered a visible cursor —
    `CURSOR-X`/`Y` are pure write-position trackers on both sides,
    checked directly against `screenmodule.cpp` and `screen.ts`.
    `Screen`-level, not HAL, not Forth: `setCursor()` gains a redraw
    hook (restore the old cell plain, invert the new one) that every
    existing cursor-movement path (`AT-XY`, `EMIT`'s auto-advance/
    `CR`/`LF`) already routes through for free. New
    `SCREEN.CURSOR-VISIBLE` sysvar (a genuine cross-target candidate,
    same situation `CORE.ARENA-SIZE` was in at M19). A real ordering
    bug found while tracing `cls()` — it set the cursor *before*
    clearing the framebuffer, which would have painted over a
    freshly-drawn cursor — fixed as part of this change. A first-draft
    test assumed 2 `blitGlyph` calls when typing at the cursor;
    actual is 3 (content write, a harmless duplicate redraw of the
    old — now just-typed — cell, then the real inverted redraw at the
    new position), confirmed against the built `dist/` before fixing
    the test. Full engine suite: 244 passed (237+7). Live-verified via
    WebMCP screenshots (a genuinely visual feature `read_screen` can't
    confirm) — see `DEVELOPING.md` §17.
28. **M26 — wire `CURSEN` into the interactive REPL** — **done**: one
    line, `this.screen.showCursor()`, added to `startRepl()` (not
    `Machine`'s constructor — would've made every programmatic
    `interpret()`/`beginLine()` caller, tests included, pay for cursor
    redraws it never asked for; not just defaulting the sysvar either
    — the redraw only fires from inside `setCursor()`/`showCursor()`,
    so a bare default sysvar wouldn't actually draw anything until the
    first keystroke). Shows the cursor immediately at the very first
    `'> '` prompt, before any typing. Full engine suite: 246 passed
    (244+2). Live-verified: a fresh page load now shows the cursor
    block right away — see `DEVELOPING.md` §18.
29. **Cross-repo heads-up gap, found and closed**: M23/M24/M25 shipped
    without a `rebel-rom/CHANGES.md` entry, unlike `MMAP`. Checked:
    M23/M24 are pure primitive-token additions with nothing in
    `rebel-rom` to reconcile against yet; M25's new
    `SCREEN.CURSOR-VISIBLE` sysvar is a real layout proposal, same
    category as `CORE.ARENA-SIZE` (M19), which *did* get an entry —
    added the matching one for M25. See `DEVELOPING.md` §19.
30. **M27 — a real bank-naming collision bug, found while reviewing
    storage** — **done**: `CREATE-BANK` bypassed the name-uniqueness
    check `BankTable.createBank()` enforces everywhere else, and
    always named a bank after its own tag — so two Forth-created banks
    sharing a tag always collided on name too, reproduced directly
    (`64 CREATE-BANK DATA` twice → both named `"DATA"`). Real,
    end-to-end storage consequences confirmed: `saveAsset()` silently
    clobbers the first bank's file; `openProject()` throws and aborts
    the *entire* project load on the collision, unlike every other
    malformed-asset case, which is skipped gracefully. Two design
    proposals tried and rejected before landing on the right one: a
    sysvar-backed counter needed an `attachSysvars()` bridge to solve
    a real chicken-and-egg problem (`Sysvars` doesn't exist until
    *after* `BankTable` has already created `SYSV`) — correctly called
    "too convoluted." **What shipped**: the counter lives in `MMAP`'s
    own header instead — available from the very first line of
    `BankTable`'s constructor, no bootstrap-ordering problem at all.
    `MMAP`'s header grows 4→16 bytes: `NEXT-BANK` (the shared counter,
    read by both `BankTable`'s own fallback and `CREATE-BANK`
    directly), `ARENA-SIZE` (moved out of `CORE.ARENA-SIZE` — arena
    bookkeeping, not interpreter state, checked-low-risk to move),
    `ARENA-ID` (reserved, `0`, future multi-arena bookkeeping per
    direct instruction, no consumer yet). Five pre-existing tests
    updated, two new ones added (genuine host/Forth interleaved-serial
    sharing; an end-to-end `storage.test.ts` case reproducing the
    original bug fully fixed). Full engine suite: 248 passed (246+2).
    Live-verified via WebMCP — `MMAP` now `1552` bytes, every existing
    bank's serial name unchanged, `CREATE-BANK`'s serials now
    genuinely sequential with no collision. See `DEVELOPING.md` §20.
31. **M28 — `SP@`/`SP!`/`SP0`, `RP@`/`RP!`/`RP0`: the stack pointer
    becomes a real sysvar** — **done**: asked (a Forth-tutorial
    question) why `SP0`/`SP@` didn't exist yet — `FORTH.SP0`/`RP0` were
    already reserved in `rebel-opcodes.json` but never written, and the
    *real* live pointer was a private `DataStack.sp` field with no
    arena address at all, the same shape of problem M27 fixed for the
    bank-naming counter. Corrected per direct instruction: sysvars
    should be the *only* place this state lives, not a copy the engine
    also keeps internally. `DataStack` now takes a `Sysvars` reference
    and two field names (`SP0`/`SP` for the data stack, `RP0`/`RP` for
    the return stack); its private `sp` field is gone, replaced by a
    getter/setter over `sysvars.getUnsigned`/`setUnsigned('FORTH', ...)`
    — `push`/`pop`/`peek`/`depth`/`clear`'s own logic is textually
    unchanged, only where the four bytes live moved. `SP0`/`RP0` (the
    constant empty-stack address) are written once at construction,
    finally populating what had been reserved-but-unused since M1. Six
    new primitives: `SP0`/`RP0` (push the constant base), `SP@`/`RP@`
    (push the live pointer), `SP!`/`RP!` (pop an address, become the
    new live pointer — the standard reset idiom). 11 new tests across
    `stack.test.ts` (pointer mechanics, independence between two
    `DataStack` instances sharing one `Sysvars`) and
    `low-level-batch.test.ts` (the primitives, including `RP@ RP0 -`
    proving the return stack's live pointer is real and observable
    mid-call). Full engine suite: 259 passed (248+11). Live-verified via
    WebMCP, including a real, documented gotcha of the same shape as
    M24's `HEX 255 .` one: `SP0 SP@ =` on one line sees `SP@` read the
    pointer *after* `SP0`'s own push already moved it — not a bug, just
    two stack-pointer words in sequence genuinely seeing different
    moments. See `DEVELOPING.md` §21.
32. **M32 — `FORGET`** — **done**: picked back up the exploration
    dropped early on (`DEVELOPING.md` §8.6's open question), asked
    about directly after noticing it was documented but never shipped.
    Same root blocker `LATEST-ADDR` (M13) fixed for `LATEST`: `HERE`
    was still read-only from Forth. One new primitive, `HERE-ADDR`
    (token 125, `( -- addr )`), exposing `FORTH.HERE`'s own cell
    address the same way — unblocks `FORGET` as pure Forth source in
    `system.fth`, reusing `HIDE`'s own reverse chain-walk (find the
    entry whose `>CFA` matches a target xt) with a different found-
    branch: `LATEST` rolls back to the forgotten entry's own link,
    `HERE` rolls back to the entry's own address — exactly what
    `dictionary.ts`'s `abortDefinition` already does for a half-built
    definition on a compile error, just reachable for any named word,
    not only the current `LATEST`. Defined right after `HIDE`, before
    the `HIDE >CFA` block, so it can still call `>CFA` by name. Known,
    deliberately unaddressed limitation carried over from the original
    open question: forgetting a word another vocabulary's own branch
    point depends on leaves that vocabulary's chain corrupted — not
    designed, since neither feature needs it together yet in practice.
    Detailed below.
33. **M33 — Storage becomes synchronous (`localStorage`, not OPFS);
    `BSAVE`/`BLOAD`** — **done**: asked for `BSAVE`/`BLOAD` (save/load
    one named bank), which surfaced a bigger problem worth fixing
    first — `PROJECT`/`SAVE`/`RESTORE` (M29) were outer-loop-only
    special syntax, not real dictionary words, purely because OPFS's
    browser API is Promise-based, which had forced `repl.ts`'s core
    `StepStatus` to grow a dedicated `'storage'` suspend/resume state.
    Checked against `FORTH-ARCHITECTURE.md`'s own porting note and
    `HAL.md` §2: real hardware's storage access is ordinary synchronous
    host code, no async concept at all — the requirement never came
    from the shared spec, it leaked in from a browser API choice.
    Considered and rejected: a Web Worker for the interpreter (reverses
    M7's already-settled main-thread decision, real architectural
    surgery for a problem this size doesn't warrant) and `lightning-fs`
    (checked directly against its docs — Promise/callback-only, no
    sync API, same underlying problem as OPFS with nicer ergonomics).
    Fix: swap the backend to `localStorage` — genuinely synchronous, no
    Promises, no Worker, persists across reloads, at the cost of a much
    smaller quota (~5-10MB vs. OPFS's disk-backed capacity) and
    base64-encoded payloads (localStorage is string-only) — acceptable
    given Rebel's own bank sizes. `StorageHal` and every `Storage`
    method dropped `async`/`Promise` entirely; `repl.ts`'s `'storage'`
    `StepStatus` and its suspend/resume machinery deleted; `PROJECT`/
    `SAVE`/`RESTORE` became ordinary `primitives.ts` dispatch cases
    (tokens 126-128) — real dictionary entries now, `SAVE` (no
    name-parsing argument) fully usable compiled or via `EXECUTE`. Two
    new primitives, `BSAVE`/`BLOAD` (tokens 129-130), resolve a bank by
    tag (`BankTable.requireBank`, `BANK@`'s own addressing) and call a
    new `Storage.loadAsset()` (the single-bank counterpart to
    `openProject()`) alongside the existing `saveAsset()`. Known,
    inherited (not new) limitation: `PROJECT`/`RESTORE`/`BSAVE`/`BLOAD`
    still parse their argument via `nextInputToken()`, the same shape
    `BANK@`/`CREATE-BANK`/`'` already have, which only resolves
    correctly interpreted directly, not compiled with a following
    literal. Detailed below.

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
  design, that limitation never actually bites. **This held only through
  M28** — M29 gave storage a Forth-reachable trigger (`SAVE`/`RESTORE`)
  after all, which quietly did make the limitation bite (special
  outer-loop-only syntax, a dedicated interpreter-suspension state), a
  contradiction nobody caught at the time. Fixed at M33 by dropping OPFS
  for a genuinely synchronous backend (`localStorage`) instead of ever
  needing the Worker this passage correctly identified as the only way
  to keep OPFS itself synchronous.

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

## M7 — Execution Loop & Channel Binding — **done** (2026-07-31)

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

### What actually shipped, and where the plan above got refined

The design above held up essentially as written — generator-based
`inner.ts`, input-only `Channel`, `EMIT` untouched — with one real API
refinement made during implementation, plus one correction to a claim
`CHANNELS-DESIGN.md` made about existing (pre-M7) behavior.

**API refinement: `interpret()` stayed, `beginLine()`/`step()` sit
underneath it, rather than `interpret()` itself becoming the step-driven
entry point.** The plan's phrasing ("`interpret()` becomes step-driven")
would have meant `interpret()` no longer runs a line to completion
synchronously — but 60 of the 61 existing M1-M6 tests call `interpret()`
expecting exactly that (`m.interpret('2 3 + .'); expect(m.screen...)`,
with no `step()`-driving in between). Rewriting that whole suite wasn't
warranted for a change with no behavioral upside for non-blocking
lines. Instead: **`beginLine(line)`** starts a session without running
anything (throws if a previous session is still alive — the single-
session model, `CHANNELS-DESIGN.md` §4); **`step(budget)`** drives up to
`budget` primitives, returning `'idle' | 'blocked' | 'more-to-run'`;
**`interpret(line)`** is now sugar for `beginLine(line)` + a
`step(Number.MAX_SAFE_INTEGER)` call. Since nothing expressible in
Rebel-Sim's Forth today can loop or recurse (M2's documented cut — no
`RECURSE`/control-flow words exist yet), the *only* way `step()` can
ever return before finishing is a blocking `KEY` with nothing queued —
so for every M1-M6 test (none of which touch `KEY`), `interpret()`
behaves byte-for-byte as before, no rewrite needed. The one real
behavior change, isolated to a single test: a line that blocks now
returns from `interpret()` with the session still alive (continue it via
`step()`) instead of throwing "no event queued" (M4's stand-in
behavior).

**Correction to `CHANNELS-DESIGN.md` §3's claim about existing KEY/KEY?
filtering.** The doc states unmapped keys have "no byte-stream
representation and stay invisible to Channel, exactly as it already does
to KEY/KEY?" — checking the actual M4 code, that wasn't quite true:
`KEY` (primitives.ts case 30) popped the raw next queued event
regardless of its translated char, so a modifier-press event ahead of a
real key would have surfaced as `char 0` rather than being skipped. Fixed
as part of this milestone: `Keyboard` gained
`hasTranslatedEvent()`/`readTranslatedChar()` (skip-and-discard char-0
events, non-destructive peek for the former), and `KeyboardChannel`
wraps those rather than `Keyboard`'s raw `hasEvent()`/`readEvent()` —
which `KEY` now goes through instead of `Keyboard` directly. `KEY?`
(token 29) is intentionally untouched: it still reports on the raw,
unfiltered queue, a deliberately different (lower-level, diagnostic)
view than the one `KEY`/`Channel` now present.

**What shipped:**
- `channel.ts` — `Channel` interface (`hasData`/`readByte`) and
  `KeyboardChannel`, exactly as planned.
- `keyboard.ts` — the two new filtering methods above.
- `inner.ts` — `executeXT` is now a generator (`Generator<StepSignal,
  void, void>`) yielding `'progress'` once per DOCOL slot/primitive
  dispatched, or `'blocked'` (repeatedly, without ever advancing `ip`)
  while `KEY`'s dispatch waits on `ctx.channel.hasData()`. This fell out
  naturally from M2's own earlier design choice to thread DOCOL nesting
  through an explicit `ip`+`rstack` loop rather than JS recursion —
  there was no call-stack depth to preserve across a suspend, only one
  loop-local variable a generator already keeps alive across `yield` for
  free.
- `repl.ts` — `runLine`/`interpretExecuting`/`interpretCompiling` are now
  generators too (`yield*`-delegating into `inner.executeXT`),
  `beginLine`/`step`/`interpret` as described above, `Machine` gained a
  `channel` field (`MachineOptions.channel`, default `KeyboardChannel`
  wrapping its own `keyboard`).
- `primitives.ts` — `PrimitiveContext` gained `channel: Channel`; `KEY`
  (case 30) reads via `ctx.channel.readByte()` rather than
  `ctx.keyboard.readEvent()`; no longer throws on an empty queue (guarded
  by `inner.ts` before dispatch, so it always has data by the time it
  runs).
- `packages/app`: `app.ts`'s `submit()` calls `beginLine()` then a
  `requestAnimationFrame`-driven pump calling `step(2000)` repeatedly
  (outside Angular's zone throughout, per `PORTING-WEB.md` §6), crossing
  back into the zone only once the line finishes or errors. Simpler than
  the plan's `setTimeout(0)`/`queueMicrotask` framing between individual
  `step()` calls — one `requestAnimationFrame`-scheduled tick per frame,
  each doing up to 2000 primitives of work, comfortably covers every
  currently-expressible line in a single frame and still yields to the
  browser's event loop (keydown delivery included) between frames while
  blocked.
- 13 new engine tests: `channel.test.ts` (6 — `KeyboardChannel` filtering,
  non-destructive `hasData()`, shared-queue draining with
  `Keyboard.hasEvent()`), `repl.test.ts`'s new "Machine step-driven
  execution" block (7 — budget-of-1 stepping through a colon-definition
  with exact intermediate stack assertions, large-budget parity with
  `interpret()`, the single-session guard, blocking/resuming via a fake
  `Channel` test double, repeated-`'blocked'`-without-consuming-the-
  session, error-clears-session), plus `keyboard.test.ts`'s old
  throw-on-empty `KEY` test rewritten to assert blocking/resume instead
  — 74 engine tests total, all passing; 3 app tests updated to poll for
  the now-`requestAnimationFrame`-driven completion instead of asserting
  immediately post-dispatch, still passing.
- Verified live in a headless browser: a normal line (`2 3 + .`) still
  completes within one frame, indistinguishable from pre-M7; `KEY EMIT`
  with an empty queue blocks without throwing; submitting a second line
  while blocked surfaces the single-session guard error cleanly (proving
  the page never froze — the JS event loop kept running the whole time);
  pressing a key while the canvas has focus unblocks the session, which
  then correctly emits that character to the screen; the REPL is fully
  usable again immediately after; zero console errors throughout.

## M7a — On-Screen REPL — **done** (2026-07-31)

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

### What actually shipped, and one real design extension beyond the plan

The design above held as written for `ACCEPT` and the prompt/interpret
loop shape. One thing the plan didn't anticipate needing a decision on:
**`ACCEPT` itself had to become a second special-cased, multi-step
blocking operation in `inner.ts`, not a single `executePrimitive` case.**
`KEY` (M7) blocks at exactly one point per dispatch — check the channel
once, then run. `ACCEPT` needs to block *per character*, in a loop, with
real state (how many chars typed, the buffer position) carried across
however many suspend/resume cycles that takes. A plain synchronous
`switch` case has no way to express that. Solved by giving `ACCEPT` its
own generator method in `Inner` (`accept()`), built out of a small
`readCharBlocking()` helper that's the same one-yield-per-char shape
`KEY`'s dispatch already used, just factored out and called in a loop.
This is a direct, unsurprising consequence of the M7 architecture
(`StepSignal` yields compose naturally), not a redesign — worth noting
mainly because "special-case it in `inner.ts` like `KEY`" underclaims
how much more `ACCEPT` actually needs to do there.

**What shipped:**
- `rebel-opcodes.json` — new primitive token 31, `ACCEPT` ( `addr len --
  len2` ), dictionary-registered but never reaching `primitives.ts`'s
  switch (fully intercepted in `inner.ts`, same as `EXIT`/`LIT`, for a
  different reason — see above).
- `inner.ts` — `dispatch()` special-cases `ACCEPT_TOKEN` before the
  general path; `accept()` reads chars via a new `readCharBlocking()`
  helper, echoes non-control chars via `screen.emit()`, handles
  Backspace (char 8: erase the last echoed char, wrapping back across a
  screen row boundary via `screen.writeChar`+`setCursor` if the cursor
  was at column 0 — the same wrap convention `Screen.advanceCursor`
  already uses going forward) without ever going below the start of
  *this* call's input (can't erase into whatever was on screen before
  `ACCEPT` was invoked, e.g. the prompt), and Enter (char 10: terminates,
  not stored/echoed).
- `repl.ts` — a new `TIB` bank (128 bytes, tag `TIB`, own entry in
  `rebel-opcodes.json`'s `bankTags`), `Machine.startRepl()` (draws `"> "`,
  `ACCEPT`s a line into `TIB`, tokenizes/interprets it, catches Forth
  errors and prints `? <message>` directly to the screen instead of
  letting them escape, loops forever) sharing the *same* `session`/
  `step()` machinery `beginLine()`/`interpret()` already used — the two
  are mutually exclusive (CHANNELS-DESIGN.md §4's one-session model), not
  a second parallel mechanism. `beginLine()`/`interpret()` themselves are
  completely unchanged, still the right tool for feeding a line
  programmatically (tests). Also fixed a small real formatting gap found
  during browser verification, below: the REPL loop now emits a fresh-
  line before the next prompt only when the cursor isn't already at
  column 0 (i.e. only when something was actually printed) — avoids both
  "printed output runs straight into the next `>` prompt with no
  separation" and "a spurious blank row before every quiet line."
- `packages/app`: `<input>`/`<form>`/`.log` all removed from
  `app.html`/`.css`/`.ts`. `handleKeyEvent` lost its `document.
  activeElement` focus check entirely — every keydown/keyup routes to
  the simulated keyboard unconditionally now, since the DOM element that
  check existed to protect no longer exists. `ngAfterViewInit` calls
  `machine.startRepl()` then starts the `requestAnimationFrame` pump
  immediately (no longer gated behind a user "submit" action) — the pump
  now runs continuously from boot, for the page's whole lifetime, rather
  than only while a submitted line is in flight.
- **Real bug found and fixed during this milestone, not anticipated in
  the plan:** the pump's original heuristic for when to cross back into
  Angular's zone (`if (status !== 'blocked') update the stack signal`)
  is wrong for a continuously-running REPL loop specifically. A whole
  line can finish *and* the loop can re-block waiting on the next
  prompt's `ACCEPT` within the same `step()` call (interpret, loop back,
  draw `"> "`, block on the now-empty queue — all before that call
  returns) — so the exact tick where the stack actually changed can
  still report `'blocked'` as its final status, and the UI would never
  update. Fixed by comparing an actual stack snapshot against the
  previous one every tick (cheap — stack depth is small) and only
  crossing into the zone when it genuinely differs, rather than trying
  to infer "did anything change" from `step()`'s status code.
- 12 new engine tests: `accept.test.ts` (5 — read-until-Enter with echo,
  backspace erasing both the buffer slot and the screen cell, backspace-
  at-start-of-input is a no-op, buffer-full silently stops storing/
  echoing but keeps listening for Enter, backspace correctly wraps back
  across a screen row boundary), `repl-loop.test.ts` (3 — prompt drawn +
  blocks on `ACCEPT` + the single-session guard rejects a concurrent
  `startRepl()`/`beginLine()`, a full typed-line-to-interpreted-result
  cycle with the next prompt landing on the following row, a Forth error
  printed to the screen without killing the loop) — 82 engine tests
  total, all passing; 3 app tests rewritten to simulate typing via
  `window`-dispatched `KeyboardEvent`s and assert on stack state instead
  of driving a DOM `<input>`/`<form>`, still passing. One test bug found
  and fixed along the way (not a real bug): an early version of the
  backspace/row-wrap test pushed 40 keyboard events into the `Keyboard`
  queue's real 31-event capacity before draining any of them, silently
  losing the overflow — fixed by draining each keystroke immediately,
  matching how actual typing (one event at a time, pump draining
  continuously) never hits that ceiling.
- Verified live in a headless browser: booted straight to a real on-
  screen `>` prompt with zero DOM input elements anywhere on the page;
  typed `5 5 + .` and watched `10` print on its own row with the next
  prompt cleanly on the row after; typed `9`, Backspace, `8`, Enter and
  confirmed the corrected `8` (not `98`) was what actually got
  interpreted; typed an unrecognized word and confirmed `?
  unrecognized word: ...` printed to the screen with the REPL still
  alive and accepting further input immediately after; zero console
  errors throughout.

### Follow-up fix (2026-07-31): uneven glyph pixel widths at fractional `devicePixelRatio`

Reported by Oliver after using M7a's on-screen REPL for real: with more
text visible on screen, identical characters (two `l`s in "hello") were
rendering with visibly different stroke widths — one looked "correct,"
one looked thinner. Not a font bug (the ZX Spectrum glyph data ported in
M3 was never touched) and not the M7a work itself — a real bug in how
`packages/app` had been presenting the framebuffer since M3, only
becoming *visible* now that there was enough on-screen text to notice it
with.

**Root cause:** the visible `<canvas>`'s backing-store resolution was
fixed at the true framebuffer size (320x240 — `CanvasScreenHal` draws
exactly one canvas pixel per `Screen` pixel) and stretched to a
hardcoded `640px x 480px` via CSS — a clean, uniform 2x upscale only
when the browser's `devicePixelRatio` happens to be a whole number. At
any fractional DPR (Windows 125%/150% scaling, some Linux fractional-
scaling setups — all common, none exotic), the actual device-pixel
upscale factor is `2 * devicePixelRatio`, which isn't a whole number, so
different source pixels land on different numbers of physical pixels:
some columns of the *same* glyph render one physical pixel wide, others
two — exactly the "identical characters look different" symptom
reported, and exactly what "a rounding error in fractional screen math"
(Oliver's own guess) actually was.

**Fix — the standard "crisp canvas at any DPR" pattern:** split what was
one canvas into two. `CanvasScreenHal` now draws into a DOM-detached
*offscreen* canvas at the framebuffer's true 320x240 resolution,
unchanged internally. The *visible* canvas's backing-store resolution is
computed (`canvas-presenter.ts`) as an exact integer multiple of
320x240, chosen so that multiple times `devicePixelRatio` lands close to
a target on-screen size — its CSS size is then set from that backing
resolution divided by `devicePixelRatio`. The browser never needs to
scale the visible canvas at all (its backing-store pixel count already
equals its physical pixel footprint exactly, by construction); the
framebuffer -> backing-store upscale happens once, deterministically,
inside `drawImage` with `imageSmoothingEnabled = false`, done once per
animation frame by the same pump loop M7a already had running
continuously.

**A genuine side benefit, not scope creep:** this finally wires up the
decoupled render cadence `PORTING-WEB.md` §6 called for from M1 onward
("a `requestAnimationFrame`-driven render cadence, decoupled from
however fast the interpreter itself ticks") — before this fix, the
canvas was painted directly and synchronously on every single primitive
dispatch, coupling render to interpreter pace exactly as that section
warned against. Presenting once per frame from the pump was the natural
place to fix the DPR bug and happened to satisfy that original,
previously-unmet architectural note at the same time.

**What shipped:** `canvas-presenter.ts` (`computePresentationSize()`, a
small pure function — given a framebuffer size, a target CSS width, and
a `devicePixelRatio`, returns the backing/CSS size to use; picks the
nearest-neighbor integer scale via `Math.round`, never below 1x). `app.
ts`: an offscreen canvas `CanvasScreenHal` now targets instead of the
visible one; `applyPresentationSize()` sizes the visible canvas and
reapplies `imageSmoothingEnabled = false` (canvas resizes reset context
state) on init and on `window`'s `resize` event (covers DPR changing at
runtime — dragging the window to a different-DPI display, browser zoom);
the pump's `tick()` now does one `drawImage` per frame before its
existing `step()`/stack-diff work. 5 new app tests
(`canvas-presenter.spec.ts`): DPR-1 parity with the old hardcoded 2x
behavior, backing size is always an exact framebuffer multiple across a
spread of DPR values (1 through 3, integer and fractional), CSS size's
device-pixel footprint always exactly equals the backing size, scale
never drops below 1x, non-positive DPR falls back to 1 — 8 app tests
total, all passing.

**Verified live in a headless browser at devicePixelRatio 1, 1.25, 1.5,
and 2** (Playwright's `deviceScaleFactor` context option): confirmed
programmatically that the visible canvas's backing resolution is an
exact integer multiple of 320x240 at every one of those (640x480,
960x720, 960x720, 1280x960 respectively); typed "hello" at DPR 1.25 —
the exact fractional-scaling scenario that reproduces the bug — and,
zoomed into a screenshot pixel-for-pixel, both `l` characters render as
identical, uniform blocks with no stroke-width discrepancy. No console
errors at any tested DPR.

## M8 — Core Vocabulary — **done** (2026-07-31)

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

### What actually shipped, and where the plan/spec got refined

The word tables in `CORE-VOCABULARY.md` held up exactly as written —
every word landed with the stack effect the doc specifies. What the doc
left as sketches (the two sections it flagged `[OPEN]`) needed real
design decisions during implementation, and two genuine bugs surfaced
along the way that are worth recording precisely, since a future reader
implementing the same spec on Rebel-ROM or Rebel-Board will hit exactly
the same design points.

**Real bug #1, found by writing tests before assuming the design was
right: `IF`/`DO`/etc. were never actually marked `IMMEDIATE`.** The
initial pass added their `executePrimitive` cases and assumed marking
them immediate was someone else's problem — it wasn't; boot registration
(`repl.ts`) had always passed `extraFlags = 0` for every primitive,
uniformly, since M1. Without the fix, compiling `: TEST -1 IF 111 THEN
;` would have compiled `IF`'s own XT as an ordinary call into `TEST`'s
body — meaning `IF` would only ever run *later*, when `TEST` itself is
executed, silently corrupting `HERE` instead of building `TEST`'s
control-flow structure at compile time. Fixed by making `writeHeader`'s
`extraFlags` data-driven from `rebel-opcodes.json` (new optional
`"immediate"`/`"compileOnly"` fields per primitive) rather than
hardcoded, and — since this was the first time any *real* compile-only
words existed — actually wiring up `FLAG_COMPILE_ONLY`
(`FORTH-ARCHITECTURE.md` §6's reserved header bit 5, present since M2 but
never once checked anywhere): `interpretExecuting` now rejects a
compile-only word found while interpreting, with a clear
`X is compile-only` error, instead of silently letting it run and
corrupt dictionary state. `DictionaryEntry` gained a `compileOnly` field
alongside `immediate` to carry this through `findWord`.

**Real bug #2, only found because the CREATE...DOES> test actually
asserted a value instead of just "doesn't throw": `CREATE` never
reserved the leading does-pointer cell `DODOES`'s dispatch logic
assumed already existed.** `,`  and `(DOES>)` were both writing to the
*same* cell (`xt + CELL`) — one storing the user's data, the other later
overwriting it with the does-pointer — so `: CONST CREATE , DOES> @ ;`
`5 CONST FIVE` `FIVE` pushed `0`, not `5`. Resolved the way real Forth
systems resolve it (and the way `CORE-VOCABULARY.md` §7 was already
gesturing at without spelling out): every `dovarTokenId`-coded word
unconditionally reserves one leading cell (the does-pointer slot, inert
until/unless `DOES>` is ever applied to that specific word) — `CREATE`
reserves just that one cell; `VARIABLE` is `CREATE` plus a second,
initialized data cell, matching how `VARIABLE` is often literally
defined in terms of `CREATE` in real Forth systems. `dovarTokenId`'s
dispatch (both in `executeXT`'s top-level check and the slot-loop's
inline-call case) now uniformly pushes `xt + CELL + CELL`, past the
reserved slot, for both `CREATE`- and `VARIABLE`-made words.

**§7's other `[OPEN]` flag — the `CREATE`/`DOES>`/`DOVAR`/`DODOES`
mechanism itself — resolved exactly as sketched**, once the reserved-
cell bug above was fixed: `DOVAR`/`DOCON`/`DODOES` are three more
reserved Code Field sentinels (negative values, `-2`/`-3`/`-4`, distinct
from `DOCOL`'s `0` and the positive primitive-token space) checked once
at the top of `executeXT`, exactly like `DOCOL` already was. `(DOES>)`
(what `DOES>` compiles a call to) is IP-mutating and return-stack-
unwinding, so it lives in `inner.ts` alongside `BRANCH`/`0BRANCH`, not
`primitives.ts` — `executeXT`'s `DOCOL` branch and its new `DODOES`
branch now share one `threadFrom()` method (extracted from what used to
be `executeXT`'s own inline while-loop) since both need the identical
ip+rstack threading logic, just starting from a different `ip` and
pushing a different initial data-stack value.

**§8's `[OPEN]` flag — `S"`'s exact inline-storage mechanism — resolved
as a real, documented scope cut, not silently.** Multi-word strings
(`S" hello world"`) need a char-level input cursor (classic Forth's
`WORD`/`>IN` scanning a raw buffer for a closing delimiter) that this
project's line-tokenizer (`split(/\s+/)`) structurally can't provide —
`S"`/`."` only support a single token with no embedded spaces for now,
throwing a clear error if the next token doesn't end with `"` rather
than silently mis-parsing. (A real bug caught here too, before any test
ran: the first draft never stripped the trailing `"` from the consumed
token at all — `S" hello"` would have compiled the 6-character string
`hello"`, quote included.) `(SLIT)` — a new reserved token generalizing
`LIT`'s "inline literal cell, `ip` skips over it" mechanism to a length-
prefixed, cell-aligned byte run — is `inner.ts`'s fourth IP-mutating
special case.

**One more real thing found live-testing in the browser, not by unit
tests:** `DO...LOOP` with `limit = index` runs the loop body once, not
zero times. This isn't a bug — `DO` never pre-checks anything;  `LOOP`
is what tests, and only *after* the body has already run — a genuine,
well-known classic-Forth behavior `CORE-VOCABULARY.md` §6's terse
description doesn't call out explicitly but doesn't contradict either. A
test written assuming a check-before-first-iteration semantic caught its
own wrong assumption; fixed the test, documented the real behavior in
`rebel-opcodes.json`'s `DO` entry instead of adding an unrequested pre-
check.

**What shipped:** every word in `CORE-VOCABULARY.md` §4-§9 (~60 new
primitive tokens/sentinels, IDs 32-92 plus the three negative Code Field
sentinels) — memory access, return stack, full control flow including
nested `DO`/`LOOP` with correct `I`/`J`, `CREATE`/`VARIABLE`/`CONSTANT`/
`DOES>`, single-token `S"`/`TYPE`/`."`, and the §9 stack/arithmetic
rounding-out. `dictionary.ts` gained `compileOnly` tracking; `repl.ts`'s
boot loop reads `immediate`/`compileOnly` per-primitive from
`rebel-opcodes.json` instead of hardcoding flags; `Machine.
nextInputToken()` (shared with `:`'s own name-parsing, refactored from a
`tokenizeAndRun`-local variable into instance state) is what lets
`CREATE`/`VARIABLE`/`CONSTANT`/`S"` consume a name/string from whatever
line is *currently* being interpreted, correctly, even when called from
deep inside another word's own execution — the mechanism the
`CREATE...DOES>` pattern actually depends on.

**Tests:** 57 new engine tests across eight dedicated files
(`memory-access`, `return-stack`, `control-flow`, `do-loop`,
`defining-words`, `strings`, `stack-arith`, plus the `WORDS`
sufficiency check) — 139 engine tests total, all passing; 8 app tests
unaffected. The sufficiency check (`words-sufficiency.test.ts`) compiles
`CORE-VOCABULARY.md` §12's exact `WORDS` definition — adapted only for
`\` comments (out of scope, never a real word) and one hex literal
(`1F` → `31`, no `HEX`/`DECIMAL` word is scoped to switch `BASE`) — and
confirms it correctly lists both boot-registered primitives and
user-defined words, stack-neutral, terminating cleanly.

**Verified live in a headless browser, on the real on-screen REPL
(M7a), not just engine unit tests:** typed a `DUP *` squaring word, an
`IF`/`THEN` absolute-value word, a `BEGIN`/`UNTIL` countdown, a `DO`/
`LOOP` sum using `I`, a `CREATE...DOES>`-defined constant, an `S"`/
`TYPE` greeting, and a `VARIABLE`/`@`/`!` round-trip — every one printed
the correct result directly on the canvas, stack left clean after each,
zero console errors throughout.

## M9 — Remote channel (WebMCP)

### What the plan assumed, and what turned out to be wrong

The first design pass assumed "WebMCP" meant building bespoke
infrastructure to get MCP access into a browser tab — a Node process
hosting a WebSocket server (for the page) and an MCP-over-HTTP server
(for a client), auto-started alongside `ng serve`. That design was
never implemented: a review question ("why does this need a localhost
server at all?") prompted checking what "WebMCP" actually names, and
it turned out to be a specific, already-real web platform feature
(`webmachinelearning/webmcp`) where **the page itself** registers
tools via `document.modelContext.registerTool(...)`, with the
browser/an extension doing the client-facing bridging — no server of
any kind belongs in this repo. Better still, Angular 22.0.8 (already
the installed version here) ships this natively as
`declareExperimentalWebMcpTool`/`provideExperimentalWebMcpTools`
(`@angular/core`), confirmed directly against
`node_modules/@angular/core/types/core.d.ts` before writing any code
against it. The lesson worth keeping: an unfamiliar named technology
in a design doc is a fact to verify, not a shape to infer from the
name and prior experience with similar-sounding patterns.

### What shipped

**Engine (`packages/engine/src`):** `RemoteChannel` and
`CompositeChannel`, two small additions to `channel.ts` alongside the
existing `Channel` interface/`KeyboardChannel`. `RemoteChannel` is a
plain FIFO of chars fed by `push(text)` — deliberately uncapped, unlike
`Keyboard`'s 32-slot ring buffer, since that cap models real HID
hardware and programmatic input has no such constraint to honor.
`CompositeChannel` merges N channels into one, first-ready-wins,
scanned in argument order. `Machine`'s constructor
(`repl.ts`) gained a `remoteChannel?: RemoteChannel` option
(`channel`, if given, still wins — fully backward compatible); when
`remoteChannel` is supplied without an explicit `channel`, the
constructor binds `CompositeChannel([KeyboardChannel, remoteChannel])`
instead of a bare `KeyboardChannel` — resolved *after* `this.keyboard`
exists specifically to sidestep the chicken-and-egg problem of needing
a `Keyboard` instance to build a `KeyboardChannel` before `Machine`
itself exists. Zero changes to `inner.ts`/`primitives.ts` — `KEY`'s
dispatch through `ctx.channel` was already the M7 design's whole
point, and it held exactly as advertised.

**App (`packages/app/src/app/app.ts`):** a `RemoteChannel` field wired
into `Machine` construction, and a `registerWebMcpTools()` method
(called once, right after `this.machine` exists in `ngAfterViewInit`)
that calls `declareExperimentalWebMcpTool` six times — one write
(`type`, pushing text into `remoteChannel`) and five reads
(`read_screen`, `read_stack`, `read_return_stack`, `read_dictionary`,
`read_banks`) — every read closing directly over `machine`, reusing
exactly the introspection surface the M8 inspector panel already
exposes (`Machine.stack`/`rstack`, `listDictionaryEntries`,
`Machine.banks.getAllBanks()`, `Screen.readRowText()`). No
`execute_word`/`define_word` tools — Forth's homoiconic, so `type()`
already covers both ("`5 SQUARE .`" executes, "`: SQUARE DUP * ;`"
defines — both are just text sent to the same REPL).
`declareExperimentalWebMcpTool` needs an explicit `Injector` when
called outside a constructor/field-initializer context, so `App`
now injects `Injector` alongside its existing `NgZone`. Each
registration call is wrapped (`safeRegisterWebMcpTool`) against both a
synchronous throw and an async `Promise` rejection — WebMCP is gated
behind `chrome://flags/#enable-webmcp-testing` as of this writing, and
the app must keep booting normally on a browser without it, same as
the existing OPFS-storage-unsupported path.

**A real gap surfaced during implementation, not before:** looping
`declareExperimentalWebMcpTool` over an array of six differently-shaped
tool objects (one needs a `text` argument, five take none) fails to
compile — TypeScript's generic inference collapses to a single
`InputSchema` across the whole array/loop rather than inferring one
per element. Fixed by making each `declareExperimentalWebMcpTool` call
its own independent statement (six call sites, each its own generic
instantiation) rather than a shared loop, with the try/catch
boilerplate factored into the small `safeRegisterWebMcpTool` helper
instead.

**Verified live in the browser (updated after this session's earlier
attempt):** the first attempt used the `claude-in-chrome` extension,
which can't navigate `chrome://` pages, so the WebMCP testing flag
couldn't be enabled and `document.modelContext` was absent —
verification stopped at bypassing registration and driving
`remoteChannel` directly (see below). A follow-up session using the
**Chrome DevTools MCP server** (`chrome-devtools` — a different tool,
launched against a real Chrome instance via
`--remote-debugging-port`) *can* reach `chrome://flags`, and closed
the gap completely:

1. Navigated to the deployed GitHub Pages build
   (`https://olifink.github.io/rebel-sim/`) — `list_webmcp_tools`
   initially returned none, because `document.modelContext` genuinely
   doesn't exist yet without the flag (confirmed via
   `evaluate_script`), even on Chrome 150.
2. Enabled `chrome://flags/#enable-webmcp-testing` (and
   `#devtools-webmcp-support`) and relaunched Chrome.
3. Reloaded the app — `list_webmcp_tools` now returned all six tools
   with their real names/descriptions/schemas, registered by the
   app's own `declareExperimentalWebMcpTool` calls, no workaround.
4. Called `execute_webmcp_tool("type", {"text": "2 3 + .\n"})`, then
   `read_screen` — confirmed `5` printed on the framebuffer via the
   *actual* WebMCP tool path end-to-end, not the `remoteChannel.push()`
   bypass used previously.
5. Confirmed `read_stack`/`read_dictionary`/`read_banks` all return
   correct live data.
6. Confirmed the shared-session merge from the human side too: typed
   `: hello 5 8 * 2 + . ;` and `hello` directly at the keyboard in the
   browser window, then called `read_screen` again and saw both the
   agent-typed and human-typed lines interleaved in one console —
   `CompositeChannel` genuinely shares one live session in both
   directions, exactly as designed.

Net result: every piece of M9, including the one gap the original
verification pass couldn't close (Angular's `declareExperimentalWebMcpTool`
plumbing talking to a real `document.modelContext`), is now confirmed
working against the deployed build via a real MCP client. Caveat worth
keeping: this required the `chrome://flags/#enable-webmcp-testing` flag
even on Chrome 150 — native, unflagged support wasn't actually present
at that version despite earlier research suggesting Chrome 149+ ships
it by default. Treat "native support" claims for fast-moving web
platform features as flag-gated until directly observed otherwise.

**Tests:** `channel.test.ts` gained cases for `RemoteChannel` (FIFO
order, empty-queue `-1`, accumulation across multiple `push()` calls)
and `CompositeChannel` (no data when no sub-channel has data,
first-ready-wins in argument order, each source's own order preserved,
a mixed `KeyboardChannel`+`RemoteChannel` composite) — 151 engine tests
total, all passing; 8 app tests unaffected (`app.spec.ts`'s
keyboard-driven test staying green is what confirms `CompositeChannel`
didn't regress the M7a on-screen REPL flow).

**Consuming this today is still not this repo's job to build, but it is
now confirmed reachable.** The `claude-in-chrome` extension still can't
discover or call page-registered WebMCP tools natively (and can't
reach `chrome://flags` to enable the testing flag in the first place).
The **Chrome DevTools MCP server** (`chrome-devtools`, a separate,
general-purpose tool attaching to any Chrome instance via
`--remote-debugging-port`) does support WebMCP directly —
`list_webmcp_tools`/`execute_webmcp_tool` — and was used to verify this
milestone end-to-end above, once `chrome://flags/#enable-webmcp-testing`
was enabled. That's still a one-time, user-side browser/tooling setup
step, not anything Rebel-Sim vendors or depends on — it works against
*any* WebMCP-enabled page. This milestone's job was making Rebel-Sim
correctly WebMCP-enabled per the real spec; that job is now verified
done against a real client, not just plausible in theory.

---

## M10 — Breakpoints/debugging

Built exactly per `DEBUGGING.md`'s design — word-level breakpoints,
zero deviation from the plan's shape, one implementation-time
refinement worth recording.

**Engine (`packages/engine/src`):** `StepSignal` (`inner.ts`) gained a
third value, `'breakpoint'`, alongside M7's `'progress'`/`'blocked'`.
`Inner` gained a `breakpoints: Set<number>` constructor param (owned
and mutated by `Machine`, not `Inner` itself — `Inner` only ever reads
it) and a private `checkBreakpoint(xt)` generator, called from four
sites: `executeXT`'s top-level `DOCOL` *and* `DODOES_TOKEN` branches
(covers a breakpointed word being the very first one on a line, plus a
`CREATE...DOES>` word invoked directly), and `threadFrom`'s `DOCOL`/
`DODOES_TOKEN` branches (every nested call). Deliberately not an
if/else around the rest of the call — `yield 'breakpoint'` just pauses;
resuming continues right past it into normal entry logic, so no
"already broke here" flag is needed and a recursive/looped call to the
same word correctly re-breaks every time (verified directly —
`debug.test.ts`'s recursive-countdown case). `Machine` (`repl.ts`)
gained `setBreakpoint`/`clearBreakpoint`/`listBreakpoints` (thin
wrappers over `findWord`/`listDictionaryEntries`, no new dictionary
mechanism) and `pausedAtWord()`; `StepStatus` gained `'breakpoint'`;
`step()` gained one more early-return branch, same shape as its
existing `'blocked'` one.

**One refinement past the design doc:** `DEBUGGING.md` sketched
`debug_status` resolving the paused word's name "from the return
stack's current top frame" — on actually implementing it, that turned
out to be imprecise (the return stack's top at a breakpoint yield is
the *caller's* resume address, unrelated to the about-to-run word's
identity). Implemented instead as `Inner.pausedAtXt`, a field set right
before the `'breakpoint'` yield fires, read by `Machine.pausedAtWord()`
— simpler and unambiguous, no rstack inspection needed.

**App (`packages/app/src/app/app.ts`):** the one required, easy-to-miss
change the design doc flagged — `startPump`'s `tick()` previously
ignored `step()`'s return value entirely, so a breakpoint would have
resumed on the very next animation frame without a change here. Added
a `pausedAtBreakpoint` boolean field: `tick()` skips its `machine.step()`
call while set, and sets it when `step()` returns `'breakpoint'`. Five
new WebMCP tools registered alongside M9's six:
`debug_set_breakpoint`/`debug_clear_breakpoint`/`debug_list_breakpoints`/
`debug_status`/`debug_continue` — `debug_continue` doesn't drive
`step()` itself, it only clears the flag `tick()` already polls, keeping
"one place drives `step()`" true. Errors (`setBreakpoint`/
`clearBreakpoint` on an unknown word, `debug_continue` while not
paused) are left to propagate as real thrown errors from `execute()`
rather than swallowed into a returned string — surfaces as a genuine
tool-error state to the calling agent.

**Tests:** `debug.test.ts` (new, engine): unknown-word throws on
set/clear, idempotent clear, `listBreakpoints`, pause-with-state-intact
and resume, a breakpoint on the first word of a line (top-level entry,
not just nested), a call that never reaches the breakpointed word stays
silent, a cleared breakpoint stops firing, and a recursive word
re-breaking on every entry (4 breaks for a countdown from 3) — 160
engine tests total, all passing (151 before). `app.spec.ts` gained one
case confirming the pump genuinely holds across several animation
frames (not just the one that set the flag) and resumes correctly —
driven through `App`'s own `remoteChannel` (the same path the real
`type` WebMCP tool uses) rather than synthetic keyboard events, since
`startRepl()` has already claimed the one session by the time
`ngAfterViewInit` returns, so `machine.interpret()`/`beginLine()`
can't be called directly in a test anymore once the app has booted —
9 app tests total, all passing (8 before).

**Verified live**, same Chrome DevTools MCP path proven out for M9,
against the local dev server (`ng serve`, not yet deployed to GitHub
Pages): hit the same Vite stale-dependency-cache gotcha M8/M9 both hit
(`packages/app/.angular/cache` needed clearing after rebuilding
`packages/engine`) — `machine.setBreakpoint is not a function` until
cleared. Once cleared: defined `SQUARE`, armed a breakpoint on it,
typed `5 SQUARE .`, confirmed `debug_status` reported `"paused at
SQUARE"` and `read_stack` showed only `5` (not `25` — `SQUARE`'s body
genuinely hadn't run), called `debug_continue`, confirmed `read_screen`
then showed `25` and `debug_status` back to `"running"`. Also confirmed
`debug_continue` correctly errors (`"not currently paused at a
breakpoint"`, visible in the console) when called a second time with
nothing paused.

**Follow-up, same day: inspector panel UI** (`DEBUGGING.md` §9, itself
originally scoped out as "no UI for this pass"). A "breakpoints"
section, clickable dictionary words (gated on a new
`DictionaryEntry.breakable` field — closed a real gap where
`setBreakpoint` had silently accepted a primitive/`CONSTANT` that could
never actually fire), and a red "paused at WORD — Continue" banner.
Caught one real bug during testing: the breakpoints and dictionary
sections briefly shared a `.inspector-words` class, and since
breakpoints render first in the DOM a test's `querySelector` silently
grabbed the wrong (usually empty) one — fixed with distinct
`breakpoint-list`/`dictionary-list` classes. 164 engine tests (4 more:
`breakable` reporting correctly + `setBreakpoint` rejecting
non-breakable words) + 10 app tests (1 more: clicking a word arms a
breakpoint, shown in the new section), all passing. Verified live
against the dev server via Chrome DevTools MCP, driving actual DOM
clicks (`evaluate_script` + `.click()`) rather than only WebMCP tool
calls — confirmed the click-to-arm/clear flow, the pause banner, and
that clicking a non-breakable word (`DUP`) correctly does nothing.

---

## M11 — Comments compiled as retained data

Built exactly per `DEVELOPING.md` §2.4 — zero deviation once the
scoping pass had already corrected the original "pure bootstrap Forth
source" framing (there is no bootstrap loader; `(` had to become a
primitive like every other word).

**Engine (`packages/engine/src`):** `rebel-opcodes.json` gained one new
primitive, token 93, `(`, marked `immediate` (not `compileOnly` — it
must also work loose at the prompt). `primitives.ts`'s
`compileInlineString` (previously `S"`/`."`'s single-token-only
helper) was split into two pieces: `consumeQuotedText(ctx,
closingChar)` — a real loop over `nextInputToken()` accumulating text
until a token ends with the closing delimiter, rejoining with single
spaces — and `compileSlit(ctx, text)`, the unchanged `(SLIT)`-compiling
step. `S"`/`."`'s call sites (`compileInlineString`) didn't change at
all; multi-word support fell out of the refactor for free. New case
93 for `(`: consume the text, and only if `STATE === -1` (compiling)
compile `(SLIT)` + the text, followed by a compiled call to `2DROP` —
making the comment a genuine no-op at runtime (push, immediately
drop). While interpreting at the top level, the text is consumed and
discarded, matching classic Forth's `( ... )` there (nothing to
compile into). No `inner.ts`/`dictionary.ts`/`repl.ts` changes at all
— confirmed directly by reading `interpretCompiling`
(`if (found.immediate) { yield* this.inner.executeXT(found.cfa); }`,
`repl.ts:478`), the exact mechanism `IF`/`BEGIN`/`S"` already use to
run compile-time logic from inside a primitive.

**A real bug caught while writing the tests, not just theorized:** the
first `consumeQuotedText` cut had a trailing-space bug specific to
`(`'s own conventional spacing — `S" hello"` glues its closing `"`
directly onto the last content word (no space before it), but
`( a note )` idiomatically has a space before the closing `)`, making
`)` its own standalone token. The original loop unconditionally added
a separator space before appending the (now-empty) stripped remainder
of that standalone token, producing `"a note "` (7 chars) instead of
`"a note"` (6) — caught by a test that reads the compiled `(SLIT)`
length cell directly rather than only checking the word still ran.
Fixed by only adding the separator when the stripped remainder is
actually non-empty.

**Tests:** `comments.test.ts` (new): zero runtime stack effect for a
comment inside a definition; retention verified by reading the
compiled `(SLIT)` cell/length/bytes directly (not just "it runs
harmlessly" — the whole point is the text is genuinely still there);
a multi-word comment; a comment immediately before `;`; a comment
typed loose at the prompt (discarded, no stack/dictionary change); an
unterminated comment throwing the same `nextInputToken()`
input-exhausted error as any other case; a commented word called more
than once. `strings.test.ts` gained a case confirming `S"`/`."` now
support multi-word strings — 172 engine tests total, all passing (164
before). No app changes needed; 10 app tests unaffected.

**Verified live** via the Chrome DevTools MCP path proven out for
M9/M10, against the local dev server: defined
`: SQUARE ( n -- n*n ) DUP * ;`, ran `5 SQUARE .` → `25` with an empty
stack after (comment genuinely zero-cost); typed a loose top-level
comment and confirmed it was silently accepted with no `? unrecognized
word` error; defined `: GREET S" hello world" TYPE ;` and confirmed
`GREET` printed `hello world` — the multi-word `S"` fix working live,
not just in tests; confirmed `(` shows up correctly in
`read_dictionary`'s output alongside the other 92 boot primitives.

---

## M12 — System vocabulary: `WORDS`/`SEE`, loaded from `system.fth`

The next phase after M11's comment retention, per direct discussion:
as the vocabulary grows from core (native primitives) into system
words genuinely worth writing *in* Forth, keep them a plain host text
file loaded at boot — faster iteration than building the screen
editor first, with a clear, named path to migrate onto real portable
screens/cart saves later (`DEVELOPING.md` §4/§5) once that
infrastructure exists.

**Loading (`app.ts`):** `loadSystemVocabulary()` fetches
`packages/app/public/system.fth` relative to `<base href>` — the same
mechanism already serving the PWA manifest/icons, so this resolves
correctly under both local dev and the GitHub Pages
`--base-href /rebel-sim/` deploy, and is offline-precached by the
service worker for free. Feeds the file through `machine.interpret()`
once per line, before `startRepl()`. Deliberately **not**
try/caught the way `registerWebMcpTools()` degrades gracefully — a
broken system vocabulary is a bug in this repo's own source, not a
missing browser feature, and should fail loudly. `async
ngAfterViewInit()` — Angular accepts an async lifecycle hook natively.

**`'` (tick, token 94, `rebel-opcodes.json`/`primitives.ts`):** a
small but genuinely necessary primitive addition, discovered while
designing `SEE` — nothing in the existing vocabulary let Forth-level
source resolve a typed name to an `xt` at runtime (the closest thing,
`CREATE`'s `nextInputToken()` usage, is baked into that one primitive
specifically). `( -- xt )`, not `IMMEDIATE` — runs at *execution* time
like `CREATE` does, so `: SEE ' ... ;` correctly consumes *its
caller's* next input word (`SEE FOO`) rather than its own compile-time
input, the same shared-cursor mechanism `CREATE` already relies on.

**`system.fth` contents, all genuine Forth source, zero further
engine changes:**
- `WORDS` — `CORE-VOCABULARY.md` §12's own worked example, ported
  in verbatim except one real, previously-undiscovered bug: that
  doc's `1F AND` is a hex literal, but `BASE` defaults to 10
  (decimal), where `1F` isn't a valid number at all — that worked
  example was apparently never actually run against a fresh Machine
  before now. Fixed with `31` (`1F`'s decimal value) instead.
- `>CFA`/`XT-NAME` — the reverse of `WORDS`' own chain-walk: given a
  dictionary entry address, compute its Code Field address
  (`>CFA`); given a Code Field address (an `xt`), find and print the
  entry whose own `>CFA` matches it (`XT-NAME`). No separate
  primitive-vs-user-defined-word special case needed — primitives are
  boot-installed as real dictionary entries too, so one uniform walk
  covers both.
- Five named constants (`LIT-XT`, `EXIT-XT`, `BRANCH-XT`,
  `0BRANCH-XT`, `SLIT-XT`), captured once via `'` at load time —
  `SEE`'s way of recognizing inline-data tokens without needing a
  second dereference the way `inner.ts`'s own `threadFrom` does (a
  plain call cell's value already *is* the target's `cfa`).
- `SEE` — a real decompiler. Walks a word's Parameter Field, printing
  each call by name (`XT-NAME`) or special-casing `LIT` (prints the
  literal), `(SLIT)` (prints a quoted string), `BRANCH`/`0BRANCH`
  (prints a bare `<branch>` placeholder — not full `IF`/`THEN`
  reconstruction, out of scope for this pass), stopping at `EXIT`.
  Only `DOCOL`-coded words are supported — `CONSTANT`/`VARIABLE`/
  `DOES>`'d words print `(not supported)` rather than guessing wrong.

**Two real bugs caught building this, both empirically — not by
reading the code, by running it and checking `read_stack`, not just
whether the printed output looked right:**
1. `XT-NAME`'s first cut leaked the matched entry's own `entry-addr`
   onto the data stack in its found-path (a missing `DROP` before
   `EXIT`) — silently corrupting every subsequent call, which
   manifested as an apparent infinite loop in `SEE` (`pfa` tracking
   corrupted, endless `?` "not found" output) rather than an obvious
   stack-depth error. Diagnosed by isolating `XT-NAME` alone against
   an independent reference (`'`'s own native `cfa` computation),
   not by debugging the composed failure directly.
2. `." : "` and `." <branch> "` both silently lost their leading/
   trailing spaces entirely, not just imprecisely — a bare delimiter
   token (a lone `"` with nothing but whitespace around it) carries
   no content for the string-rejoin logic to preserve. Fixed by
   moving those spaces to explicit `32 EMIT` calls instead of
   embedding them in the quoted string — `DEVELOPING.md` §2.2 now
   documents this precisely for the next person writing
   system-vocabulary source.

**A real, previously-undocumented constraint surfaced along the
way:** `Machine.interpret()` (used for loading `system.fth`) has no
line-length limit, but the *interactive* path (typed at the on-screen
REPL or via a WebMCP `type` call) goes through `ACCEPT`, capped at
`TIB_BANK_SIZE` (128 bytes) — a longer line typed interactively gets
silently truncated mid-token. Not a bug (`abortDefinition` correctly
rolled back the resulting broken definition attempt, same recovery
path an ordinary unrecognized-word error already uses) — just
something to know when iterating on system-vocabulary words directly
at the REPL before committing them to the file. `SEE`/`XT-NAME`'s
definitions were built and tested in shorter chunks for exactly this
reason.

**Confirmed, not just predicted:** `FORTH-ARCHITECTURE.md` §9 item 13
flagged that reusing `(SLIT)`+`2DROP` for M11's comments is ambiguous
against a real string a program discards on purpose — `SEE` now
demonstrates that concretely: `: ANNOTATED ( this is a comment ) 5 ;`
decompiles as `: ANNOTATED "this is a comment" 2DROP 5 ;`, not clean
`( ... )` syntax. Not fixed — recorded as the first real evidence for
a tradeoff that was, until now, only theoretical.

**Tests:** `app.spec.ts` mocks `fetch` to serve `system.fth`'s real
content read straight off disk (`node:fs`), not a fabricated fixture
— a test failure here means the actual shipped file broke. Needed
`@types/node` as a devDependency, scoped to `tsconfig.spec.json` only
(not the app's own build). No dedicated engine-level tests for
`WORDS`/`SEE`'s own correctness — deliberately deferred; there's no
established pattern yet in this repo for testing pure-Forth-source
content, and forcing one into existence for two words wasn't judged
worth it this pass. All 10 existing app tests continue to pass
(`system.fth` loading successfully is already an implicit
precondition of every one of them); 172 engine tests unaffected (no
engine changes beyond the `'` primitive, which got its own coverage
implicitly through nothing — genuinely untested at the engine level,
consistent with the "defer Forth-level test patterns" call above,
though `'`'s own primitive-level behavior is simple enough that this
was a deliberate, considered gap, not an oversight).

**Verified live**, entirely via the Chrome DevTools MCP path,
redefining and re-testing each helper word in isolation
(`>CFA`, then `XT-NAME`, then the five constants, then `SEE` itself)
against the running REPL before composing the full thing — exactly
how both real bugs above were actually found, not by reading the
source and hoping. Final confirmation from a genuinely clean boot (no
interactive typing, page reload only): `WORDS`/`SEE`/`>CFA`/
`XT-NAME` all present in `read_dictionary`'s output straight from
`system.fth`; `SEE SQUARE` → `: SQUARE DUP * ;`; `SEE FIVE` (a `LIT`
case) → `: FIVE 5 ;`; `SEE GREET` (a `(SLIT)` case, `S" hi" TYPE`) →
`: GREET "hi" TYPE ;`; `SEE ABSISH` (a `BRANCH` case, `IF`/`THEN`) →
`: ABSISH DUP 0< <branch> NEGATE ;`; `SEE DUP` (a primitive) →
`(not supported)`; `SEE >CFA` (self-consistency, a real 9-primitive
word with a negative literal) → an exact match against its own
source. Stack empty after every single one.

---

## M13 — `VOCABULARY`/`USE`: branching dictionary chains

Built exactly per `DEVELOPING.md` §8's scoping pass — the branching-
chain mechanism, `LATEST-ADDR` as the one general primitive addition,
the rejected independent-chains-plus-search-order alternative all
confirmed as designed, no surprises requiring a design change this
time (M11/M12 both needed real design corrections mid-build; this one
didn't).

**Engine (`packages/engine/src`):** `Sysvars.fieldOffset` (previously
private) made public — it already computed exactly the address
`LATEST-ADDR` needs, via the same internal offset math every other
sysvar accessor already uses, so no new computation was needed, only
visibility. New primitive, token 95, `LATEST-ADDR ( -- addr )`:
`s.push(ctx.sysvars.fieldOffset('FORTH', 'LATEST'))`. Two new engine
tests (`dictionary.test.ts`) confirm `LATEST-ADDR @` matches what
`LATEST` itself reports, and — the more important check — that
writing through `LATEST-ADDR !` actually changes what `LATEST`
subsequently reports, verified from both the TS accessor and a real
Forth-level round-trip (`LATEST-ADDR @ LATEST =` → `-1`).

**`system.fth`:** `VARIABLE CURRENT-VOCAB` (ordinary variable, no
sysvar involvement); `VOCABULARY` (`LATEST CREATE ,` — note the
order: `LATEST` must run *before* `CREATE`, since `CREATE` itself
becomes the new `LATEST` the instant it links its own header in, so
capturing the old value has to happen first, or a vocabulary would
capture itself); `VOCABULARY FORTH` right after, capturing everything
defined so far (core primitives through M12) as the root vocabulary,
with `CURRENT-VOCAB` initialized to point at `FORTH`'s own cell;
`USE` (swaps which chain `LATEST` extends, saving the outgoing
chain's position back into its own remembered cell first, addressed
via `' <name> 8 +` — the same offset `executeXT`'s own `DOVAR`
dispatch already uses to reach a `CREATE`d word's actual data,
skipping its Code Field and reserved does-pointer cell).

**Confirms the branching-chain design's actual payoff, not just its
mechanism:** `VOCABULARY TESTVOCAB`, `USE TESTVOCAB`, define a word —
`read_dictionary` shows the new word plus everything that existed at
the branch point (core + `WORDS`/`SEE`/etc.), but *not* anything from
a sibling vocabulary. `USE FORTH` switches back — the new word
disappears from `WORDS`/lookup entirely (confirmed both ways: it's
gone from `read_dictionary`, and typing its name gives `? unrecognized
word`), while the vocabulary word itself (`TESTVOCAB`) stays visible,
correctly, since *it* was defined while `FORTH` was still active.
Switching back to `TESTVOCAB` and calling the word again works
immediately — chain position round-trips exactly. `SEE` composes with
this with zero changes needed, since it only ever walks from whatever
`LATEST` currently is.

**No `dictionary.ts`/`findWord` changes at all** — confirmed, not just
predicted: `WORDS` is completely unmodified from M12 and became
vocabulary-scoped for free, since it already just walks from
`LATEST`, which now means "whichever chain is currently active."

**Tests:** 174 engine tests (2 new), 10 app tests unaffected (no app
changes needed — `system.fth` growing is exactly what the M12 loading
mechanism was built to absorb). No dedicated engine-level tests for
`VOCABULARY`/`USE`'s own Forth-level correctness, same deliberate call
as M12's `WORDS`/`SEE` — verified entirely live instead.

**Verified live**, same Chrome DevTools MCP path as every milestone
since M9, from a genuinely clean, file-only boot (page reload, no
interactive redefinition): `VOCABULARY PROJECT`, `USE PROJECT`,
`: HELPER 99 ;`, confirmed `HELPER` present in `read_dictionary`;
`USE FORTH`, confirmed `HELPER` gone and `PROJECT` still present;
switched back and confirmed round-trip correctness — all straight
from the shipped `system.fth`, not redefined interactively first.

**Not done this pass, flagged in `DEVELOPING.md` §8.5 as a deliberate
follow-up, not an oversight:** actually re-filing `SEE`/`XT-NAME`/
`>CFA`/the `-XT` constants into their own `SYSTEM` vocabulary (the
concrete motivating use case from §8.1) needs reordering
`system.fth`'s own load sequence — `VOCABULARY`/`USE` had to exist
and be tested as a mechanism first.

---

## M14 — `HIDE`: decluttering `SEE`'s own support words

The §8.5 follow-up, picked up immediately after M13 — and a real
design correction along the way, not a straightforward execution of
what was sketched.

**The originally-planned `VOCABULARY`-based re-filing doesn't
actually work for this goal, caught before writing any code, not
after:** branching chains (M13's whole mechanism) only let a *later*
vocabulary see an *earlier* one's contents, never the reverse. Move
`SEE`/`>CFA`/`XT-NAME` into a `SYSTEM` vocabulary and switch back to
`FORTH` for normal use, and `SEE` becomes uncallable
(`? unrecognized word`) without an explicit `USE SYSTEM` first every
time. Sequencing it the other way — `FORTH` branching *from*
`SYSTEM`, inheriting visibility — doesn't help either: visibility for
lookup and being listed by `WORDS` are the *same* underlying
chain-walk under M13's design, so there's no way to make something
callable-but-unlisted with vocabularies alone.

**What actually fits: `HIDE`, reusing `FLAG_HIDDEN`** — the exact bit
`findWord`/`listDictionaryEntries` already skip over for a
colon-definition mid-compilation, applied here permanently instead of
temporarily. An already-compiled caller is unaffected by hiding a
word it calls: compiled calls are raw addresses baked in at compile
time, not names re-resolved at call time — only *future* name lookup
and `WORDS` listings change. Turns out to need **zero engine
changes** — pure Forth, using only primitives that already existed
(`LATEST`, `C@`, `C!`, `OR`, `>CFA`/`XT-NAME`'s own reverse chain-walk
pattern, reused rather than duplicated conceptually):

```forth
: HIDE
  ' >R LATEST
  BEGIN DUP WHILE
    DUP >CFA R@ =
    IF 4 + DUP C@ 64 OR SWAP C! R> DROP EXIT THEN
    @
  REPEAT
  DROP R> DROP
;
```

**A real sequencing bug, caught by testing, not by re-reading the
source:** `HIDE >CFA` can't run until *everything* that still needs
to find `>CFA`/`XT-NAME`/the `-XT` constants by name during its own
compilation has already been compiled — which means all the way
through `SEE` itself, not right after each individual helper the way
an earlier draft of this had it (`: >CFA ... ; HIDE`, immediately
after each definition). `findWord` skips hidden entries during
compilation too, so hiding `>CFA` before `XT-NAME` is defined breaks
`XT-NAME`'s own compilation outright. Fixed by moving every `HIDE`
call to after `SEE`'s closing `;`, once nothing later still needs any
of them by name.

**A second real bug, caught live, not by re-reading the source
either:** a documentation-comment-only mistake, but a load-breaking
one — `system.fth` itself has a standing rule (state in its own
header comment, from M12) that `(` comments can't contain an embedded
closing paren, since the tokenizer only checks whether a token *ends
with* `)`, not whether parens are balanced. Two of the new comments
explaining `HIDE` violated that rule (`bit (64) findWord/WORDS` and
`case (project/cart isolation) once`) — each caused the actual
comment to close early, leaking the next few words as real tokens for
the interpreter to try to execute, throwing
`? unrecognized word: findWord/WORDS` on page load. Caught via the
browser console during live verification, not the type-checker or
test suite (comments are invisible to both) — fixed by rewriting
both without embedded parens, then rechecking every other comment in
the file by hand for the same pattern before reloading again.

**Verified live**, same Chrome DevTools MCP path as every milestone
since M9: fresh reload after the fix loaded cleanly (no console
error); `read_dictionary` confirmed all seven helpers
(`>CFA`/`XT-NAME`/the five `-XT` constants) gone from the listing,
while `SEE`/`WORDS`/`HIDE`/`VOCABULARY`/`USE`/`CURRENT-VOCAB`/`FORTH`
all remained; `SEE SQUARE` still correctly decompiled
`: SQUARE DUP * ;` despite calling now-hidden `XT-NAME` internally,
stack empty afterward; `5 >CFA` correctly threw
`? unrecognized word: >CFA`, confirming genuine hiding, not just
delisting; M13's `VOCABULARY`/`USE` isolation behavior re-verified
end to end with no regressions.

**Tests:** 174 engine tests unaffected (no engine changes at all this
milestone — the only genuine "engine change" tier gap identified,
`EXECUTE`, was explicitly deferred: it would need real `inner.ts`
special-casing to thread into an arbitrary runtime `xt` through the
same suspend/resume-capable machinery `executeXT` itself uses, not a
self-contained `primitives.ts` case, and nothing currently in scope
actually needs it — `USE` already works without it). 10 app tests
unaffected, `system.fth` growing being exactly what M12's loading
mechanism was built to absorb.

## M15 — `EXECUTE` — **done**

Closes the gap M13/M14 both flagged and deferred: `EXECUTE ( xt -- )`,
run the word whose code-field address is on the stack, exactly as if
it had been called directly. One new primitive token, 96, added to
`rebel-opcodes.json` (no `immediate`, no `compileOnly` — it's an
ordinary runtime word). Auto-registered into the dictionary for free
by `Machine`'s constructor loop over `opcodes.primitives` — confirmed
by re-reading that loop rather than assuming, same discipline as every
other primitive addition this project — so no `repl.ts`/`dictionary.ts`
changes were needed, only `rebel-opcodes.json` plus `inner.ts`.

**Why it's special-cased in `inner.ts`, not `primitives.ts`:** same
reason `ACCEPT` is — a plain `executePrimitive` switch case runs to
completion in one synchronous call and has no access to `executeXT`
itself. `EXECUTE` pops the `xt` and does `yield* this.executeXT(xt)`
from inside `dispatch()` — genuine generator delegation, not a new
mechanism. This means it gets DOCOL/DOVAR/DOCON/DODOES dispatch,
word-level breakpoints, and nested blocking (`KEY`/`ACCEPT` inside the
executed word) all correctly, for free: `executeXT`'s own `threadFrom`
already pushes/pops its own return-stack sentinel on every call
(compiled or not), so recursing into it from `dispatch()` is no
different from a nested `DOCOL` slot in an ordinary compiled body —
the shared `rstack` just grows one more frame, same as always.

**Verified via the engine test suite** (not yet re-verified live in
the browser — this primitive has no UI-visible behavior beyond what
`'`/direct calls already exercised): `execute.test.ts`, 7 new cases —
`EXECUTE` on a primitive (`DUP`), a colon-definition (`DOCOL`
threading), a `VARIABLE` (`DOVAR`), a `CONSTANT` (`DOCON`), a
`CREATE...DOES>` word (`DODOES`), a nested case (a word `EXECUTE`d
itself calls `EXECUTE` on another xt, exercising the shared-rstack
recursion), and a breakpoint set on a word that's reached only via
`' NAME EXECUTE` rather than a direct compiled call — confirms
`Inner.checkBreakpoint` fires identically either way.

**Tests:** 182 engine tests total (confirmed via a full test run, not
arithmetic on prior counts), 7 new for `EXECUTE`. No app-level
changes — `EXECUTE` needed zero Angular/UI wiring, same as
`LATEST-ADDR`.

## M16 — `S"`/`."` real interpret-time behavior — **done**

Closes `DEVELOPING.md` §7, open since the Canon Cat interactive
control-flow exploration was dropped and `S"`/`."` were shipped
`compileOnly` as an engine-specific limitation, not a real Forth
semantic: real Forth supports `S" hello" TYPE` typed loose at the
prompt.

**The fix, scoped before implementing (per this project's established
workflow):** `compileOnly` removed from both in `rebel-opcodes.json`
(`immediate` stays — both still need to run at "compile" time to parse
the quoted text, whether or not that text ends up compiled anywhere).
`primitives.ts`'s case 68 (`S"`) and case 70 (`."`) each now branch on
`ctx.sysvars.getState()` rather than throwing when not `-1`: compiling
behavior is unchanged (inline `(SLIT)` store for `S"`; the same plus a
compiled `TYPE` call for `."`); interpreting is new. Deliberately *not*
a single shared dual-mode helper — `S" ( -- addr len )` must persist
bytes for the caller to consume, `." ( -- )` only needs to print
immediately — genuinely different bodies, not one abstraction forced
over two shapes.

**Where the interpreted text lives:** a new bank, tag `PAD`, 128 bytes
(same size as `TIB`), created in `repl.ts` alongside `tibBank`, exposed
to `primitives.ts` as two new `PrimitiveContext` fields (`padBase`/
`padSize`). Interpreted `S"` copies its text into `PAD` and pushes
`padBase`/length; interpreted `."` emits directly via `screen.emit()`
in a loop, never touching `PAD` at all, since nothing needs to persist
past the print. **Rejected alternative:** reusing the already-idle
`TIB` bank — technically safe today (`TIB`'s bytes are copied out to a
token array before dispatch ever runs) but rejected as an *implicit*
"doesn't overlap today" coupling between `ACCEPT` and `S"` rather than
a named contract, the same mistake class as the `VOCABULARY`-based
re-filing idea M14 rejected in favor of `HIDE`. A dedicated bank is the
minimum real mechanism, not a clever reuse that creates hidden coupling
— consistent with this project's standing "no gold-plating, no
premature reuse" discipline.

**Bounds check:** an interpreted `S"` whose text exceeds `padSize`
throws (`too long for PAD`) rather than silently corrupting whatever
arena memory sits past `PAD` — stricter than real Forth's typically
unchecked `PAD`, and a deliberate choice given Rebel-Sim's arena is a
flat, bounds-checkable `ArrayBuffer`, not raw hardware memory.

**A free addition:** `PAD ( -- addr )`, primitive 97, exposing the
bank's base address directly — mirrors the `HERE`/`LATEST` precedent,
costs nothing since the bank already has to exist for `S"` to work.

**`inner.ts`: no changes.** `(SLIT)`'s inner-interpreter guard concerns
the compiled-mode runtime helper token, an entirely different code path
from `S"`/`."`'s own primitive dispatch — confirmed by reading it, not
assumed.

**Verified via the engine test suite** (`strings.test.ts`): the old
"`S"` throws while interpreting" test was rewritten (the behavior
changed, not just relaxed) into six new/changed cases — `S"` and `."`
both working loose at the prompt; `PAD` being a single shared,
overwritten-on-each-call region (two successive interpreted `S"` calls
return the same base address, second call's text fully replaces the
first's); the too-long-for-`PAD` throw; `PAD ( -- addr )` matching
`S"`'s returned address; and confirming compiled-mode `S"`/`."`
behavior (inline `DICT` storage, unrelated to `PAD`) is unaffected.
**Live-verified in the browser** via the WebMCP `type`/`read_screen`/
`read_banks`/`read_dictionary`/`read_stack` tools: `S" hello" TYPE` and
`." direct print"` both work loose at the prompt with zero console
errors; `S" abc" DROP PAD =` returns `-1` (`TRUE`), confirming `S"`'s
returned address really is `PAD`'s base; `read_banks` shows the new
`PAD` bank sized and placed correctly right after `TIB`; a compiled
`S"`-using word defined and called live still works unchanged. One
live-testing wrinkle, not a bug: typing an over-128-char `S" ..."` line
at the actual REPL prompt can't reach the `PAD`-overflow throw at all,
because `ACCEPT`'s pre-existing `TIB` cap (also 128 bytes, M7a) silently
truncates the *typed line itself* first — the closing `"` never arrives,
so the error surfaced is `? expected a name, but the input ended`
instead. Not a regression: `interpret()` (used by the engine test) calls
`tokenizeAndRun` directly, bypassing `ACCEPT`/`TIB` entirely, which is
exactly why the unit test can (and does) exercise the real `PAD`-overflow
path that live typing structurally cannot.

**Tests:** 187 engine tests total (182 after M15; here, `strings.test.ts`
lost its old throw-while-interpreting case and gained six new ones,
net +5), confirmed via a full test run. 10 app tests and the full
build unaffected — no Angular/UI changes.

## M17 — `ABORT` — done

Originally scoped in full as `THROW`/`CATCH`/`ABORT` (`DEVELOPING.md`
§9 v1) — a `ForthError` class hierarchy, ANS-code bucketing of every
throw site in the engine, a new `LAST-ERROR` sysvar. Reconsidered
before implementing: none of that machinery has a real consumer
without `CATCH` actually existing to use it, and this project doesn't
need to track ANS Forth conformance closely. Trimmed to just `ABORT`,
the classic-Forth-useful subset that doesn't need any of it — same
"minimum real mechanism" discipline this project has applied at every
prior milestone.

**What shipped:** one new primitive, `ABORT ( -- )`, token 98 (next
free after `PAD`, M16) — an ordinary `primitives.ts` case, no generator
access needed: empty the data stack (`DataStack` gains a new `clear()`
method), then `throw new Error('ABORT')`. Deliberately no dedicated
error class — nothing needs to distinguish `ABORT` from any other
error without `CATCH` to special-case it, so uncaught it surfaces
through the exact same `? <message>` path every error already used
(`? ABORT`).

**A real, independent bug found while scoping, fixed here:**
`threadFrom()` (`inner.ts`) pushes its rstack sentinel with no
`try`/`finally` around the loop that's supposed to pop it. Any
exception thrown from inside — a primitive, a stack under/overflow,
anything — left that push permanently on `rstack`. Confirmed
empirically before touching any code: defining a word that throws when
called and interpreting it twice in the same session grew
`rstack.depth` by exactly one *per error*, unbounded (0 → 1 → 2).
`replLoop`'s catch block (the interactive on-screen/WebMCP REPL, the
one long-lived session that actually accumulates errors over real
usage) now clears both `stack` and `rstack` on *any* uncaught error,
not just explicit `ABORT` — otherwise `ABORT` would clear the data
stack while leaving the return stack silently corrupted, which
wouldn't actually be "a clean prompt." **Deliberately not applied to
`interpret()`/`runLine()`** — the programmatic path every engine test
uses keeps its exact documented contract ("throws exactly as before,"
no side effects beyond the existing mid-compile cleanup); only the
interactive REPL loop gets the new recovery behavior.

**A pre-existing, unrelated test fragility surfaced and fixed along
the way:** `words-sufficiency.test.ts`'s `fullScreenText` helper joined
screen rows with `' '` before searching for word names. `screen.ts`'s
cursor wrap (bottom row wraps to row 0, no scroll) means a row
boundary is a rendering artifact, not a character actually written to
the stream — `WORDS`'s own definition already emits a real space
between words. Adding `ABORT` shifted every later character's row/col
position by a few bytes, which happened to land a row-wrap exactly
inside `SWAP`, and the injected join-space then read it back as `S
WAP`, failing a test that has nothing to do with `ABORT` itself. Fixed
by joining with `''` instead — the physically correct representation
of what's actually rendered, robust to any future primitive-count
change landing a word on a row boundary again.

**Verified via the engine test suite** (`abort.test.ts`, new): `ABORT`
empties a non-empty stack and throws a plain `Error`; `interpret()`'s
own error contract is confirmed unchanged (stack depth left dirty, on
purpose); `replLoop`, driven via a `RemoteChannel` (no simulated
keypresses needed), confirms the data stack clears after an uncaught
error typed at the prompt; the exact nested-call `rstack`-leak scenario
confirmed above now stays at depth 0 across two repeated errors; an
explicit `ABORT` reached through a compiled call (so it goes through a
real `threadFrom` frame too) leaves both stacks clean. **Live-verified
in the browser** via WebMCP: `1 2 3 ABORT` empties `read_stack`;
`: BAD DUP ; BAD` (twice in a row) leaves `read_return_stack` empty
both times, not growing; the screen shows `? ABORT` and
`? DSTK stack underflow` printed exactly like any other error; zero
console errors; `read_dictionary` shows `ABORT` registered correctly.

**Tests:** 193 engine tests total (187 after M16, 6 new in
`abort.test.ts`), confirmed via a full test run. 10 app tests and the
full build unaffected — no Angular/UI changes.

## M18 — `BANK@` — done

Scoped since `DEVELOPING.md` §10 (originating from a 2026-08-02
question about shared-bank access, resolved 2026-08-05 by settling
multi-arena isolation as a confirmed non-goal) but explicitly not
built ahead of an actual need. That need arrived directly: the user
asked about generalizing `LATEST-ADDR`'s one-off pattern into a named
sysvar lookup (`SYSV@ ( "group" "field" -- addr )`, mirroring
`BANK@`'s own tag-based lookup) so Forth source could reach any sysvar
by name. Considered, then explicitly declined by the user in favor of
something simpler: implement `BANK@` alone, and reach a specific
sysvar by combining `BANK@ SYSV`'s base address with a **hardcoded**
group/field offset (already known, cheap to read off
`rebel-opcodes.json`'s `sysvarGroups` table) rather than adding a
second named-lookup primitive purely to avoid one layer of
redirection.

**What shipped:** one new primitive, `BANK@ ( "tag" -- addr )`, token
99 (next free after `ABORT`, M17) — parses the next input token via
the same `nextInputToken()` mechanism `'`/`CREATE`/`VARIABLE`/
`CONSTANT`/`S"`/`VOCABULARY`/`USE` already use (not a stack-based
string), uppercases it to match `findWord`'s case-insensitivity, looks
up the first bank of that tag via `ctx.banks.findBank()` (already
existed, no change), pushes `addr`, or throws `? unknown bank: <TAG>`
on no match — same convention as `'` on an unrecognized word.
`PrimitiveContext` gained a `banks: BankTable` field; `Machine`
already satisfied it structurally (no constructor change, same
precedent as `padBase`/`padSize`, M16). No `inner.ts` change — a plain
synchronous case, like `PAD`/`LATEST-ADDR`, not `EXECUTE`/`CATCH`.

**Addr only, not `addr size`** — a direct follow-up correction, same
day: every other `SOMETHING@` word in this dictionary fetches exactly
one value; `Bank.size` (and `name`/`flags`) simply isn't returned. A
dedicated bank-inspection word can add any of these later if a real
need shows up — not built ahead of one now.

**Not immediate, deliberately** — same reasoning as `'`: `BANK@`
consumes its input-cursor token at *runtime*, so it can be called from
inside a compiled definition to consume whatever the *caller* typed
next, but writing a literal tag directly after `BANK@` inside a `:
... ;` body doesn't work (the compiler tries to compile a call to that
name instead) — confirmed live during verification, not a regression,
just the same known limitation `'` already has without a `[']`-style
compile-time-literal word, which this project hasn't built either.

**Verified via the engine test suite** (`bank-access.test.ts`, new,
6 tests): resolves a known tag to the same base address
`getAllBanks()`/`findBank()` report; case-insensitive lookup; every
bank tag `Machine`'s constructor actually creates is reachable, not
just a subset; an unknown tag throws; a repeated tag resolves to the
first-created bank, matching `findBank(tag)`'s own semantics; a sysvar
cell (`FORTH.STATE`) reached via `BANK@ SYSV <offset> + @` reads back
the same value `Sysvars.getState()` reports — the actual motivating
use case. **Live-verified in the browser** via WebMCP's
`execute_webmcp_tool`/`read_dictionary`/`read_banks`, against the
original `addr size` shape before the same-day addr-only trim: `BANK@
SYSV . .` printed the same base/size `read_banks` reported for `SYSV`;
`BANK@ NOPE` printed `? unknown bank: NOPE` (the same pre-existing
`? ?` double-prefix every primitive that throws its own `? `-prefixed
message already has, e.g. plain unrecognized-word errors — confirmed
not a new regression); `BANK@ PAD DROP PAD = .` printed `-1`,
confirming `BANK@`'s resolved `PAD` address matches the dedicated
`PAD` primitive's address exactly; `read_dictionary` shows `BANK@`
registered. The addr-only trim afterward is a stack-effect
simplification with no behavioral risk (fewer values pushed, same
lookup/error path), re-verified by the updated engine test suite
rather than a second live pass.

**A dev-environment gotcha hit and resolved along the way, worth
recording:** Angular's `ng serve` (Vite-backed) pre-bundles workspace
dependencies like `@rebel-sim/engine` into `.angular/cache/*/vite/deps/`
and does not reliably reinvalidate that cache when only the
*dependency's* built output changes (package.json/lockfile unchanged)
— a plain reload, and even a full dev-server restart, kept serving a
pre-`BANK@` snapshot until `.angular/cache` itself was deleted. Not an
engine or app bug; a Vite dependency-optimization staleness issue
worth remembering for future live-verification sessions if a just-added
primitive mysteriously doesn't show up in `read_dictionary`.

**Tests:** 199 engine tests total (193 after M17, 6 new in
`bank-access.test.ts`), confirmed via a full test run. App build
unaffected — no Angular/UI changes.

## M19 — `MMAP` — done

Scoped in full in `DEVELOPING.md` §11 before implementing — see that
section for the complete motivation (a persistence/snapshot discussion
flagging `BankTable` as host-side, a separate finding that `DIRTY` is
genuinely inert on both sides, and confirmation via `rebel-rom/docs/
MEMORY-MODEL.md` §3.2 that arena-resident bank data was the *original*
Phase 3 design, deliberately deferred). Along the way, `CORE.ARENA-SIZE`
was added as a small, separate sysvar addition (total arena size in
bytes, readable from Forth via `BANK@ SYSV 24 + @` or any other
`SYSV`-relative path) — motivated by the app inspector's own "banks
arena 1, X of Y" label wanting the same fact Forth code might want too.

**What shipped:** a new module, `mmap.ts`, holding `MemoryMap` (the
arena-byte accessor: header init, next-free/slot-count tracking,
per-slot read/write) and the wire-format constants (`MMAP_TAG`,
`MMAP_MAX_SLOTS = 64` — matching `rebel-rom`'s real
`BANK_TABLE_MAX_BANKS`, not a separately-chosen number — and
`MMAP_SIZE`, the computed total: a 12-byte header plus 64 24-byte
slots, 1548 bytes). `BankTable`'s constructor (`banks.ts`) now reserves
`MMAP`'s fixed space first, writes its header, and registers +
mirrors itself into its own slot 0 before anything else runs — the
self-referential bootstrap `DEVELOPING.md` §11 sketched, resolved
exactly as described. Every subsequent `createBank()` call mirrors its
result into the next free `MMAP` slot and advances `MMAP`'s own
next-free cell, in addition to (not instead of) the existing host-side
array — `findBank()`/`getAllBanks()` are completely unchanged, still
the real read path, matching the "mirror only, not yet the source of
truth" boundary the scoping doc drew. `Bank` gained a real `flags`
field for the first time (`BankFlagResident`/`External`/`Swappable`/
`Dirty` matching `rebel-rom`'s real `TBankFlags` bit-for-bit; `Active`,
bit 4, the new Rebel-Sim-first addition, default-on) — resolving the
"nothing real to return yet" scope-cut M18 left open. `createBank()`
gained an optional fourth `flags` parameter, matching
`CBankTable::CreateBank`'s own default-parameter shape.

**A real implementation bug found and fixed, not just a design
question:** the first pass had `mmap.ts` importing `BANK_NAME_LEN` from
`banks.ts` while `banks.ts` imports `MemoryMap` from `mmap.ts` — a
circular ES module dependency. This left `BANK_NAME_LEN` `undefined` at
`mmap.ts`'s module-init time, corrupting every slot-offset computation
downstream, which didn't fail cleanly — it surfaced as a baffling
"MMAP is full (64 slots)" error thrown on the *ninth* bank ever
created (`TIB`, inside `Machine`'s own constructor), not an obvious
`undefined`-related crash. Root-caused by building the engine to
`dist/` and running a throwaway `node -e` script directly against it
rather than guessing from the test failures alone. Fixed by hardcoding
the one value `mmap.ts` actually needed (`8`) rather than importing
it, since it needed the number, not any real behavior from `banks.ts`.

**Deliberately not done here, per the scoping doc's own boundary:**
Forth-side bank creation (nothing yet lets Forth source write a new
`MMAP` slot and have it mean anything), and rewriting `BANK@` (M18) or
`Machine.banks`/`BankTable`'s read path to treat `MMAP` as the actual
source of truth rather than a verified mirror of it. Both real,
named follow-on work, not silently skipped.

**Verified via the engine test suite** (`mmap.test.ts`, new, 8 tests;
`banks.test.ts`'s `getAllBanks` test and `stack.test.ts`'s hand-rolled
tiny-arena helper both updated for `MMAP` always being bank 0 now):
`MMAP` created automatically as bank 0 at base 0 with the right
size/flags; it registers itself in its own slot 0 correctly;
`getNextFree()` tracks the real allocation cursor as banks are
created; every created bank mirrors into `MMAP` in creation order,
matching `getAllBanks()` field-for-field; a caller-supplied `flags`
value is respected and mirrored; the table throws once all 64 slots
are used; every bank a real `Machine` creates (including `MMAP` itself)
ends up correctly mirrored; a slot is readable directly via raw `@`
from Forth source and matches what `BANK@` resolves for the same bank.
**Live-verified in the browser** via WebMCP: `read_banks` on a fresh
`Machine` shows `MMAP` as bank 0 at `0x0000`/`1.51 kB`, every other
bank's base shifted by exactly `MMAP_SIZE` (`SYSV` now at `0x060C` =
1548 decimal); a raw Forth `@` walk of `MMAP`'s `DICT` slot
(`108 12 + @ .` / `108 16 + @ .`) printed `13836 65536`, matching
`read_banks`' own `DICT` row exactly — the mirrored data, read purely
from arena bytes with zero host round-trip, is correct. Zero console
errors. `CORE.ARENA-SIZE` separately verified: `BANK@ SYSV 24 + @ .`
printed `1048576`, the real default arena size.

**Tests:** 208 engine tests total (200 before this milestone, 8 new in
`mmap.test.ts`, plus 1 earlier for `CORE.ARENA-SIZE` in
`bank-access.test.ts`), confirmed via a full test run. 10 app tests and
the full build unaffected — no Angular/UI changes this milestone (the
inspector panel's hex/kB formatting and arena-usage label were a
separate, earlier UI-only change).

## M20 — `BANK@` reads `MMAP` directly — done

Scoped in `DEVELOPING.md` §12 as the smaller, more contained half of
M19's own "Follow-on, not resolved" note — a pure read-path swap, not a
behavior change, made possible because M19 already proved `MMAP` is a
correct mirror of the host bank table in the same creation order.

**What shipped:** `MemoryMap` (`mmap.ts`) gained one new method,
`findBankAddr(tag: string): number | undefined` — walks `getSlot(i)`
for every slot in use, returns the first match's `base`, matching
`findBank(tag)`'s own "first bank of this type, in creation order"
semantics exactly. `primitives.ts`'s case 99 (`BANK@`) changed its one
lookup line from `ctx.banks.findBank(tag)` to
`ctx.banks.mmap.findBankAddr(tag)` — everything else about `BANK@`
(token parsing, uppercasing, the `? unknown bank: <TAG>` error, not
being `IMMEDIATE`) is byte-for-byte unchanged. `PrimitiveContext`'s
shape didn't change at all — `banks: BankTable` was already there
(M18); this only changed what `BANK@`'s single call site does with it.

**Verified via the engine test suite**: `bank-access.test.ts`'s
existing 7 tests all passed completely unmodified — the actual proof
this was a safe migration, not just an argument for it. Four new tests
in `mmap.test.ts` cover `findBankAddr()` directly (known tag, unknown
tag returns `undefined` rather than throwing, first-match-on-repeated-
tag semantics) plus a direct check that `BANK@`'s own result equals
`findBankAddr()`'s, confirming the primitive is actually exercising the
new path. **Live-verified in the browser** via WebMCP:
`BANK@ SYSV . BANK@ DICT . BANK@ PAD .` printed `1548 13836 84796`,
matching `read_banks`' own rows exactly; `BANK@ NOPE` still printed
`? unknown bank: NOPE`, unchanged. Zero console errors.

**Tests:** 212 engine tests total (208 before this milestone, 4 new in
`mmap.test.ts`), confirmed via a full test run. 10 app tests and the
full build unaffected — no Angular/UI changes.

## M21 — `CREATE-BANK` — done

Scoped in `DEVELOPING.md` §13 as the larger, harder-to-walk-back half
of M19's own "Follow-on, not resolved" note — `DEVELOPING.md` §11 had
already committed to "no host round-trip needed" for creation, not
just lookup, so this section made that concrete rather than reopening
whether it was the right call.

**What shipped:** one new primitive, `CREATE-BANK ( size "tag" -- addr
)`, token 100 — pops `size`, parses the next input token like `BANK@`
does, uppercases it, and calls `ctx.banks.mmap.addBank(tag, tag,
mmap.getNextFree(), size, RESIDENT | ACTIVE)` directly — **the exact
same `MemoryMap.addBank()` method `BankTable.createBank()` already
calls internally (M19)**, just invoked straight from a primitive
instead of through the host. Name always equals the (truncated) tag —
deliberately no auto-serial naming, since a primitive bypassing
`BankTable` entirely has no business reaching its private serial
counter, and inventing a second, independent counter would let two
counters collide by construction. No out-of-space check beyond
`MMAP`'s own 64-slot cap — relies on `DataView`'s own bounds-checking
at first real access, the same precedent M19's `BankTable` constructor
already established.

**The real, named consequence:** a bank created this way is invisible
to `BankTable.getAllBanks()`/`findBank()`, and everything built on
them — `storage.ts`'s project save/load, the app's `read_banks` WebMCP
tool, the inspector panel — because `CREATE-BANK` never touches
`BankTable`'s own array, only `MMAP`. It's real, addressable, and
correctly findable via `BANK@` (M20) and any raw `MMAP` read — genuinely
invisible to host-array readers, not partially. This is the direct,
structural cost of "no host round-trip," not an oversight; a future
consumer wanting the inspector panel to show Forth-created banks too
would need `getAllBanks()` itself to start reading `MMAP` — real,
separate follow-on work, now tracked in the open-items list.

**A real gotcha, found while writing this milestone's own tests, not
theorized in advance:** a tag longer than 4 characters (the fixed
width every real tag already respects by convention — `SYSV`, `DICT`,
`DATA`, …) silently truncates on write, but `BANK@`'s lookup compares
the *full*, untruncated token against a slot's stored (always ≤4 char)
tag. `4096 CREATE-BANK MYDATA` creates a bank findable only via
`BANK@ MYDA`, never `BANK@ MYDATA`. Not a new inconsistency —
`BANK@` has always compared full strings against real tags that were
always ≤4 characters by convention, never enforced by code — just the
first time anything could actually *create* a tag violating that
convention, surfacing a sharp edge that was latent before. Left as-is,
matching "no host validation."

**Verified via the engine test suite** (`mmap.test.ts`, 6 new tests):
a bank created via `CREATE-BANK` is immediately findable via `BANK@`
at the same address; it lands exactly at `MMAP`'s prior next-free
offset and advances that cell by exactly its size; its memory is
genuinely usable (`@`/`!` round-trips); it names itself after its
(possibly-truncated) tag; the table throws once all 64 slots are used;
and, explicitly, it does *not* appear in `getAllBanks()`/`findBank()`
— a test asserting the documented gap exists, not just hoping it
doesn't regress silently. **Live-verified in the browser** via WebMCP:
`4096 CREATE-BANK DAT1 . BANK@ DAT1 .` printed `84924 84924` (both
agreeing, at `MMAP`'s real next-free offset); `1234 BANK@ DAT1 !
BANK@ DAT1 @ .` printed `1234` — genuinely usable memory, not just a
descriptor; `read_banks` and an inspector-panel screenshot both
confirmed `DAT1` doesn't appear there, cross-checking the documented
gap live. Zero console errors.

**Tests:** 218 engine tests total (212 before this milestone, 6 new in
`mmap.test.ts`), confirmed via a full test run. 10 app tests and the
full build unaffected — no Angular/UI changes.

## M22 — `BankTable` reads/allocates through `MMAP`, no cached state anywhere — done

Scoped in `DEVELOPING.md` §14 after a real design pivot mid-conversation:
first scoped as "consolidate two drifting `nextFree` cursors into one,"
then corrected directly — `ACTIVE` is per-slot occupancy, not a
flush-safety detail (that concern stayed explicitly out of scope) —
and taken to its actual conclusion: no cursor cell at all, everything
derived by scanning `MMAP`'s 64 fixed slots.

**What shipped:** `mmap.ts` gained one new method, `allocate(tag, name,
size, flags): MMapSlot`, replacing `addBank()`/`getNextFree()`/
`getSlotCount()` outright (deleted, not deprecated). It scans all 64
slots in one pass — the first with `ACTIVE` off becomes the target
slot, `max(base + size)` over every currently-`ACTIVE` slot becomes the
new `base` — writes the full descriptor, then sets `ACTIVE` last
("prepare it, then switch it on"). `MMAP`'s header shrank from 12 bytes
(magic+version+reserved+nextFree+slotCount) to 4 (magic+version+
reserved only) — `MMAP_SIZE` is now 1540, confirmed live (every other
bank's base shifted down by exactly 8 bytes). The `BankFlag*` constants
moved from `banks.ts` into `mmap.ts` (re-exported from `banks.ts` for
the existing public surface), since `mmap.ts` now needs `ACTIVE`
natively as part of its own occupancy model — deliberately avoiding
recreating M19's own circular-import bug in the opposite direction.
`BankTable.createBank()`/`getAllBanks()`/`findBank()`/`findBankByName()`
all delegate to `mmap` now; the private `banks` array, `nextFree`
counter, and the `arena.sizeBytes` out-of-space check are all gone —
the last one deliberately, unifying host-side creation with
`CREATE-BANK`'s existing "`DataView` catches it at first real access"
precedent rather than keeping host-only validation as a new asymmetry.
`nextSerial` (auto-serial naming) is untouched — `CREATE-BANK` never
generates one, so it was never exposed to this bug class.

**The overlap bug from M21 is fixed, confirmed by re-running the exact
repro that found it**: `64 CREATE-BANK FTAG` then
`banks.createBank('DATA', 64, 'HOSTBANK')` now land at different,
non-overlapping addresses (`84916`/`84980`), and `getAllBanks()` shows
both.

**A second real bug, found while implementing, not scoping:**
`allocate()` unconditionally forces `ACTIVE` into what it *writes*, but
an early version of `createBank()` built its returned `Bank` from the
raw `flags` parameter the caller passed, not from what actually got
persisted. Any caller supplying `flags` without `ACTIVE` already set —
exactly the pre-existing "respects a caller-supplied flags value" test,
passing `BankFlagExternal` alone — silently disagreed:
`bank.flags` (2) vs. the real stored `18` (`EXTERNAL | ACTIVE`). Caught
immediately by that existing test, not discovered later. Fixed by
having `allocate()` return the actual stored `MMapSlot` (structurally
identical to `Bank`, so no transform needed) instead of just a `base:
number`.

**Verified via the engine test suite**: `banks.test.ts`'s three
`.toBe()` reference-identity assertions updated to `.toEqual()` (object
identity is no longer stable — every read now decodes fresh from arena
bytes); `mmap.test.ts`'s seven `getNextFree()`/`getSlotCount()`
references rewritten against `allocate()`'s shape; the M21 test "is
invisible to `getAllBanks()`/`findBank()`" inverted to assert the
opposite; new tests for the uniqueness check catching a Forth-created
bank's name and for `ACTIVE` being present in both the returned `Bank`
and the mirrored slot (the test that caught the second bug above).
**Live-verified in the browser** via WebMCP: a fresh `Machine`'s
`read_banks` showed `MMAP` at `1540` bytes with every other bank's base
shifted down by 8; `4096 CREATE-BANK DAT1 .` printed `84916`; a
follow-up `read_banks` and inspector-panel screenshot both showed
`DAT1 DAT1 84916 4096` right alongside every host-created bank. Zero
console errors.

**Tests:** 219 engine tests total (218 before this milestone, 1 net
new — several rewritten, not just added). 10 app tests and the full
build unaffected — no Angular/UI changes.

## M29 — `PROJECT`/`SAVE`/`RESTORE`: naming, saving, and restoring a whole session — done

Note: this log jumps from M22 straight to M29 — M23-M28 shipped and are
fully documented in `DEVELOPING.md` §§15-21, just never copied back
into this file's own per-milestone write-ups. Not backfilled here
(out of scope for this milestone); flagged so a future reader isn't
confused by the gap, same "found and closed" discipline `DEVELOPING.md`
§19 already models for a different kind of drift.

Full design/motivation/decisions/verification: `DEVELOPING.md` §22.
Short version: `PROJECT name` sets the current project (a new 2-cell,
8-char `STORAGE`-group sysvar, `spec/03-SYSVARS.md` §10); `SAVE`
writes every active bank — `MMAP` included — to `/PROJECTS/<name>/`;
`RESTORE name` implements `spec/01-HAL.md` §6.3.1's real `MMAP`-first
two-phase restore, reproducing a project's exact original bank layout
(bases, extra `CREATE-BANK`'d banks and all) with no new bump-allocator-
bypass primitive needed — `MMAP` is arena-resident and caches nothing,
so overwriting its raw bytes is enough. `storage.ts`'s tag↔extension
table also grew from 5 to the spec's full 13 entries (`SYSV`/`DSTK`/
`RSTK`/`CHAR`/`KMAP`/`MMAP`/`TIB`/`PAD` were all missing before this —
a real, pre-existing gap, not introduced here). Async storage I/O gets
one new `StepSignal`/`StepStatus`, `'storage'` — same suspend/resume
shape M7's blocking `KEY` established, host-driven via the new
`Machine.runPendingStorage()`. `RESTORE` also required a new
`Screen.redrawAll()`, since it overwrites `CHAR` bytes directly,
bypassing the normal per-character HAL write-through nothing else
would otherwise repaint from. `WARM`/`COLD` deliberately deferred —
`Machine`'s fields are `readonly`, a real cold-reset needs its own
focused pass.

**Tests:** 275 engine tests total (259 before this milestone, 16 new:
a new `sysvars.test.ts`, a new `project.test.ts`, two more in
`storage.test.ts`, one more in `screen.test.ts`). App build unaffected
(`app.ts`'s `tick()` gained a `storageInFlight`-gated branch for the
new `'storage'` status, same shape as its existing `'breakpoint'`
handling — no test suite changes needed there).

## M30 — Bank allocation actually conforms to spec/02-MEMORY-MODEL.md §4.3/§4.4 — done

Full design/motivation/verification: `DEVELOPING.md` §23. Short
version: two real, longstanding gaps against the memory-model spec,
found by checking rather than assuming. `BankTable.createBank()` never
rounded a requested size up to a real size class (XS/S/M/L/XL/XXL) —
`CHAR`/`TIB`/`PAD` all carved non-class-sized banks — and the
Forth-level `CREATE-BANK` primitive bypassed `BankTable.createBank()`
entirely, calling `mmap.allocate()` directly with an unrounded raw
size. Separately, `MemoryMap.allocate()`'s bump allocator never
4 KiB-aligned a new bank's base at all — confirmed live: `SYSV` sat at
`0x610` (right after `MMAP`'s own non-class-sized 1552 bytes), not the
spec-mandated `0x1000`. Both fixed at their one real choke point:
`createBank()` now rounds via the already-existing `roundToSizeClass()`
before ever carving; `CREATE-BANK`'s primitive now routes through
`createBank()` instead of duplicating (and bypassing) its own
name-generation logic; `MemoryMap.allocate()` now 4 KiB-aligns the
computed base unconditionally, including for `MMAP`'s own
self-registration (harmless — offset 0 is already aligned).

**Live-verified** via WebMCP `read_banks`: a fresh `Machine`'s boot
layout now matches `spec/02-MEMORY-MODEL.md` §5.4's worked example
exactly, bank for bank, base for base. `PROJECT`/`SAVE`/`RESTORE`
(M29) re-verified afterward, unaffected.

**Tests:** 276 engine tests total, all pre-existing — a correctness
fix, not new behavior. Five broke on the new (correct) sizes/bases and
were updated: three in `mmap.test.ts` (hardcoded offsets), one in
`stack.test.ts` (an artificially-tiny overflow-test bank, now built as
a raw `Bank` object rather than through `createBank()`, which would
round it away), one in `strings.test.ts` (a "too long for PAD" probe
string that no longer exceeds `PAD`'s new real 4096-byte capacity).

## M31 — `TIB` and `PAD` merged into one `WORK` bank — done

Full design/motivation/verification: `DEVELOPING.md` §24. Short
version: a follow-on from M30 — with size-class rounding now enforced,
`TIB` and `PAD` (128 logical bytes each) were independently paying for
a full XS class apiece. Both are the same kind of thing (small,
transient, per-line scratch text), so they now share one `WORK` bank
at fixed sub-offsets (`TIB` at offset 0, `PAD` at offset 128) — one
size class instead of two. Logical capacities (128 bytes each)
unchanged deliberately — a pure allocation-topology change, not a
behavior change. `BANK@ TIB`/`BANK@ PAD` no longer resolve (only
`BANK@ WORK` does) — a real, expected consequence, but `PAD ( -- addr
)` (the actual way Forth code reaches it) is unaffected. Spec updated
to match: `02-MEMORY-MODEL.md` §4.6/§5.4 and `01-HAL.md` §6.3 all
replace the separate `TIB`/`PAD` tags with `WORK`.

**Live-verified** via WebMCP: a fresh `Machine` shows 8 banks instead
of 9; `S" ..." TYPE` and ordinary line input both work through the
shared bank; `PROJECT`/`SAVE`/`RESTORE` re-verified end to end
afterward, `WORK` round-tripping as one asset file.

**Tests:** 276 engine tests, no net change — a topology change, not
new behavior. Two pre-existing tests updated for the new tag list/
capacity.

## M32 — `FORGET` — done

Full design/motivation: `DEVELOPING.md` §8.6. `FORGET` was originally
part of a larger Canon Cat `tForth`-inspired exploration that got
dropped wholesale early on (its actual scope belonged at an editor-UI
layer, not this interpreter) — but `FORGET` itself was never a bad
idea on its own merits, just left as an open, unaddressed question
once `VOCABULARY`/`USE` (M13) hit and fixed half of the same blocker
for a different reason.

**The blocker:** `HERE`, like `LATEST` before M13, was read-only from
Forth — `primitives.ts` case 59 only ever pushed
`ctx.sysvars.getHere()`, no address exposure a `!` could target.
Reclaiming a forgotten word's `DICT` space needs to roll `HERE` back
to that word's own address, not just relink `LATEST` past it — `HERE`
is the piece M13 explicitly deferred ("`HERE-ADDR` would be
`FORGET`'s own concern if that gets picked back up").

**The fix, same pattern as `LATEST-ADDR`:** one new primitive,
`HERE-ADDR ( -- addr )` (token 125), reusing
`Sysvars.fieldOffset('FORTH', 'HERE')` — the exact offset math
`getHere()`/`setHere()` already compute internally, now reachable from
Forth. `FORGET` itself is pure Forth source in `system.fth`, needing
zero further engine changes:

```forth
: FORGET
  '
  >R
  LATEST
  BEGIN
    DUP
  WHILE
    DUP >CFA R@ =
    IF
      DUP @ LATEST-ADDR !
      HERE-ADDR !
      R> DROP
      EXIT
    THEN
    @
  REPEAT
  DROP R> DROP
;
```

Reuses `HIDE`'s exact reverse chain-walk (`'` resolves the target name
to an xt, then walk `LATEST`'s link chain comparing each entry's
`>CFA` against it) — only the found branch differs: instead of OR-ing
in `FLAG_HIDDEN`, the found entry's own link cell (`addr @`, the word
defined right before it) becomes the new `LATEST`, and the entry's own
address becomes the new `HERE`. This is exactly what `dictionary.ts`'s
`abortDefinition` already does for a definition left half-built by a
compile error — `FORGET` is the same rollback, just reachable for any
named word instead of only ever the current `LATEST`. Defined
immediately after `HIDE` in `system.fth`, before the `HIDE >CFA`/
`HIDE XT-NAME`/... block runs, for the same reason `SEE` has to be —
it still needs to call `>CFA` by name while compiling its own body.

**Known, deliberately unaddressed limitation**, carried forward
unchanged from the original open question: forgetting a word that
some *other* vocabulary's own branch point depends on being there
leaves that vocabulary's chain corrupted. Not designed — `VOCABULARY`/
`USE` and `FORGET` don't have a concrete joint use case yet, so this
stays an open question rather than a guessed-at fix.

**Tests:** 283 engine tests (276 + 7: two `HERE-ADDR` tests mirroring
`LATEST-ADDR`'s own in `dictionary.test.ts`, five in a new
`forget.test.ts` — removal, `HERE` rollback, definitions before the
forgotten word surviving, definitions after it also going away, and
the unknown-name error case leaving the dictionary untouched). Live-
verified end to end against the actual shipped `system.fth` (not just
the inlined test copy): `FORGET` removes the target and everything
after it, words defined earlier are unaffected, and `VOCABULARY`/
`USE`/`HIDE`/`WORDS`/`SEE` all still function normally afterward.

## M33 — Storage becomes synchronous (`localStorage`, not OPFS); `BSAVE`/`BLOAD` — done

Full design/motivation/alternatives-considered: `DEVELOPING.md` §25.
Short version: asked to add `BSAVE`/`BLOAD` "despite the async
constraints" — investigating surfaced that `PROJECT`/`SAVE`/`RESTORE`
(M29) were never real dictionary words at all, only outer-loop-only
special syntax, because OPFS forced `repl.ts`'s core execution model to
grow a dedicated `'storage'` suspend/resume `StepStatus`. Checked
directly against `FORTH-ARCHITECTURE.md`'s porting note for
`hal_block_read`/`write` and `HAL.md` §2, not assumed: the cross-target
spec always described storage as "an ordinary bank access, not a device
call," and real hardware's own access (`CStorageModule`, bare-metal
blocking FAT/USB I/O) has no async concept at all — the async
requirement was a browser-platform artifact leaking into the shared
engine contract, not a genuine cross-target need.

Two alternatives seriously considered and rejected before landing on
the fix: a Web Worker for the interpreter (the only way to reach a
genuinely synchronous OPFS API, `FileSystemSyncAccessHandle`, since
it's Worker-only by browser design — rejected as reversing M7's already
-settled main-thread decision, real architectural surgery not warranted
by this problem's size) and `lightning-fs` (checked directly against
its own docs before ruling it out — Promise/callback-only, no
synchronous API at all, IndexedDB has the identical main-thread
limitation OPFS does; same problem with nicer ergonomics and a bigger
quota, not an actual fix).

**The fix:** `localStorage` — a real, ordinary Web Storage API,
genuinely synchronous, no Promises, no Worker, ships everywhere,
persists across reloads. Traded away deliberately: OPFS's much larger
effective quota (localStorage: ~5-10MB per origin, browser-dependent)
and native directory model (localStorage: a flat key namespace, POSIX
paths become key prefixes) and binary storage (payloads base64-encoded,
localStorage is string-only) — all acceptable given Rebel's own bank
sizes are nowhere near what would bind on that quota.

`StorageHal` (`storage.ts`) dropped every `Promise`; `Storage`'s
methods and `runStorageSelfTest()` all became plain synchronous
methods. New: `Storage.loadAsset(project, bank)`, the single-bank
counterpart to `openProject()`'s whole-directory restore — overwrites
an already-existing bank in place, zero-padded if short, throws (not
silently skips) if the saved payload is too large for a single named
request. `repl.ts`'s `'storage'` `StepStatus` and `Machine`'s
`pendingStorage`/`pendingStorageError`/`runPendingStorage()`/
`throwPendingStorageError()` are all gone. `PROJECT`/`SAVE`/`RESTORE`
moved from `interpretExecuting`'s special syntax into `primitives.ts`
as ordinary dispatch cases (tokens 126-128) — genuine dictionary
entries now: listed, `'`-resolvable, `HIDE`/`FORGET`-able, and (`SAVE`
specifically, which parses no further input) fully usable compiled or
via `EXECUTE`. Two new primitives, `BSAVE ( "tag" -- )`/
`BLOAD ( "tag" -- )` (tokens 129-130), resolve a bank via
`BankTable.requireBank(tag)` (`BANK@`'s own single-tag addressing) and
call `saveAsset`/`loadAsset` directly; `BLOAD` repaints the screen only
when the loaded bank is `CHAR`, same reasoning `RESTORE` already
established.

**Known, inherited (not new) limitation:** `PROJECT`/`RESTORE`/`BSAVE`/
`BLOAD` still parse their name/tag argument via `nextInputToken()` —
the same shape `BANK@`/`CREATE-BANK`/`'` already have, which only
resolves correctly when interpreted directly, not compiled with a
following literal (the compiler tries to resolve that literal as its
own word first, before the primitive gets a chance to consume it).
Real Forth's file-access words avoid this by taking a `c-addr u` string
from the stack instead — not adopted here since nothing has a concrete
need for a dynamically-computed name/tag yet.

`packages/app/src/app/opfs-storage-hal.ts` deleted, replaced by
`local-storage-storage-hal.ts`. `app.ts`'s `tick()` lost its
`storageInFlight` signal and the `'storage'`-status branch entirely.

**Tests:** 293 engine tests (283 + 10: `storage.test.ts` fully
un-asynced plus three new `loadAsset` tests; `project.test.ts` fully
un-asynced, its old "rejected inside a colon-definition" test flipped
to prove the opposite for `SAVE` and genuine-dictionary-entry status
for `PROJECT`/`RESTORE`, plus a new `BSAVE`/`BLOAD` describe block).
Live-verified in a real browser: `PROJECT`/`: GREET 42 ;`/`SAVE`/
`BSAVE DICT`, confirmed real `rebel-sim:/PROJECTS/...` keys in the
browser's actual `localStorage`, a genuine full-page reload, then
`RESTORE`/`GREET .` printing `42` and `BLOAD DICT` succeeding — proof
against real browser storage, not JS memory continuity.
