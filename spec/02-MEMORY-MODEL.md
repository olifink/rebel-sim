# 02 — Memory Model Specification

**Version 1.0.** See `00-OVERVIEW.md` for normative-language definitions,
suite scope, and the portable-logic/per-target-boundary distinction
`01-HAL.md` already relies on — this document has no HAL-boundary
content of its own (nothing here is per-target; the whole point of a
memory model is that it's identical everywhere), but keeps the same
conformance vocabulary.

## 1. Purpose and scope

This document specifies how Rebel addresses memory: the cell, the flat
per-arena address space, the bank system that organizes it, the
arena-resident bank table (`MMAP`) that makes that organization
inspectable, and the multi-arena isolation model. It is the foundation
`01-HAL.md` already leans on (bank size classes for storage payload
rounding, `MMAP`-first project restoration) and that `03-SYSVARS.md`/
`04-FORTH-CORE.md` build on (the `SYSV`/`DICT`/`RSTK`/`DSTK` banks,
dictionary entry alignment).

It does not specify:

- Sysvar field layout *within* the `SYSV` bank (`03-SYSVARS.md`).
- Dictionary entry layout *within* the `DICT` bank, or the token-threading
  dispatch mechanism (`04-FORTH-CORE.md`).
- Anything HAL-boundary-shaped — no function in this document is ever
  implemented differently per target. If it were, it would belong in
  `01-HAL.md` instead.

## 2. Cells

- **Exactly 32 bits (4 bytes), two's-complement, little-endian, on every
  target, no exceptions.** A cell's bit pattern is interpreted signed or
  unsigned depending on the operation reading it — never intrinsically
  one or the other. Arithmetic words (`+`, `-`, `*`, `<`) treat it
  signed; address/offset arithmetic and unsigned comparison words treat
  it unsigned.
- **Every multi-byte memory access MUST go through exactly one accessor
  module** (`readCell(offset)` / `writeCell(offset, value)`, and their
  unsigned variants) that hardcodes little-endian byte order in one
  place. This exists because the common host-language default is
  big-endian (e.g. `DataView.getInt32`/`setInt32` default to big-endian
  unless told otherwise) — scattering little-endian-flag arguments
  across call sites instead of centralizing them is exactly how this
  silently breaks: everything still looks correct running on one
  target, and is corrupt the moment a dumped arena is loaded on
  another. No code outside this one module MUST ever call a
  platform's native default-endian multi-byte accessor directly.
- Floating point is out of scope for this document and this cell. A
  target adding float support later MUST use a separate float stack
  (standard Forth practice), never pack it into the integer cell —
  `04-FORTH-CORE.md`'s concern if/when it happens, not decided here.
- **Cell alignment**: a 4-byte-aligned offset is `offset` such that
  `offset mod 4 == 0`. Rounding an arbitrary offset up to the next
  aligned boundary is `align4(offset) = (offset + 3) & ~3`. This
  primitive is used both for bank placement (§4.4) and for dictionary
  entry layout (`04-FORTH-CORE.md`) — defined once, here, since it's a
  property of the cell, not of either consumer.

## 3. The flat per-arena address space

- **One arena = one flat, linear byte-addressable space**, sized at
  creation from whatever memory the target actually has available (not
  a fixed, hardcoded capacity) and never virtualized or paged.
- `REBEL-ADDR 0` is the base of *the arena a given Forth task belongs
  to* (§6) — **never** physical/host address 0, and never a
  process-wide "the" arena once more than one exists.
- **Every Forth-visible address is an offset from its own arena's
  base — never a raw host pointer.** The conversion `real_address =
  arena_base + offset` happens exactly once, at whatever boundary a
  target's `@`/`!`-equivalent primitives (and anything else accepting a
  "memory address" parameter) dispatch through. A raw host pointer
  **MUST NOT** ever become a Forth cell value, on any target — this
  holds even on a 64-bit host, where the temptation to shortcut through
  a native pointer is strongest. This is what makes a fixed 32-bit cell
  work cleanly regardless of a target's native word size or address
  space.
- **Fetch/store operations are unbounded: full read/write, no
  bounds-checking safety net.** This is deliberate, not a missing
  feature — Forth code is meant to feel like it genuinely owns real,
  physically-addressable memory. A stray out-of-range write can corrupt
  the arena's own dictionary, stacks, or screen state; it **MUST NOT**
  be able to reach anything outside the arena (a target's own runtime,
  OS, or hypervisor state) — that isolation is the one safety boundary
  this model does enforce, and it's enforced by construction (the
  arena is a single, separately-owned allocation, never overlapping
  anything else), not by a runtime check on every access.
- **A single arena MUST NOT expose an addressable region reaching or
  exceeding 2^32 bytes**, even on a target technically capable of
  allocating more (e.g. a 64-bit host where the backing allocation
  itself isn't limited to 4 GiB). This is the direct consequence of
  §2's fixed 32-bit offset: exceeding it breaks addressing, silently,
  the moment an offset needs the 33rd bit. A target with more usable
  memory than one arena can address claims **more arenas** (§6), never
  a wider cell or a paged/windowed single space.

## 4. Banks

### 4.1 What a bank is

A **bank** is a fixed-size, named region within an arena — the unit of
organization for anything structured (the dictionary, both stacks,
sysvars, the character grid, sprite/cart data, scratch space) and the
unit any future bank-swap-to-storage mechanism would operate on. Banks
are handed out from the arena in creation order and **never relocated
once created** — a bank's address is fixed for its entire lifetime.
This is deliberate: it's what keeps a hypothetical future "swap this
bank's contents out to storage and back" operation simple (overwrite an
address range from a storage region — no relocation, no pointer-fixing,
no compaction ever needed).

### 4.2 Bank descriptor

Every bank, wherever its table lives (§5), is described by exactly
these fields:

| Field | Size | Meaning |
|---|---|---|
| `tag` | 4 bytes, ASCII, NUL-padded | What *kind* of bank this is (`SYSV`, `DICT`, `CHAR`, …). Tags are **expected to repeat** — multiple simultaneously-resident banks can share a tag (e.g. several `DATA`-tagged project assets). |
| `name` | 8 bytes, ASCII, NUL-padded | Which *specific* bank this is — see §4.7. **MUST be unique** across every bank on every arena (§6), not just within one arena or one tag. |
| `base` | 1 cell, unsigned | Offset from the owning arena's base (§3). Fixed for the bank's lifetime. |
| `size` | 1 cell, unsigned | Byte count. Exactly one size class (§4.3) for a carved bank; whatever the owning subsystem allocated for an external bank (§4.5). |
| `flags` | 1 cell, bitmask | See table below. |

Flag bits (bit-for-bit stable across every conformant target — a target
**MUST NOT** renumber these):

| Bit | Name | Meaning |
|---|---|---|
| 0 | `RESIDENT` | Default state for any normal bank: present and backed by real memory. |
| 1 | `EXTERNAL` | Base address is not part of this arena's own allocation (§4.5) — e.g. a singular framebuffer some other subsystem owns and sizes. |
| 2 | `SWAPPABLE` | Reserved, inert. No target has bank-swap-to-storage logic yet (§7). |
| 3 | `DIRTY` | Reserved, inert. Paired with `SWAPPABLE` for a future "only write back what actually changed" mechanism — not built anywhere yet. |
| 4 | `ACTIVE` | This slot in the bank table currently holds a real bank (as opposed to being available for the next allocation). Required — see §5's rationale for why occupancy is tracked this way rather than via a separately cached cursor. |

### 4.3 Standard size classes

Every **carved** bank (§4.4 — i.e. every bank that isn't external, §4.5,
or the bank table itself, §5) **MUST** occupy exactly one of six fixed
size classes, each 4× the previous:

| Class | Size | Typical use |
|---|---|---|
| XS | 4 KiB | Sysvars, small control/state tables, small per-arena scratch regions |
| S | 16 KiB | Small sprite sets, glyph subsets, dictionary chunks |
| M | 64 KiB | Font banks, working dictionary space |
| L | 256 KiB | Screen/display buffers at typical low-resolution modes |
| XL | 1 MiB | Larger screen modes, sprite sheets, cart payloads |
| XXL | 4 MiB | Large carts, asset-heavy banks |

**There is no path to an arbitrary exact byte size for a carved bank.**
A subsystem whose natural content is smaller than a class (a character
grid a few hundred bytes short of a page, a small scratch buffer)
**MUST** still round up and take the whole class, leaving the remainder
of that class simply unused within the bank — this keeps the model
uniform and every bank's footprint predictable from its class alone,
and the wasted space is intentionally not worth optimizing away (§1's
"about feel, not efficiency" framing: Pi-class and RP2350-class targets
both have orders of magnitude more memory than this costs). A subsystem
needing more space than the largest single class (`XXL`) takes
**multiple banks**, never a special oversized allocation — there is no
seventh class and no escape hatch.

This rule applies uniformly to every source of a bank-size request,
including a Forth-level or host-level dynamic bank-creation
call (`04-FORTH-CORE.md`'s `CREATE-BANK`-equivalent primitive, if a
target implements one): such a call takes a *requested* byte count and
**MUST** round it up to the smallest class that fits before carving
anything, exactly like loading an oversized project asset already does
(`01-HAL.md` §6.3). It **MUST NOT** honor an arbitrary caller-supplied
byte count as the bank's actual size.

### 4.4 Allocation: a 4 KiB-aligned bump allocator

Carved banks are handed out by a simple bump allocator, run once per
bank creation:

1. Compute `candidate_base` = the current free-cursor position (the end
   of the highest-addressed active bank so far; `0` for the very first
   bank).
2. **Round `candidate_base` up to the next 4 KiB boundary**:
   `aligned_base = (candidate_base + 4095) & ~4095`.
3. Place the new bank at `aligned_base`; the free cursor becomes
   `aligned_base + size`.

4 KiB is a deliberate nod to common page granularity — no MMU paging is
implied or required by this model, but keeping every bank boundary
aligned to it costs nothing (every size class in §4.3 is itself already
a multiple of 4 KiB, so **only the very first placement after a
non-class-sized item, if any, ever needs real rounding** — every
placement after that lands pre-aligned automatically) and keeps the
door open if paging ever becomes useful on some future target.

**A bank's address is fixed once created; there is no compaction and no
reordering, ever** (§7 — no removal mechanism exists at all). Whatever
the arena's free cursor hasn't reached yet stays genuinely unallocated —
not an implicit scratch bank, not owned by anything — available to a
future `CreateBank`-equivalent call.

**Absolute-address alignment, not just offset alignment.** A target
whose arena is a real allocation from a host allocator (as opposed to
Rebel-Sim's browser-hosted case, where the arena's absolute address is
never observable) **MUST** ensure the arena's own absolute base address
is itself rounded up to the allocation granularity *before* any
offset-based bank alignment math runs. Offset `0` is trivially "aligned"
regardless of whether the arena's real, absolute starting address
happens to be — computing every bank's alignment purely against the
zero-based offset silently produces a first bank whose *absolute*
address isn't actually aligned at all, if the raw allocation the arena
came from wasn't already page-aligned. This is not a hypothetical: it
is exactly the failure mode a hardware-verified reference implementation
hit and fixed by rounding the raw allocation pointer up first (shrinking
the arena's own usable size by whatever got skipped) before doing any
offset-relative bank placement.

### 4.5 External (unmanaged) banks

Some banks describe memory the arena's own allocator neither owns nor
sizes — most notably a singular hardware or host-owned framebuffer
(`SCRN`). These are *registered* rather than *carved*:

- Recorded in the bank table with the same descriptor shape as any
  other bank (tag, name, base, size, `EXTERNAL` flag set) — so any
  generic "look up a bank" mechanism works uniformly regardless of
  whether a given bank is arena-carved or externally-owned.
- `base`/`size` come from whatever actually owns and sized that memory,
  **not** from §4.3's size-class ladder — there is nothing to round,
  since nothing was carved.
- Registering an external bank **MUST NOT** advance the arena's own
  free cursor (§4.4) — it doesn't consume any of the arena's own
  allocation.
- A target is not required to give every externally-owned resource a
  bank-table entry at all. If Forth-level addressing of that resource
  was never the point — e.g. a target where the framebuffer is reached
  exclusively through the Screen HAL (`01-HAL.md` §3) and never through
  `@`/`!` — omitting its bank-table entry entirely is conformant. Only
  register an external bank when something genuinely needs to address
  it via the bank-table/`BANK@` mechanism.

### 4.6 Known bank tags

These are the tags this suite currently names. This list grows as later
documents in the suite (or a target's own real, load-bearing need) add
to it — it is not exhaustive by design (§7).

| Tag | Purpose | Per-arena or shared |
|---|---|---|
| `SYSV` | Sysvars (`03-SYSVARS.md`) | Per-arena |
| `DICT` | Dictionary / user program space (`04-FORTH-CORE.md`) | Per-arena |
| `RSTK` | Return stack, grows down | Per-arena |
| `DSTK` | Data stack, grows down | Per-arena |
| `CHAR` | Character-code grid, write-through into the display surface (`01-HAL.md` §3) | Per-arena |
| `TIB` | Terminal Input Buffer — resident scratch a line-input word reads a line into | Per-arena |
| `PAD` | Scratch text region for transient string handling | Per-arena |
| `SPRT` | Sprite/tile data | Per-arena |
| `CART` | Cart-loaded code landing area | Per-arena |
| `DATA` | General-purpose scratch | Per-arena |
| `MMAP` | The arena's own bank table (§5) | Per-arena (each arena owns and describes only its own banks) |
| `SCRN` | Display framebuffer | **Shared** — one physical/simulated screen, never duplicated |
| `KMAP` | Active keymap translation table (`01-HAL.md` §4) | **Shared** — host/hardware keyboard-layout configuration, not per-program state |

**Per-arena** means: each isolated arena that creates one gets its own,
private copy — every running Forth machine has its own dictionary and
stacks, not a shared instance. **Shared** means: exactly one instance
exists regardless of how many arenas exist, driven by whichever arena
is currently attached (§6). Stack growth direction and overflow
handling **MUST** be identical across targets: down-growing within each
stack's own bank, bounds-checked against that bank's own recorded size.

`SCRN` and `KMAP` staying shared rather than duplicated is a deliberate,
narrow exception, not a precedent for treating other subsystems loosely
— see §6 for why exactly these two, and no others, stay singular.

### 4.7 Naming: `tag` vs. `name`

- `tag` says *what kind* of bank this is — reused across many banks
  (every `DATA`-tagged asset shares the tag `DATA`).
- `name` says *which specific one* — what makes multiple
  simultaneously-resident banks of the same tag distinguishable, and
  (per `01-HAL.md` §6.3) doubles directly as a saved asset file's
  on-disk basename. **Uniqueness is enforced on `name`, not `tag`** — a
  lookup-by-tag-alone (e.g. `BANK@`, `04-FORTH-CORE.md`) means "the
  first bank of this type," not "the" one, once more than one shares a
  tag; a lookup by name is the real uniqueness-backed identity lookup.
- **A bank created without an explicit name gets one automatically**: an
  8-digit, zero-padded decimal serial number (e.g. `00000042`), drawn
  from a single monotonically increasing counter. This counter **MUST**
  be shared across every path that can create an anonymous bank — a
  host-side initialization routine and a Forth-level `CREATE-BANK`-
  equivalent primitive both draw from the *same* counter (stored in
  `MMAP`'s own header, §5, not duplicated anywhere else) specifically so
  two independently-created anonymous banks can never collide on name
  regardless of which path created them.
- A name **MAY** be patched later, either at creation time (supplying a
  real name up front) or afterward by writing directly into the bank
  table's `name` field — there is no special rename operation; it's an
  ordinary write to a known structure, consistent with §3's "no
  special memory kind, everything is reachable by address" philosophy.
- **Names MUST be unique across every arena, not namespaced per arena**
  (§6) — one flat namespace, maintained above every individual arena's
  own bank table, so the "bank name = saved asset file basename"
  convention (`01-HAL.md` §6.3) never needs arena-scoping to stay
  collision-free.

## 5. `MMAP`: the arena-resident bank table

Each arena's own bank table is itself a bank — tag `MMAP`, **always the
first bank created in that arena** (base `0`, ahead of every other bank
in that arena). This is a deliberate, load-bearing design choice, not
an implementation detail: keeping the table itself inside
Forth-addressable arena memory, rather than as a separate host-side
structure outside the arena entirely, is what makes two things possible
that a host-side-only table cannot support:

1. **`BANK@`/`CREATE-BANK`-style Forth primitives** (`04-FORTH-CORE.md`)
   can walk and extend the table via ordinary raw address arithmetic —
   the same `@`/`!` mechanism that reads any other memory — rather than
   requiring a separate host-API surface just for bank introspection.
2. **The table round-trips as part of the arena's own state.** A target
   persisting a project's full session state (`01-HAL.md` §6.3.1) can
   save/restore `MMAP` through the exact same asset-file mechanism as
   any other bank, and use it to reconstruct the *exact* original bank
   layout — bases, size classes, slot order — on load, rather than
   re-deriving a plausible-looking one from whatever content files
   happen to be present.

A target whose current bank table lives outside the arena as a
host-side structure (a plain fixed array in the implementation
language, say) is **not conformant** with this version of the
specification and needs updating — the `ACTIVE` flag bit (§4.2) exists
specifically to make occupancy well-defined for an arena-resident table
scanned fresh on every query, with no separately cached cursor that
could drift from the table's actual contents.

### 5.1 Header

Fixed 16 bytes at the start of the `MMAP` bank (i.e. at the owning
arena's offset `0`):

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0 | 1 byte | Magic 0 | `'M'` |
| 1 | 1 byte | Magic 1 | `'M'` |
| 2 | 1 byte | Version | `1` |
| 3 | 1 byte | Reserved | `0` |
| 4 | 1 cell | `NEXT-BANK` | The shared auto-naming counter (§4.7). Reading it **MUST** return the current value and then increment it (pre-increment-on-read semantics — matches a plain `counter++` read). |
| 8 | 1 cell | `ARENA-SIZE` | This arena's total byte size, queryable directly rather than requiring a separate host call. |
| 12 | 1 cell | `ARENA-ID` | Reserved, always `0` in this version — future multi-arena bookkeeping (§6), no consumer yet. |

### 5.2 Slot table

Immediately following the header: a fixed-capacity array of bank
descriptor slots (§4.2's shape exactly — `tag`(4) + `name`(8) +
`base`(1 cell) + `size`(1 cell) + `flags`(1 cell) = 24 bytes per slot).
Slot capacity (`MAX_SLOTS`) is a target-build-time constant — **not**
runtime-configurable, since `MMAP`'s own total size (below) is a fixed
function of it. **RECOMMENDED default: 64 slots** — cheap regardless of
count (a plain fixed layout, not itself arena-carved *content*), and
what both known reference implementations already use; a target MAY
choose a different capacity, but it becomes part of that target's
build, not something a saved project can assume matches across targets
with different capacities.

- **Occupancy** is purely the `ACTIVE` bit (§4.2) on each slot — an
  active slot is a real, in-use bank; an inactive one is available for
  the next allocation. Nothing else is cached: which slot is free and
  where the arena's free cursor currently sits are both **derived by
  scanning every slot**, every time (checking each one's `ACTIVE` bit
  and taking `max(base + size)` over the active ones) — not tracked in
  a separate cursor variable that could fall out of sync with the
  table's actual contents.
- **Slot order matches creation order**, always — allocation (§4.4)
  always picks the lowest-indexed inactive slot, and (§7) nothing ever
  deactivates a real bank in this version, so there is no reordering to
  account for.
- `tag`/`name` are stored NUL-padded within their fixed field width, not
  space-padded — space-padding (if a target's storage layer needs it for
  an on-disk 8.3-style filename convention) is that layer's own
  formatting concern (`01-HAL.md` §6), not this table's in-memory
  representation.

### 5.3 `MMAP`'s own size — the one exception to §4.3

`MMAP`'s total byte size is `16 + MAX_SLOTS × 24` — a fixed function of
a build-time constant, not describable "content" that could be rounded
into one of §4.3's six classes. It is the **one** carved bank
exempted from the size-class-only rule, and the exemption is narrow and
specific to this structural reason — it is not a precedent for giving
any other bank (§4.6's list, or any future one) an arbitrary exact
size. Every other carved bank still must obey §4.3 without exception.
`MMAP`'s placement still goes through the ordinary 4 KiB-aligned
allocator (§4.4) like any other bank — it is simply always the first
one, so its own placement never needs rounding (offset `0` is trivially
aligned), and it's what makes the *next* bank's placement the one that
does.

### 5.4 Worked example

The bank sequence below (`MMAP` implicitly first, then `SYSV`, `DSTK`,
`RSTK`, `DICT`, `CHAR`, `KMAP`, `TIB`, `PAD`, all XS-class except `DICT`
at M-class) is exactly the kind of arena an implementation this suite
governs produces, computed per §4.3/§4.4/§5.3 with `MAX_SLOTS = 64`
(`MMAP` size = `16 + 64×24 = 1552` bytes):

| Bank | Base | Size | Class |
|---|---|---|---|
| `MMAP` | `0x00000` (0) | 1552 | — (§5.3) |
| `SYSV` | `0x01000` (4096) | 4096 | XS |
| `DSTK` | `0x02000` (8192) | 4096 | XS |
| `RSTK` | `0x03000` (12288) | 4096 | XS |
| `DICT` | `0x04000` (16384) | 65536 | M |
| `CHAR` | `0x14000` (81920) | 4096 | XS |
| `KMAP` | `0x15000` (86016) | 4096 | XS |
| `TIB` | `0x16000` (90112) | 4096 | XS |
| `PAD` | `0x17000` (94208) | 4096 | XS |

Note every base after `SYSV` lands pre-aligned with no further rounding
needed — the direct consequence of every size class already being a
4 KiB multiple (§4.4). Only the very first placement (`SYSV`, right
after `MMAP`'s non-class-sized 1552 bytes) actually needs the round-up
to do anything. A conformant target's own allocator, run against the
same bank sequence with the same `MAX_SLOTS`, **MUST** reproduce this
table exactly.

## 6. Multi-arena isolation

**The problem this solves:** the 32-bit cell (§2) caps any single
arena's addressable region at just under 4 GiB (§3). A target with more
physical/available memory than that doesn't get a bigger cell (breaks
every other target sharing this cell width) or a paged/windowed single
address space (every `@`/`!` would need to consult a mutable "which
memory is windowed in right now" register — real per-access overhead,
and doesn't match how this is actually used). Instead: **more than one
arena, each independently capped, each a complete, isolated Rebel
machine** — closer to running several small independent computers on
one host than to giving one computer more memory than it can address.

### 6.1 What "isolated" means

Each arena gets its own bank table (§5) and its own private copies of
every **per-arena** bank (§4.6) — its own `SYSV`, so `HERE`/`LATEST`/
stack pointers/etc. are private per arena, not shared registers; its
own `DICT`, `RSTK`, `DSTK`, `CHAR`, and the rest. A Forth task running
inside one arena is unaware any other arena exists at all.

**Two distinct "current arena" concepts — easy to conflate, kept
deliberately separate:**

- *Which arena a running Forth task's memory belongs to* — decided
  once, when that task is created, and **fixed for its whole lifetime**.
  There is no mutable "which arena am I targeting" register consulted
  per `@`/`!` access; a task simply holds a reference to its own
  arena's bank table, and every address it resolves goes through that
  one. `REBEL-ADDR 0` (§3) always means "offset 0 of *my* arena."
- *Which arena the human operator is currently attached to* — the
  **foreground** arena. This is the only thing that's actually
  runtime-switchable, and switching it **MUST NOT** change which arena
  any already-running task's memory belongs to.

### 6.2 What stays shared, not duplicated per arena

- **Primitive words** — compiled dispatch code, not arena memory. Zero
  per-arena cost regardless of arena count.
- **`KMAP`** — a host/hardware configuration concern (which physical
  keyboard layout is active), not per-program state, so it stays one
  shared, host-level bank. (Open: whether a real future case for
  per-arena keymaps ever emerges — §7.)
- **`SCRN`** — inherently singular hardware/host resource (one screen).
  Never duplicated; whichever arena is attached gets its contents
  rendered from it (via that arena's own `CHAR`, below).
- **Any singular input/storage controller** — arenas don't each get
  their own; only the attached arena receives routed input.

**Why `CHAR` specifically is duplicated per arena even though it's
"just" screen state, while `SCRN` itself isn't:** `CHAR` is small
(kilobytes) and per-arena, so switching attachment away from an arena
and back means that arena's screen reads exactly as it was left —
attaching an arena means repointing the one shared screen surface at
*that* arena's own `CHAR` bank and redrawing from it, not clearing and
starting over. This is the actual "feels like visiting a separate
machine" property the isolation model exists to deliver.

### 6.3 Capacity and sizing

- **`MaxArenas`**: RECOMMENDED default 8 — a small, fixed-capacity table
  of arena slots, cheap regardless of count. A target MAY choose
  differently; this is target-build discretion, not a cross-target
  contract the way `MMAP`'s slot layout (§5) is, since arenas (unlike
  banks within one arena) never need to round-trip their *count*
  between targets.
- **`MinArenaSize`**: RECOMMENDED a sanity floor (e.g. 64 KiB) below
  which a freshly claimed arena is rejected as pointless rather than
  kept — not a capacity-planning number, just a floor beneath which
  nothing useful fits.
- **`MaxArenaSize`**: **MUST NOT** allow any single arena to reach or
  exceed 2^32 bytes (§3's cell-width ceiling, restated at the
  multi-arena level since it's what makes needing more than one arena
  possible in the first place). A target MAY set a stricter, rounder
  ceiling below that for its own bookkeeping convenience — the exact
  value is target discretion, not a cross-target contract.
- **How much of a target's actual available memory a single arena
  claims** is entirely target discretion: a target reserves whatever
  headroom its own runtime/OS/bootloader needs (a bare-metal target
  with no separate runtime may reserve nothing at all) before sizing
  the arena from the rest. This document does not mandate a specific
  reservation size.
- **Lazy creation is RECOMMENDED**: claim and attach arena `0` at boot;
  create additional arenas only when something actually asks for one
  (an attach/visit action, §6.5), not speculatively.

### 6.4 Naming

An arena created without an explicit name gets one automatically:
`ARENAnn` (zero-padded index). Unlike bank auto-naming (§4.7), this
doesn't need a separate persistent counter — arenas are never removed
or reordered in this version (§7), so an arena's array index is already
a stable-enough identity on its own.

### 6.5 v1 scope, deliberately narrow

- **Exactly one arena is attached (foreground) at a time.** Attaching
  means: repoint the shared screen surface at that arena's `CHAR` bank
  and redraw.
- **Every other arena's Forth task is suspended, not concurrently
  scheduled.** No real multitasking between arenas in this version —
  see §7 for what real concurrency would need and why it's deferred.
- **Bank names stay globally unique across every arena** (§4.7) — one
  flat namespace above every individual arena's own bank table.
- **What actually triggers switching the attached arena** (a dedicated
  Forth word, a monitor-mode/command-palette-style action) is
  explicitly undecided — §7.

## 7. Explicitly out of scope / deferred

Named here so an implementer knows these are deliberate omissions, not
oversights. Do not design ahead of these — extend this document when
one becomes real and load-bearing somewhere, not before:

- **Bank swapping** (moving a bank's contents to/from storage and back
  at runtime, beyond the project-open/close-time load/save
  `01-HAL.md` §6 already covers). The `SWAPPABLE`/`DIRTY` flags exist in
  the descriptor (§4.2) but are inert placeholders.
- **Bank removal.** No mechanism exists to deactivate or reclaim a
  bank's slot once created — banks live for their arena's whole
  lifetime. A consequence worth knowing about: re-opening a project
  whose banks are already resident (e.g. re-mounting the same storage
  without an intervening reset) is a name-collision no-op against the
  already-resident bank, not a fresh reload — harmless (the resident
  data is already correct), but not the same as an actual reload.
- **Bounds checking / memory protection.** Not planned at all within an
  arena — intentional (§3), not a gap.
- **Dynamic bank allocation beyond a single `CREATE-BANK`-equivalent
  primitive.** No richer resize/reallocate/free-and-reclaim model is
  specified.
- **Concurrent/multicore arena execution.** This version runs exactly
  one arena's Forth task at a time (attached, foreground); every other
  arena is suspended. Real concurrent execution across cores is a
  plausible future direction, not designed here — arbitrating singular
  shared resources (the screen, input, storage) across simultaneously-
  running arenas is a materially harder problem than anything this
  version takes on.
- **Cross-arena communication / shared user-created banks.** The
  isolation model (§6) assumes arenas are mutually unaware by default.
  Whether a deliberate, explicit cross-arena channel is ever worth
  adding is untouched — no real concurrent-arena use case exists yet to
  design it against.
- **Attach/visit UX.** What actually triggers switching the attached
  arena — a dedicated Forth word, a monitor-mode/command-palette
  action — is open on every target. Whatever mechanism a target
  prototypes for this today should be treated as a placeholder demo
  binding, not a real decision binding this specification.
- **Whether `KMAP` should ever become per-arena.** The current, settled
  position (§6.2) is shared/host-level. Revisit only if a real target
  surfaces a genuine case for different arenas wanting different
  keyboard layouts simultaneously resident — not designed ahead of
  that need.

## 8. Conformance checklist

| Requirement | Section |
|---|---|
| Cell is exactly 32-bit, little-endian, signed/unsigned by operation, through one accessor module | §2 |
| Addresses are per-arena offsets; a raw host pointer never becomes a Forth cell value | §3 |
| A single arena never addresses ≥ 2^32 bytes | §3, §6.3 |
| Every carved bank occupies exactly one size class (XS–XXL); no arbitrary exact sizes, no exceptions beyond `MMAP` itself | §4.3, §5.3 |
| Bump allocator 4 KiB-aligns every carved bank's base, including absolute-address alignment if the arena's own allocation might not already be page-aligned | §4.4 |
| External banks are registered, don't consume the free cursor, and don't need a size class | §4.5 |
| Bank table (`MMAP`) is arena-resident, not a host-side-only structure | §5 |
| Bank `name` uniqueness is global across every arena, not per-arena | §4.7, §6.5 |
| Auto-generated bank names share one counter (`MMAP`'s own header), regardless of creation path | §4.7, §5.1 |
| A Forth task is bound to exactly one arena for its whole lifetime; only the *attached* arena is runtime-switchable | §6.1 |
| `SCRN`/`KMAP` stay singular/shared; every other known bank tag is per-arena | §4.6, §6.2 |
