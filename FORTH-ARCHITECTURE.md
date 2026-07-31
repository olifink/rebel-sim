## The "Rebel-ROM" Forth Architecture Specification (v5)

**v5 change:** pulls in `CHANNELS-DESIGN.md` (previously an unreferenced
sibling doc) as new §7a, reconciled against the shipped `CScreenModule`/
`CKeyboardModule` and Rebel-Sim's M1-M6 engine — this is the mechanism
that resolves §5's outer-loop-as-task anticipation and §7's
blocking-`KEY`-layered-on-non-blocking-primitive rule into an actual
binding target.

The Forth system targets three environments that must share **identical Forth source** at the word-definition level, differing only at the HAL/sysvars boundary:

- **Rebel-Sim** — TypeScript, browser-based, fast-iteration simulator for tool development
- **Rebel-ROM** — C++/Circle bare-metal primitives on Arm (Pi 500 / Pi 400)
- **Rebel-Board** — RISC-V, Pico 2 (RP2350), custom hardware

This document is the rule set for a coding agent implementing the interpreter across all three. Changes from v1 are called out inline as **[REVISED]** or **[NEW]**.

**[v3→v4]** Per the project's own direction, **Rebel-ROM is the reference
implementation** — the only one of the three that exists in code
(`CLAUDE.md`: Phases 3-9 done, hardware-verified), and where this spec's
original (v1/v2) assumptions disagreed with what actually shipped, the
shipped design wins. v3 marked those disagreements as **[CROSS-CHECK]**
notes layered alongside the old text. **v4 graduates the settled ones into
the actual rules** — the rule text itself now states what Rebel-ROM does,
followed by explicit **"Porting to Rebel-Sim"**/**"Porting to Rebel-Board"**
guidance describing what each target's HAL must reproduce to keep shared
Forth source working. Genuinely open questions (no shipped precedent to
defer to) stay marked **[OPEN]** rather than **[CROSS-CHECK]** — §9/§10
track those. Read `docs/MEMORY-MODEL.md`, `docs/SYSVARS.md`,
`docs/SCREEN-MODULE.md`, `docs/KEYBOARD.md`, `docs/STORAGE.md`, and
`docs/EXECUTION-LOOP.md` alongside this — they remain the source of truth
for implementation detail this document only summarizes.

---

### 0. Canonical Opcode & Layout Source of Truth **[NEW]**

* **The Rule:** Primitive token IDs, sysvar offsets, dictionary flag bits, and HAL call numbers must be defined **once**, in a single machine-readable source (e.g. `rebel-opcodes.yaml` or `.json`), and generated into:
  * a TypeScript `const enum` / lookup table for Rebel-Sim,
  * a C++ header for Rebel-ROM,
  * a constants file (or assembler `.equ` set) for Rebel-Board.
* **Why:** Three hand-maintained copies of `DUP = 1, SWAP = 2` will drift. This is the single highest-risk item for the whole "shared source" goal — everything else in this document assumes it's solved first.
* **Agent task:** generate this file and the three codegen outputs before writing any interpreter logic.
* **[CROSS-CHECK]** `docs/SYSVARS.md` §7 already flagged this *exact*
  class of risk, scoped to sysvars alone ("the C++ struct offsets and the
  Forth constant addresses are two independent hand-written descriptions
  of the same layout... define the layout once, generate both"), and
  deliberately deferred building the generator until the field list saw
  enough real movement to justify it (`docs/SYSVARS.md` §9). Don't build
  two separate generators — one source-of-truth file/tool should cover
  primitive token IDs, sysvar offsets (superseding `docs/SYSVARS.md` §7's
  version), dictionary flag bits, HAL call numbers, *and* the bank tag/
  size-class table from `docs/MEMORY-MODEL.md` §3, since a coding agent
  building Phase 11 needs all four kinds of constant and they're the same
  shape of problem. Building it is still correctly gated on Phase 11
  actually starting, not before — but when it does, build one tool, not
  several.

---

### 1. The Unified Cell Size (Strictly 32-bit) **[REVISED]**

* **The Rule:** The Cell is exactly 32 bits (4 bytes), stored as raw two's-complement bits. It is interpreted as **signed or unsigned depending on the operation**, not intrinsically "signed" — e.g. `+`, `-`, `*`, `<` treat it signed; address arithmetic, `U<`, and dictionary offsets treat it unsigned.
* **Why the change:** calling it strictly "signed" is fine for arithmetic words but wrong for address/offset words, which need the full 0..4294967295 range even though your arena (8MB) never gets close to overflowing that — worth being precise now rather than papering over it later.
* **Out of scope, flag for a decision:** floating point is not covered by this spec. If you want float support later, it should be a separate float stack (standard Forth practice), not packed into the integer cell.
* **[v4] Addresses are per-arena offsets, never raw pointers — this is now
  the firm rule, not just a compatibility note.** Rebel-ROM is built
  AArch64 (`CBank`/`CBankTable`, `src/membank.h`, use real 64-bit `void
  *`/`size_t` internally, and Circle's `HeapAllocate()` returns an
  absolute 64-bit address), yet a 32-bit Forth cell works cleanly because
  `docs/MEMORY-MODEL.md` §2 fixes every Forth-visible address as an
  *offset from its own arena's base*, never a raw pointer. Every `@`/`!`
  primitive (and any HAL call taking a "memory offset") does the
  conversion `real_ptr = (u8 *) pBankTable->GetArenaBase() + forth_offset`
  at the primitive-dispatch boundary — the 64-bit host pointer never
  becomes a Forth cell value on any target, 64-bit-hosted or not.
* **[v4] A single arena is capped at just under 4 GiB
  (`CMemoryModel::MaxArenaSize`, `src/membank.h`/`.cpp`) — landed in code.**
  Necessary because the conversion above only holds if no arena's offset
  range exceeds what an unsigned 32-bit value reaches.
* **[v4] Using more RAM than one arena holds means more *arenas*, not a
  bigger cell or a paged single address space.** `docs/MEMORY-MODEL.md`
  §3.7 is the firm resolution: a machine claims as many `MaxArenaSize`-
  capped, mutually isolated arenas as its free RAM supports — one on a
  1GB Pi, several on a 16GiB-class Pi 500+ — each a complete, independent
  Rebel instance (own `SYSV`/`DICT`/`RSTK`/`DSTK`/`CHAR`), not one
  instance stretched or starved. A running Forth task is bound to exactly
  *one* arena for its whole lifetime — decided at task creation, never
  switched mid-flight — so `@`/`!` never reason about "which arena" per
  access; there's no mutable paging register and no segment:offset-style
  fat pointers. (§3.7's own distinction: which arena a *task's memory*
  belongs to is fixed forever; which arena the *operator* is currently
  attached to is the only thing that's switchable, and it never touches
  a running task's addressing.)
* **Porting to Rebel-Sim (TypeScript):** one arena = one `ArrayBuffer` +
  `DataView` pair (§3). Multiple arenas = multiple such pairs, each with
  its own generated bank-offset table (§3's porting note). No `MaxArenaSize`
  cap is strictly required in-browser (a `DataView` isn't limited to 4GiB
  the way a 32-bit offset is), but the Forth-visible cell width still is —
  don't let a TS arena's *addressable* region exceed 2^32 bytes even if
  the host could technically allocate more, or a dumped-and-restored state
  stops round-tripping to Rebel-ROM.
* **Porting to Rebel-Board (RISC-V/RP2350):** the 32-bit cell was chosen
  *because of* this target — both RP2350 cores (Cortex-M33 or Hazard3,
  never mixed) are natively 32-bit, so this is the one target where the
  cell width costs nothing extra. In practice Rebel-Board will almost
  certainly run exactly one arena, sized to whatever PSRAM the board
  carries (real chips here are nowhere near 4 GiB) — the multi-arena
  mechanism from `docs/MEMORY-MODEL.md` §3.7 should still exist in the
  same shape for source compatibility, just degenerate to "arena count
  is always 1, always attached."

---

### 2. Endianness **[NEW — closes a real bug in v1]**

* **The Rule:** All multi-byte reads/writes across all three targets are **little-endian**, with no exceptions.
* **Why:** Arm (Pi 500/400) and RISC-V (RP2350) are both little-endian by default in this configuration, so this costs nothing on the native targets. The risk is entirely in TypeScript: `DataView.getInt32()` / `.setInt32()` **default to big-endian** unless you pass `littleEndian = true` explicitly. Every single call must pass that flag, or the "dump the ArrayBuffer, boot on hardware" guarantee in §3 silently breaks — the file will look correct in the sim and be garbage on the Pi.
* **Agent task:** wrap all DataView access in a small accessor module (`readCell(offset)`, `writeCell(offset, value)`) so the `littleEndian: true` argument exists in exactly one place, not scattered through call sites.

---

### 3. Banks Within One or More Arenas (No Native Objects) **[v4 — supersedes v2's flat-offset-table framing]**

* **The Rule:** Dictionary, Data Stack, Return Stack, Sysvars, and
  screens/block-equivalent data all live inside a pre-allocated flat byte
  array (the **arena**) — that part of v1/v2's framing was right. What's
  revised: they are **not** found at fixed absolute offsets within it.
  Rebel-ROM's shipped design (`docs/MEMORY-MODEL.md`, Phase 3, done)
  carves the arena into **banks** — fixed-size, independently-based, named
  regions (`tag` + `name` + base address + size class + flags), handed out
  in creation order and never relocated once created — and this is now
  the rule for all three targets, not an implementation detail unique to
  Rebel-ROM. A bank's address never having to move is what makes future
  bank-swap-from-disk support possible with no relocation/pointer-fixing.
* **Implementation:**
  * *C++:* one arena = one `HeapAllocate()`'d block, wrapped by
    `CBankTable` (`m_MemoryModel.GetArenaBase()`); banks are
    `CBankTable::CreateBank()` calls against it.
  * *TypeScript:* one arena = one `ArrayBuffer` + `DataView` pair (see §2
    for endianness), with a parallel bank-offset table generated the same
    way as Rebel-ROM's (see the porting note below).
  * *RISC-V:* one arena = a direct mapping to physical SRAM/PSRAM, same
    bank-offset table mechanism, sized to whatever the board carries.
* **The known-bank list** (`docs/MEMORY-MODEL.md` §3.3, extended per §3.7)
  is the actual "memory map" now, in place of a literal offset table:

  | Tag | Purpose | Per-arena or shared |
  |---|---|---|
  | `SYSV` | sysvars | per-arena |
  | `DICT` | dictionary / user program space | per-arena (not yet created — Phase 11) |
  | `RSTK` | return stack | per-arena (new tag, add when Phase 11 starts) |
  | `DSTK` | data stack | per-arena (new tag, add when Phase 11 starts) |
  | `CHAR` | character-code grid | per-arena |
  | `SCRN` | pixel framebuffer | shared — singular hardware, never duplicated |
  | `KMAP` | active keymap | shared — host/hardware config, not program state |
  | `SPRT` | sprite/tile data | per-arena |
  | `CART` | cart-loaded code | per-arena |
  | `DATA` | scratch | per-arena |

  `HERE`/`LATEST` grow up within `DICT`; `RSTK`/`DSTK` grow down within
  their own banks — not "from end of sysvars" or "from `ARENA_SIZE`" as
  v2 assumed, since other banks occupy the arena in between by the time
  Phase 11 lands. Screens/block-equivalent storage is addressed in §7,
  not this table — see the storage-model rule there.
* **Stack growth direction and overflow checks** must be identical across
  targets — down-growing within each stack's own bank, bounds-checked
  against that bank's own size (via its own `SP0`/`RP0`-equivalent
  sysvars, §4) — uniformly.
* **This does not threaten "identical Forth source across three
  targets."** Forth code addresses a bank via a named constant resolving
  to a base address (`SCREEN-BANK`, `FONT-BANK`, `docs/MEMORY-MODEL.md`
  §3.2) exactly like it addresses a sysvar (§4's boundary rule) — the
  bank mechanism is a HAL/boot-time concern, invisible to compiled Forth
  source.
* **Porting to Rebel-Sim (TypeScript):** doesn't need Circle's
  `CBankTable` class, but must reproduce the same *addressing contract*: a
  boot-time table mapping each tag/name to an offset within its own
  arena's `ArrayBuffer`, generated from the same `docs/MEMORY-MODEL.md`
  §3.3 known-bank list via the §0 codegen tool, not hand-picked
  independently. Forth source referencing `DICT-BANK`/`SCREEN-BANK`/etc.
  must resolve to the same *kind* of value (an offset from that
  instance's own arena base) on every target.
* **Porting to Rebel-Board (RISC-V/RP2350):** same addressing contract,
  smaller numbers — the size classes in `docs/MEMORY-MODEL.md` §3.1 (XS
  through XXL) aren't required to be identical byte counts across targets,
  just proportionally consistent to the same 4x-ladder shape; RP2350's
  small PSRAM will likely need every class scaled down. The tag/name/
  lookup mechanism itself doesn't change.
* **Per-arena vs. shared banks (`docs/MEMORY-MODEL.md` §3.7):** each
  isolated arena gets its own private `SYSV`/`DICT`/`RSTK`/`DSTK`/`CHAR` —
  every running Forth machine has its own dictionary and stacks, not a
  shared copy. `SCRN` stays the one singular resource this document
  already describes — never duplicated, driven by whichever arena is
  currently attached — and `KMAP` likewise stays host-level/shared rather
  than per-arena. This applies on every target: Rebel-Sim's "arena" is a
  browser tab's `ArrayBuffer`, and it can have more than one in memory at
  once the same way Rebel-ROM can; Rebel-Board will in practice almost
  always run exactly one (§1's porting note).

---

### 4. Sysvars: The Portable/Native Boundary **[v4 — mechanism confirmed, shape corrected]**

This is the mechanism that lets identical Forth source run on all three targets while direct hardware access differs.

* **The Rule:** sysvars live in a dedicated bank (`SYSV`) as ordinary Forth
  cells, organized into **fixed-offset, subsystem-owned groups** — not one
  flat table at the arena base, as v2 originally described. This is
  `docs/SYSVARS.md`'s shipped design (Phase 4, done —
  `src/sysvars.h`'s `SYSVARS_*_OFFSET` constants): `CORE`, `SCREEN`,
  `KEYBOARD`, `FONT`, `SPRITE`, `STORAGE` today, plus a new **`FORTH`**
  group this spec requires (below). Forth *words* still never contain
  target-specific logic — they only ever read/write sysvars through `@`/
  `!`, exactly like any other variable; only the internal organization
  changes from "one flat list" to "grouped by owning subsystem."
* **The `FORTH` group (new, required):** none of the six existing groups
  owns interpreter state, so add `SYSVARS_FORTH_OFFSET` (same 64-byte-slot
  incremental-reservation pattern as the others) holding:
  * `SP0`, `RP0` — stack base addresses
  * `HERE`, `LATEST` — dictionary pointers
  * `BASE`, `STATE` — standard Forth

  Add it to `docs/SYSVARS.md` §2's table and `src/sysvars.h` when Phase 11
  starts, generated from the same §0 source-of-truth as everything else —
  not hand-added independently on each target.
* **`SCREEN-WIDTH`/`SCREEN-HEIGHT` already exist, in the `SCREEN` group:**
  `TScreenSysVars::nScreenWidth`/`nScreenHeight` in `src/screenmodule.h`
  (`docs/SCREEN-MODULE.md`) — differ per target (Rebel-Sim's canvas vs.
  Rebel-ROM's HDMI framebuffer vs. Rebel-Board's display, if any), same as
  originally specified, just located at `SYSVARS_SCREEN_OFFSET +
  offsetof(TScreenSysVars, nScreenWidth)`, not a flat `SCREEN-WIDTH`
  constant with no group prefix.
* **`BLOCK-DEVICE` is not a runtime-switchable sysvar on Rebel-ROM.**
  `CLAUDE.md`'s storage model and `docs/STORAGE.md` §8 fix the backing
  device architecturally — always the first USB mass-storage device
  (`"USB:"`), never the SD/eMMC boot card, with no runtime switch. Keep
  the sysvar defined in the shared spec (Rebel-Sim may genuinely want to
  choose IndexedDB vs. LocalStorage; Rebel-Board may choose between
  onboard flash regions), but on Rebel-ROM it's a read-only diagnostic
  constant, never something Forth is expected to write to change
  behavior — don't add a switch code path Rebel-ROM's own design
  deliberately doesn't have just for spec uniformity.
* **Why:** a word like `PAGE-WIDTH` or a screen-clearing routine written once in Forth reads `SCREEN-WIDTH @` and behaves correctly on all three targets, because each HAL's boot routine writes the *right value* into that sysvar at startup — the Forth source itself never branches on "which target am I."
* **Boundary rule:** if a piece of behavior can be expressed as "read a sysvar, act the same way everywhere" — it belongs in Forth source. If it genuinely requires different *code paths* per target (e.g. actually talking to Circle's USB stack vs. the DOM `keydown` event), it belongs in the HAL (§7), not in a sysvar-driven branch inside a Forth word.
* **Porting to Rebel-Sim (TypeScript):** reproduce the same grouped-offset
  layout inside its own sysvars region of the `SYSV` equivalent — generate
  the TS constant table from the same source (§0), don't re-derive group
  offsets independently. A TS-specific group is fine if something
  genuinely needs one (browser-only state), following the same
  incremental-reservation pattern as `docs/SYSVARS.md` §2.
* **Porting to Rebel-Board (RISC-V):** same grouped layout; likely a
  subset of groups populated (no `KEYBOARD` group meaning much if the
  board has no USB HID input, for instance) — an empty/unused group is
  fine, matching `docs/SYSVARS.md`'s own "reserved slots, filled in when
  the owning subsystem lands" precedent.

---

### 5. The Threading Model: Token-Threaded (Switch Dispatch) **[REVISED for clarity]**

* **The Rule:** unchanged — Token Threading via a `switch`/jump-table inner interpreter, not Direct or Subroutine Threading.
* **[REVISED] Disambiguating primitive vs. colon-definition dispatch:** v1's description ("if it matches a primitive ID execute it, if it points to a high-level word jump to that offset") left the two cases ambiguous — a single Code Field can't be interpreted both ways without a rule. Use this instead:
  * Every dictionary entry's **Code Field** holds a token ID.
  * Token IDs `0 .. N-1` are reserved for native primitives (`+`, `DUP`, `SWAP`, …) and dispatch directly into the `switch`.
  * Token ID `DOCOL` (a single reserved sentinel, e.g. `0`, with all real primitives starting at `1`) means "this word's Parameter Field is a list of further token offsets" — the inner interpreter pushes the current Instruction Pointer to the Return Stack and begins executing the Parameter Field.
  * The interpreter never inspects an address to *guess* which case it's in — the Code Field value always tells it unambiguously.
* **Why this matters:** it's the exact mechanism the codegen in §0 needs to get right identically in three languages; leaving it implicit invites three different (and subtly incompatible) implementations.
* **[CROSS-CHECK] The outer loop's substrate already exists and is a
  design constraint, not a blank slate.** `docs/EXECUTION-LOOP.md` (Phase
  7, done) built Rebel-ROM's execution loop on Circle's cooperative
  `CScheduler`/`CTask`, specifically anticipating that "the Forth executor
  (Phase 11) is a task... blocking on the input queue when waiting for a
  keystroke, exactly like any cooperative task waiting on a
  synchronization primitive." The inner interpreter's `switch` dispatch
  above is a per-instruction concern and unaffected by this, but the outer
  REPL loop calling it needs to run as one more `CTask`, `Yield()`-ing
  periodically during long-running Forth code per `docs/EXECUTION-LOOP.md`
  §5's own noted constraint. This is HAL/outer-loop-layer, not
  Forth-source-level (§4's boundary rule) — Rebel-Sim's outer loop is
  presumably a browser event/microtask loop and Rebel-Board's own
  bare-metal loop, neither needing `CScheduler`'s actual API, just the
  same cooperative-yield *behavior* so shared Forth source that yields
  during a long word doesn't assume Rebel-ROM's specific scheduler exists.

---

### 6. Dictionary Header Layout **[REVISED — bit-level specificity added]**

Every dictionary entry, identical layout across all languages:

* **Link Pointer (4 bytes):** offset to the previous dictionary word (0 = end of chain).
* **Flags + Length (1 byte):** `[NEW] explicit bit layout required:`
  * bit 7 — `IMMEDIATE`
  * bit 6 — `HIDDEN`
  * bit 5 — `COMPILE-ONLY` *(new, optional — flag if you don't need it yet)*
  * bits 4..0 — name length, **0–31 characters max**
* **Name (N bytes):** ASCII, padded with zero bytes so the Code Field begins on a 4-byte boundary.
* **Code Field / XT (4 bytes):** token ID — either a primitive (§5) or `DOCOL`.
* **Parameter Field (variable length):** list of token offsets (high-level words) or raw data (variables/constants).
* **[NEW]** If you want conventional Forth terminology in comments/docs for the agent's own sanity: Link Pointer = LFA, Flags+Length+Name = NFA, Code Field = CFA, Parameter Field = PFA.
* **[NEW] Alignment applies to the whole entry**, not just the name — the *next* entry's Link Pointer must also start 4-byte aligned, so padding accounts for the Code Field + at least one Parameter Field cell where relevant.
* **[CROSS-CHECK] Naming collision to avoid, not a real conflict:**
  `src/membank.h` already defines an unrelated 8-character `name` field on
  `CBank` (`BANK_NAME_LEN`, `docs/MEMORY-MODEL.md` §3.2 — what
  distinguishes multiple banks of the same tag, and doubles as a bank's
  on-disk 8.3 basename per `docs/STORAGE.md` §4a). That's a *bank's*
  identity, not a *dictionary word's* NFA name (this section's 0-31
  character field) — same small-fixed-size-string shape, completely
  different namespace and purpose. Worth a one-line callout in whatever
  doc/comment introduces the dictionary header in real code, so a future
  reader doesn't conflate "a bank named `00000042`" with "a Forth word
  named `DUP`."

---

### 7. The Hardware Abstraction Layer (HAL) **[v4 — resolved against shipped modules]**

* **Boolean convention:** all HAL functions returning a Forth-visible flag return **Forth boolean convention**: `TRUE = -1` (all bits set), `FALSE = 0` — not C-style `1`/`0`. This matters the moment a flag is combined with `AND`/`OR`/`INVERT` in Forth source.

* **`hal_emit`/`hal_plot`: the rule now matches `CScreenModule`'s shape,
  three-way, not two.** `CScreenModule` (`src/screenmodule.h`, Phase 5,
  done) already ships:
  * `hal_emit(char)` → `CScreenModule::Emit()` — classic stream `EMIT`:
    writes at the current cursor position, advances the cursor,
    write-through into the `CHAR` bank.
  * `hal_plot_char(col, row, char, ink, paper)` → `CScreenModule::
    WriteChar()` — positioned + colored write at *character-cell*
    granularity, also write-through into `CHAR`. (v2's `hal_plot(char, x,
    y, color)` maps to this, not to raw pixels.)
  * `hal_draw_*` (pixel/line/rect) → `CScreenModule::SetPixel`/`DrawLine`/
    `DrawRect`/`DrawRectOutline` — framebuffer-only, no `CHAR` interaction
    at all (`docs/SCREEN-MODULE.md` §1/§8's "one screen, not two modes").
  * **Porting to Rebel-Sim (TypeScript):** implement all three as
    canvas/DOM operations against the same `CHAR`-equivalent grid — a
    small in-memory character array separate from whatever pixel canvas
    API renders it, mirroring `CScreenModule`'s two-buffer structure
    rather than drawing character glyphs directly with no backing grid.
  * **Porting to Rebel-Board (RISC-V):** same three-way split against
    whatever display the board drives; if there's no display at all on a
    given build, `hal_emit`/`hal_plot_char` can no-op or route to a serial
    console, but the HAL call shape stays identical so shared Forth
    source doesn't need a variant.

* **`hal_key_pressed?()`/`hal_get_key()`: non-blocking is the rule, a
  blocking `KEY` is a layer built on top of it, not a HAL-level choice.**
  `CKeyboardModule::ReadEvent()` (`src/keyboardmodule.h`, Phase 8, done) is
  a **non-blocking** pop of a plain ring buffer. `hal_key_pressed?()` maps
  directly to "is the queue non-empty"; `hal_get_key()` maps to a
  non-blocking pop, returning a sentinel (or a companion boolean) when
  empty. A blocking Forth `KEY` word is layered in Phase 11 **on top of**
  this non-blocking primitive — on Rebel-ROM via Circle's
  `CSynchronizationEvent` (the Forth task waits on the event; the input
  task signals it when the queue goes non-empty), not by making
  `CKeyboardModule` itself blocking.
  * **Porting to Rebel-Sim (TypeScript):** the same shape — a non-blocking
    queue fed by `keydown`/`keyup` listeners, with a blocking `KEY` built
    as an `async`/`Promise`-based wait on "queue became non-empty," not by
    making the queue's own read blocking.
  * **Porting to Rebel-Board (RISC-V):** same shape — a non-blocking ring
    buffer fed by whatever input interrupt exists, with a blocking `KEY`
    built as a wait-for-flag/interrupt primitive appropriate to that
    board's own concurrency model (no Circle scheduler there, but the same
    "queue stays non-blocking, waiting is a layer above it" principle).

* **`hal_block_read`/`hal_block_write`: redefined against the shipped
  projects/carts storage model, not a raw numbered-block device.**
  `docs/STORAGE.md` (Phase 9, done, hardware-verified) deliberately avoids
  classic Forth block-device access in favor of **projects/carts**: named,
  typed asset files loaded whole into banks sized from the file's own size
  (`docs/STORAGE.md` §5). This is the resolved rule (superseding both v1's
  and `BRIEF.md`'s original raw-block framing): classic 1024-byte Forth
  screens stay a *source-editing* concept, backed by an ordinary bank
  (tag `SCRS`, new — add to `docs/MEMORY-MODEL.md` §3.3 when Phase 11
  starts) loaded/saved through the storage module's existing project-asset
  pipeline (`LoadAssetFile`/`SaveAsset`), not a second, separately-built
  raw block-device path. `hal_block_read(n)`/`hal_block_write(n)` become
  "read/write 1024 bytes at offset `n*1024` within the resident `SCRS`
  bank" — an ordinary bank access, not a device call — with persistence to
  disk happening at project open/close time, already built and
  byte-exact-verified by `CKernel::RunStorageSelfTest`.
  * **Porting to Rebel-Sim (TypeScript):** back the equivalent of
    `/PROJECTS/<name>/` with a virtual filesystem abstraction (IndexedDB,
    keyed by project name + typed asset name) mirroring the same
    directory/typed-extension shape `docs/STORAGE.md` §3/§4 describes —
    not a single flat blob per project — so a project genuinely round-trips
    between Rebel-Sim and Rebel-ROM asset-for-asset. `hal_block_read/write`
    operate on the in-memory `SCRS` bank exactly as on Rebel-ROM; only the
    load/save-to-disk step differs.
  * **Porting to Rebel-Board (RISC-V):** back it with the board's QSPI
    flash, organized the same way conceptually (named project/asset
    regions, not raw numbered sectors) — exact on-flash layout is
    unresolved (§9/§10, ties into that board's own boot-from-QSPI story),
    but the *addressing contract* — blocks are bank offsets, not device
    calls — carries over regardless of how the flash layout is finalized.

* **`hal_millis()`:** monotonic milliseconds, needed for any timing/delay
  word. On Rebel-ROM, wire it to Circle's `CTimer` (already a fixed
  `CKernel` member since Phase 7, `docs/EXECUTION-LOOP.md`) real
  millisecond-resolution query — not `CKernel::Run()`'s own coarse ~50Hz
  tick counter (`docs/EXECUTION-LOOP.md` §6), which is a frame cadence,
  not a general-purpose clock, and would under-resolve finer-grained
  timing. **Porting to Rebel-Sim:** `performance.now()`. **Porting to
  Rebel-Board:** RP2350's systick/timer peripheral.

* **[OPEN] `hal_error(code)` / exception model — genuinely open, no
  shipped precedent to defer to.** Nothing resembling `THROW`/`CATCH`/
  `ABORT` exists in the codebase yet. `SV_LAST_ERROR` (`CORE` sysvar
  group, `docs/SYSVARS.md` §8) and `TStorageSysVars::nLastError`
  (`docs/STORAGE.md` §8) are the only precedent so far, and both are
  today plain diagnostic scalars a C++ subsystem writes for serial
  logging, not a real Forth-level exception mechanism a word could
  `CATCH`. Design fresh in Phase 11, uniformly across targets: stack
  underflow/overflow, unknown token, divide-by-zero, and out-of-range
  memory access should all route through a single `ABORT`-style mechanism
  (traditional Forth `THROW`/`CATCH` codes are a reasonable base) rather
  than each target inventing its own crash behavior — Forth-source-level,
  not HAL-level, though it depends on HAL for how the error is finally
  *reported* (console vs. framebuffer vs. UART). Worth reusing the
  `LAST_ERROR` naming convention already established rather than
  inventing a second one.

---

### 7a. Channel Abstraction: Binding the Outer Loop to I/O **[NEW, v5 — pulled in from `CHANNELS-DESIGN.md`]**

* **The Rule:** the outer loop's *input* side — critically, blocking `KEY`
  — binds to a `Channel` reference rather than calling a specific I/O
  source directly. A `Channel` exposes exactly two operations: `has_data()`
  (poll) and `read_byte()` (non-blocking pop, returning the *translated*
  character). Full detail, concrete implementations, and the daemon design
  for a future remote channel live in `CHANNELS-DESIGN.md`; this section
  states the rule and how it resolves two things already anticipated
  elsewhere in this document.
* **This is what §5's outer-loop-as-task cross-check was pointing at.**
  §5 already established that the outer loop runs as a task that yields/
  blocks on the input queue "exactly like any cooperative task waiting on
  a synchronization primitive." `Channel::has_data()` is that queue.
  Blocking `KEY` (§7's own "layered on top of the non-blocking primitive"
  rule) is implemented as: suspend the task when `has_data()` is false,
  resume it once true. Whether "suspend" means a Circle `CSynchronizationEvent`
  (Rebel-ROM), a JS generator yield (Rebel-Sim), or a board-appropriate
  wait primitive (Rebel-Board) is a target-specific mechanism — the
  `Channel` interface and the suspend/resume rule are the shared part.
* **Scope: input only, not output.** `EMIT`/`TYPE` do **not** route
  through a `Channel` — they call the existing `hal_emit`/`hal_plot_char`
  screen HAL (§7) directly, unchanged. This was a real correction made
  while reconciling `CHANNELS-DESIGN.md`'s original draft, which had
  bundled both directions into one abstraction — see that document's §8
  for the full reasoning. Two sessions bound to different input channels
  (e.g. keyboard-bound and remote-bound) already share the one screen
  surface today, by construction, since screen was never channel-shaped
  to begin with.
* **Keyboard debounce is not a separate layer to wrap.** `CKeyboardModule`
  (Rebel-ROM) and `Keyboard` (Rebel-Sim) both do their own edge-detection
  inline; `KeyboardChannel` wraps their event read/poll directly, filtered
  to events carrying a non-zero translated char — an unmapped key has no
  byte-stream representation and stays invisible to `Channel`, same as it
  already is to `KEY`/`KEY?`.
* **This is the mechanism that makes a future remote/MCP input source a
  non-event.** A `RemoteChannel` (Rebel-ROM: a local daemon over a Unix
  domain socket; Rebel-Sim: a WebMCP-driven channel) implements the same
  two-method interface as `KeyboardChannel`. Binding it to the outer loop
  requires zero changes to the interpreter or to blocking `KEY` — that's
  the entire point of introducing `Channel` now rather than wiring
  `KEY`/`KEY?` directly to whichever input source happens to exist today.
* **Session model:** one outer-loop instance bound to one input channel.
  Multiple simultaneous sessions (e.g. keyboard-bound and remote-bound)
  share memory banks/sysvars/device state and the one screen surface;
  whether that ever needs explicit arbitration is an open question
  (`CHANNELS-DESIGN.md` §6) — not built now, revisit if a real need
  surfaces.
* **Status:** design-only on every target as of this writing. Rebel-ROM's
  Phase 8 shipped `CKeyboardModule` without ever wrapping it in a
  `Channel`; this becomes real starting with Phase 11 there and M7 on
  Rebel-Sim (`PLAN.md`).

---

### 8. State Portability Claim — Scope Clarification **[NEW]**

v1 states you can "pause the simulator, dump the ArrayBuffer to a file, and boot the exact same state on the physical Raspberry Pi." This is achievable, but only within a defined scope — worth stating precisely so it doesn't become a false promise:

* **What's portable:** the flat arena's contents (dictionary, stacks, sysvars, block buffers) — *given* §2 (endianness) and §3 (memory map) are followed exactly.
* **What's not automatically portable:** CPU register state, in-flight HAL calls, and anything sysvars intentionally hold as target-specific (§4) — a dump taken mid-execution on Rebel-Sim with `SCREEN-WIDTH` set to a browser canvas size will still say that when loaded on Rebel-ROM until the HAL's boot routine re-initializes target-specific sysvars.
* **Practical implication:** dumps are best taken/restored at a defined `QUIT`-loop boundary (interpreter idle, stacks in a known state), not from an arbitrary interrupted instant.
* **[v4] The portable region on Rebel-ROM is narrower than "the
  arena" — `SCRN` is excluded, as a matter of settled fact, not a
  hypothetical.** `docs/MEMORY-MODEL.md` §3.4: the `SCRN` bank
  (registered via `RegisterExternalBank()`) points at memory `C2DGraphics`
  allocates and owns with plain `new` on Circle's own heap — outside
  `CBankTable`'s bump-allocated arena entirely, `BankFlagExternal` marking
  it as such. `CBankTable::GetArenaBase()`/`GetArenaSize()` — the actual
  source of truth for "the arena" (`docs/MEMORY-MODEL.md` §3.6) — already
  don't include it. So "dump the arena" on Rebel-ROM means dumping the
  bump-allocated region only; any `EXTERNAL`-flagged bank (`SCRN` today,
  and any future one) is out of scope for the portability claim by
  construction, not by a rule this document needs to add — it falls out
  of the bank table's own bookkeeping. Rebel-Sim's canvas backing store is
  the direct analog and should be excluded from *its* dump the same way,
  for the same reason (target-specific presentation buffer, re-derived
  from `SCREEN-WIDTH`/`SCREEN-HEIGHT` sysvars + `CHAR` bank contents on
  restore, not itself part of portable state).
* **[v4] The portability claim gets a second asterisk once
  `docs/MEMORY-MODEL.md` §3.7's multi-arena model lands: "the arena"
  becomes "one of possibly several arenas."** A full-machine dump is no
  longer one flat blob — it's N arena-blobs (each still individually
  §8's original "dictionary, stacks, sysvars" shape, `SCRN`-equivalent
  excluded per the note above) plus which one was attached at dump time.
  Restoring a single arena in isolation (e.g. moving one project's state
  between Rebel-Sim and Rebel-ROM) stays exactly as portable as this
  section originally describes — the multi-arena wrinkle only matters for
  "dump the whole machine, every arena at once," which wasn't a v1
  requirement to begin with (`docs/MEMORY-MODEL.md` §3.7's v1 scope is
  pure-RAM, no persistence coupling yet).

---

### 9. Open Decisions for the Agent to Finalize

Everything below is **genuinely open** — no shipped Rebel-ROM code to
defer to, so these remain real decisions for whoever implements Phase 11
(and the equivalent work on Rebel-Sim/Rebel-Board) to make once, rather
than three times independently. Items that v3 raised here but v4 has
since settled (arena size/count, sysvar list, memory map, `hal_get_key()`
blocking behavior, `hal_block_read`/`write`'s storage model) have been
moved into their respective sections (§1/§3/§4/§7) as firm rules — see
§10 for the full list of what got resolved this pass and where.

1. Max dictionary name length — currently capped at 31 chars by the 5-bit
   length field (§6); fine unless you want longer names, in which case
   the flag byte needs to become 2 bytes.
2. Whether `COMPILE-ONLY` flag is needed now or can be added later without
   breaking the header layout (it can — bit 5 is reserved for it above).
3. `hal_error(code)`/exception model (§7) — no shipped precedent exists
   yet anywhere in the codebase to defer to.
4. Whether the bank table itself needs to move into arena-resident memory
   for Forth to walk it via raw address arithmetic (a primitive like a
   hypothetical `BANK@`), or whether API-mediated access (primitives that
   call into `CBankTable::FindBank`/`GetBank`) is sufficient —
   `docs/MEMORY-MODEL.md` §3.2 explicitly left this as a "revisit once
   Forth is actually reading/writing through it" question, and Phase 11
   is that revisit.
5. Rebel-Board's exact PSRAM chip/size and its QSPI-Flash-to-PSRAM boot
   copy step — a hardware decision for that board, not a software one
   (§1's/§3's porting notes).
6. Arena creation/lifecycle (`docs/MEMORY-MODEL.md` §5, new since §3.7):
   how many arenas exist at boot, whether creation is eager or lazy.
7. Attach/visit UX — what triggers switching the attached arena (dedicated
   Forth word vs. monitor-mode/command-palette action, `docs/MEMORY-
   MODEL.md` §5 / `docs/KEYBOARD.md`'s deferred UI-layer concerns).
8. Whether `KMAP` should stay host-level/shared (current lean, §3's
   per-arena-vs-shared table) or become per-arena if a real multi-keymap
   use case shows up.
9. Exact on-flash layout for Rebel-Board's `hal_block_read`/`write`
   backing (§7's porting note) — the addressing *contract* is settled,
   the concrete flash layout isn't.
10. **[v5]** Independent-session vs. shared-session arbitration once a
    second `Channel` binding actually exists on any target (§7a,
    `CHANNELS-DESIGN.md` §6) — deliberately not built ahead of a real need.
11. **[v5]** Remote channel transport: Unix domain socket vs. TCP
    (Rebel-ROM daemon) and the WebMCP transport shape (Rebel-Sim) — both
    deferred to when that channel is actually built (Rebel-ROM's daemon
    phase; Rebel-Sim's M8).

---

### 10. v4 resolution summary — what graduated from cross-check to rule

Rebel-ROM is the only one of the three targets that exists in code, and
per the project's direction it's the **reference implementation**. v3
marked disagreements between this spec and the shipped system as
**[CROSS-CHECK]** notes; v4 has folded the settled ones directly into
each section's rule text (search for **[v4]**) and added explicit
"Porting to Rebel-Sim"/"Porting to Rebel-Board" guidance under each. This
section is the index of what moved where — §9 above is what's left
genuinely open.

* **Cell/addressing model (§1):** firm rule — every address is a per-arena
  offset, never a raw pointer; a single arena is capped at
  `CMemoryModel::MaxArenaSize` (landed in code); using more RAM than one
  arena holds means more arenas, not a bigger cell.
* **Memory layout (§3):** firm rule — banks (tag/name/base/size class/
  flags) replace the original fixed-offset table; `docs/MEMORY-MODEL.md`
  §3.3's known-bank list (extended with `RSTK`/`DSTK`) *is* the memory
  map now. `DICT`/`RSTK`/`DSTK`/`CHAR`/`SYSV` are per-arena; `SCRN`/`KMAP`
  are shared singular resources.
* **Arena isolation (§1/§3/§8, `docs/MEMORY-MODEL.md` §3.7):** designed
  this pass, **not yet implemented** — multiple isolated arenas instead of
  one arena capped or stretched, exactly one attached (foreground) at a
  time in v1, every other arena's Forth task suspended. Multicore-per-
  arena and arena↔project storage convergence are explicitly deferred to
  v2+, not designed now.
* **Sysvars (§4):** firm rule — grouped, subsystem-owned regions
  (`docs/SYSVARS.md`'s shipped shape) replace the original flat table; a
  new `FORTH` group is required; `BLOCK-DEVICE` is read-only/diagnostic
  on Rebel-ROM specifically, not a runtime switch.
* **HAL (§7):** firm rules — `hal_emit`/`hal_plot_char`/`hal_draw_*` is a
  three-way split (not two), matching `CScreenModule`; `hal_get_key()` is
  non-blocking at the HAL level, with blocking `KEY` layered on top per
  target in Phase 11; `hal_block_read`/`write` are redefined as bank
  offsets backed by the projects/carts storage model, not a raw
  numbered-block device — the single biggest divergence from the
  original spec, now resolved in favor of the shipped `docs/STORAGE.md`
  design. `hal_error`/exception model remains genuinely open (§9).
* **State portability (§8):** firm rule — `SCRN`-equivalent (or its
  Rebel-Sim analog) is never part of the portable dump, by construction;
  once arenas land, portability is per-arena, not one flat machine-wide
  blob.
* **Channel abstraction (§7a, v5):** firm rule — `Channel` is input-only
  (`has_data()`/`read_byte()`), binds the outer loop's blocking `KEY` to
  whatever input source is currently attached; `EMIT`/`TYPE` stay on the
  existing §7 screen HAL, never channel-routed. Keyboard debounce lives
  inside the keyboard module itself, not a separate device-services stage
  — corrects `CHANNELS-DESIGN.md`'s original assumption. Session
  arbitration and remote-channel transport remain open (§9, items 10-11).
