# 03 — Sysvars Specification

**Version 1.0.** See `00-OVERVIEW.md` for normative-language definitions
and suite scope. Builds directly on `02-MEMORY-MODEL.md`'s `SYSV` bank
(tag `SYSV`, minimum size class — 4 KiB, §4.3 there) — this document is
purely about what lives *inside* that bank: its header, its grouped
layout, field encoding, naming, and the convention a target uses to
signal which optional fields it actually populates.

## 1. Purpose and scope

This specifies the sysvar mechanism that lets identical Forth source
run on every target while direct hardware/host access differs — the
single most load-bearing idea in this whole suite (`00-OVERVIEW.md`
§5's boundary rule: if a behavior can be expressed as "read a sysvar,
act the same way everywhere," it belongs in portable Forth source; if
it genuinely needs different code per target, it belongs in
`01-HAL.md`, never in a sysvar-driven branch).

It does not specify:

- The `SYSV` bank's own existence, size, or placement
  (`02-MEMORY-MODEL.md`).
- Full semantics of the `FORTH` group's fields (§7) beyond their
  existence and byte layout — what `HERE`/`LATEST`/`STATE`/etc.
  actually *do* is `04-FORTH-CORE.md`'s job.
- The numeric exception/error-code convention `01-HAL.md` §8 already
  deferred to `04-FORTH-CORE.md` — this document does not add a
  cross-subsystem error sysvar ahead of that.

## 2. General conventions

- **Sysvars are read and written exactly like any other memory** — a
  Forth `CONSTANT` resolving to a fixed absolute address, read with
  `@`, written with `!`. No dedicated sysvar-reading words exist or are
  needed; this is the entire mechanism, not a simplification of a
  richer one.
- **Every sysvar field occupies exactly one full cell (4 bytes),
  regardless of its logical value's natural width**, and is individually
  `@`/`!`-addressable. This is not a stylistic choice — it's the direct,
  necessary consequence of two already-settled rules taken together:
  `@`/`!` are cell-width operations (`02-MEMORY-MODEL.md` §2), and
  sysvars are accessed *exclusively* through `@`/`!` (§1 above, no
  sub-cell accessor path exists for them). A field logically needing
  only a byte or two (a modifier bitmask, a boolean flag) still gets a
  full cell; the unused high bytes are simply always zero. **A target
  overlaying a tightly packed, sub-cell-width C struct directly on this
  bank (byte-at-offset-1, halfword-at-offset-2, …) is not conformant**
  — such a layout makes some fields unreachable by a uniform `@`, which
  breaks the one thing this mechanism promises. This is a real,
  necessary correction for a target basing its sysvar struct directly
  on packed native-language field widths rather than this document.
- **Group and field *existence and order* are the cross-target
  contract; exact byte offsets follow mechanically from that** (§4).
  Two conformant targets agreeing on which fields exist, in what order,
  automatically agree on offsets too, since offset is a pure function
  of "everything before this field, in this group, packed one cell
  apiece" (§3) plus each group's own fixed base (§4).
- **Forth-visible sysvar constant names are flat identifiers with no
  group prefix** (`CURSOR-X`, `INK`, `MODIFIERS`, …) — the owning group
  is documented, never encoded in the name itself. (An earlier `SV_`-
  prefixed convention appears in some design notes but was never
  actually carried into shipped code on either known reference
  implementation; this specification settles on the flat, unprefixed
  form as canonical, matching what's actually shipped.) A direct
  consequence, stated as its own rule since it's easy to violate by
  accident: **a field name MUST be unique across the entire table, not
  just within its own group** — two different groups both wanting a
  field called `LAST-ERROR`, say, would collide in the flat dictionary
  namespace. §5's CORE group deliberately does *not* define its own
  general `LAST-ERROR` for exactly this reason (§8's `STORAGE` group
  already has one) — see §5.
- **Capability signaling is by field presence or absence, not by a
  populated-but-meaningless value.** Several fields throughout this
  document are marked OPTIONAL, gated on a target actually having the
  relevant capability (`01-HAL.md` §2.5) — visible cursor support,
  hot-pluggable storage, multiple attached input devices, and so on. A
  target lacking the capability **MUST** omit the field entirely (no
  `CONSTANT` for it exists in that target's dictionary at all) rather
  than defining it and always writing some fixed placeholder value.
  Testing for a capability from Forth source is therefore a
  dictionary-lookup question ("is this word defined on this build"),
  not a sysvar-value question — the actual mechanism a program uses to
  ask that (a `[DEFINED]`-style compile-time conditional, or
  equivalent) is `04-FORTH-CORE.md`'s job to define, referenced here
  only so the omission convention above has a stated way to be acted
  on.
- **Omitting an optional field MUST NOT shift any other field's
  offset.** Every field in a group has one fixed, universal
  group-relative offset, defined once by this document (or a later
  revision adding a new field) — whether a given target implements
  that field or not. A target that omits an optional field simply
  leaves that field's 4 bytes unused (still counted against the
  group's reserved size); it never repacks the fields it *does*
  implement into a shorter run starting at offset 0. This is what
  keeps "field order is the cross-target contract" (above) actually
  true in practice, even across targets implementing different subsets
  of a group's optional fields.

## 3. Header

Fixed 4 bytes at the very start of the `SYSV` bank (offset `0` within
it):

| Offset | Size | Field | Meaning |
|---|---|---|---|
| 0 | 1 byte | Magic 0 | `'S'` |
| 1 | 1 byte | Magic 1 | `'V'` |
| 2 | 1 byte | Version | `1` |
| 3 | 1 byte | Reserved | `0` |

Purely a sanity check for tooling and a human reading a raw memory
dump — confirming "this is a sysvars table, not garbage" — not runtime
migration logic; no version-mismatch behavior is specified. Group
offsets (§4) are **compile-time constants** baked into each target's
own build, not data stored anywhere in this header — an earlier design
note describing the header as containing a "table of groups" was never
actually built that way on any known reference implementation, and this
specification does not require it.

## 4. Groups

Sysvars are organized into fixed sub-regions by owning subsystem,
**not** one flat table — each group gets a fixed base offset and a
fixed reserved size, decided once, up front, even before the owning
subsystem's fields are fully known. This keeps two things independent
that would otherwise fight each other: a subsystem can add fields to
its own group during later development without shifting any other
group's addresses, and the *overall* table layout only changes (rarely)
when a whole new group is added, never when a field is added within an
existing one.

| Group | Base offset | Reserved size | §§ |
|---|---|---|---|
| `CORE` | `0x010` (16) | 48 bytes | §5 |
| `SCREEN` | `0x040` (64) | 64 bytes | §6 |
| `KEYBOARD` | `0x080` (128) | 64 bytes | §7 |
| `FONT` | `0x0C0` (192) | 64 bytes | §8 |
| `SPRITE` | `0x100` (256) | 64 bytes | §9 |
| `STORAGE` | `0x140` (320) | 64 bytes | §10 |
| `FORTH` | `0x180` (384) | 64 bytes | §11 |

These offsets **MUST** match exactly on every conformant target — this
is the one place in this document where a literal numeric value, not
just relative order, is part of the cross-target contract, since a
group's base offset isn't derivable from anything else (unlike a
field's offset within its own group, §2). `CORE`'s 48-byte reservation
is the one group that doesn't use the 64-byte default (§4.1) — fixed at
that size for continuity with already-shipped code on every known
reference implementation; every group after it uses the default.

A `SYSV` bank sized at 4 KiB (`02-MEMORY-MODEL.md` §4.3's minimum size class)
leaves `4096 − (16 + 48 + 64×6) = 3632` bytes genuinely unreserved past
`FORTH`'s end — real headroom for a future group, not slack to be
nervous about spending (§1's "about feel, not efficiency" framing
applies here too: even a generously padded field list measures in the
hundreds of bytes, nowhere close to exhausting a 4 KiB bank).

### 4.1 Adding a new group

A new subsystem group is appended **after** the last currently-reserved
group's own end, at its base offset rounded up to `align4` at minimum
(`02-MEMORY-MODEL.md` §2) — **RECOMMENDED** to the same 64-byte
granularity every existing group but `CORE` already uses, purely for
legibility (every group boundary lands on a round hex value). A new
group is never inserted between two existing ones, and never reuses
slack space presumed to belong to an adjacent group — that slack is
reserved *for that group*, not communal.

## 5. `CORE`

Base `0x010`, 48 bytes reserved. Always present — the one group with no
owning subsystem-existence precondition.

| Offset | Field | Required? | Meaning |
|---|---|---|---|
| 0 | `CURSOR-X` | **REQUIRED** | Text cursor column. Owned by the portable Screen Module (`01-HAL.md` §3.2), not bounds-checked on write. |
| 4 | `CURSOR-Y` | **REQUIRED** | Text cursor row. |
| 8 | `SCREEN-MODE` | OPTIONAL | Current display-mode index, for a target with more than one runtime-selectable display mode/resolution. A target with exactly one fixed mode (e.g. a canvas-backed target with no mode-switch mechanism) has no referent and **MUST** omit this field (§2's presence-signals-capability rule), not wire in a constant `0`. |
| 12 | `KEYMAP-ID` | OPTIONAL | Active keymap selector, for a target supporting more than one simultaneously-available keyboard layout. A target with exactly one built-in layout and no selection mechanism **MUST** omit this field. Distinct from the `KMAP` *bank* (`02-MEMORY-MODEL.md` §4.6, `01-HAL.md` §4.3) — this is which layout is active, not the translation table itself. |

**Deliberately not in this group:**

- **A color-depth or palette-bank field.** An earlier design note placed
  general-purpose `COLOR-DEPTH`/`PALETTE-BANK` fields in `CORE`, largely
  redundant with `SCREEN`'s own, more precisely scoped fields for the
  same concepts (which already have their own settled omission rule —
  `01-HAL.md` §3.6: a fixed-truecolor target has no referent for either
  and omits them). Carrying near-duplicate fields in two groups invites
  exactly the drift this whole grouped-layout mechanism exists to
  avoid; this specification resolves the duplication in `SCREEN`'s
  favor and does not define a `CORE`-level equivalent.

  [Update: `PALETTE-BASE` field added] `SCREEN`'s side of this
  resolution is no longer merely reserved — a target with a genuine
  indexed-color text mode now has a concrete field to populate:
  `PALETTE-BASE` (§6, `01-HAL.md` §3.6), an address, not an index,
  following the same "0/absent means disabled" convention as
  `FONT-BASE` (§8). This does not reopen the question this bullet
  settles: the field still lives in `SCREEN`, not `CORE`, and `CORE`
  still defines no palette-related field of its own.
- **A general `LAST-ERROR` field.** `STORAGE` already has one
  (`01-HAL.md` §6.6, §10 below) — a same-named `CORE`-level field would
  collide in the flat dictionary namespace (§2). Whether a *unified*,
  cross-subsystem error/exception convention (superseding today's
  per-subsystem fields entirely) is ever worth building is
  `04-FORTH-CORE.md`'s call, not resolved here — see §12.

## 6. `SCREEN`

Base `0x040`, 64 bytes reserved. Field meanings are `01-HAL.md` §3.6's
job; this table fixes the byte layout implementing that field list —
read the two together, not as duplicates of each other.

| Offset | Field | Required? |
|---|---|---|
| 0 | `SCREEN-WIDTH` | REQUIRED |
| 4 | `SCREEN-HEIGHT` | REQUIRED |
| 8 | `CHAR-CELL-W` | REQUIRED |
| 12 | `CHAR-CELL-H` | REQUIRED |
| 16 | `CHAR-COLS` | REQUIRED |
| 20 | `CHAR-ROWS` | REQUIRED |
| 24 | `INK` | REQUIRED |
| 28 | `PAPER` | REQUIRED |
| 32 | `CURSOR-VISIBLE` | OPTIONAL (`01-HAL.md` §3.5) |
| 36 | `PALETTE-BASE` | OPTIONAL (`01-HAL.md` §3.6) |

## 7. `KEYBOARD`

Base `0x080`, 64 bytes reserved. Field meanings: `01-HAL.md` §4.6.

| Offset | Field | Required? |
|---|---|---|
| 0 | `MODIFIERS` | REQUIRED |
| 4 | `KEYBOARD-COUNT` | OPTIONAL |

## 8. `FONT`

Base `0x0C0`, 64 bytes. [Revised M59] Populated for real once Rebel-Sim
actually had a Forth-addressable font bank to point at — field meanings:
`01-HAL.md` §3.7. Fully reserved before this (no fields defined; no
known target had one yet); still OPTIONAL group-wide, per §3.7 — a
target with no Forth-addressable font bank at all (Rebel-ROM's own font
system stays HAL-side compiled-in structs, `rebel-rom/docs/FONT-SYSTEM.md`
§6) simply doesn't populate this group.

| Offset | Field | Required? |
|---|---|---|
| 0 | `FONT-BASE` | REQUIRED if the target has a Forth-addressable font bank at all |

## 9. `SPRITE`

Base `0x100`, 64 bytes reserved. Fully reserved, same status and
reasoning as `FONT` (§8).

## 10. `STORAGE`

Base `0x140`, 64 bytes reserved. Field meanings: `01-HAL.md` §6.6.

| Offset | Field | Required? |
|---|---|---|
| 0 | `MOUNTED` | OPTIONAL |
| 4 | `LAST-ERROR` | OPTIONAL |
| 8 | `DEVICE-SEEN` | OPTIONAL |
| 12 | `PROJECT-NAME-0` | OPTIONAL |
| 16 | `PROJECT-NAME-1` | OPTIONAL |

Per `01-HAL.md` §6.6, these three are plain diagnostic scalars a
subsystem sets, not values using the HAL boolean convention
(`02-MEMORY-MODEL.md`/`01-HAL.md` §2.3) — nothing currently branches on
them in Forth control flow, so a target is free to treat `MOUNTED`/
`DEVICE-SEEN` as ordinary `0`/`1` C-style values rather than `TRUE`/
`FALSE`.

`PROJECT-NAME-0`/`PROJECT-NAME-1` together hold the currently open
project's name (`01-HAL.md` §6.1's `/PROJECTS/<name>/` directory
convention) — 8 ASCII bytes, NUL-padded, packed 4-per-cell, char 0 in
`PROJECT-NAME-0`'s low byte through char 7 in `PROJECT-NAME-1`'s high
byte (the same in-arena packing `02-MEMORY-MODEL.md` §4.2 already uses
for a bank descriptor's own `tag`/`name` fields — distinct from
Rebel-ROM's on-disk, space-padded FAT-8.3 convention, which is that
storage layer's own formatting concern, not this table's in-memory
representation). All-zero (both cells `0`) means no project is
currently open — the fresh-boot default. A target with no project
save/load mechanism at all **MUST** omit both fields entirely, per
§2's presence-signals-capability rule, rather than wiring in two
always-zero cells.

## 11. `FORTH`

Base `0x180`, 64 bytes reserved. No group at this offset exists yet on
every known reference implementation — none of the other six groups
owns general interpreter state, and a target whose Forth executor
doesn't exist yet naturally has nothing to put here. This
specification fixes the offset and field list now so that a target
building its executor for the first time and a target retrofitting one
onto an already-shipped memory model both land on the same layout,
rather than each picking independently. Full semantics belong to
`04-FORTH-CORE.md`; existence, order, and offset belong here:

| Offset | Field | One-line meaning |
|---|---|---|
| 0 | `SP0` | Data stack base address (constant once set). |
| 4 | `RP0` | Return stack base address (constant once set). |
| 8 | `HERE` | Dictionary next-free-space pointer, grows up within `DICT`. |
| 12 | `LATEST` | Most recently defined dictionary entry's address; `0` = empty dictionary. |
| 16 | `BASE` | Numeric input/output radix. |
| 20 | `STATE` | `0` = interpreting, nonzero (conventionally `-1`) = compiling. |
| 24 | `SP` | Live data stack pointer. |
| 28 | `RP` | Live return stack pointer. |

## 12. Explicitly out of scope / deferred

- **A generator tool keeping this document's layout, a target's C/C++
  struct, and a target's Forth constant table all in sync from one
  source of truth.** The real risk with a hand-maintained layout
  described independently in multiple places (this document, a
  target's native struct, a target's Forth constant definitions) is
  drift — they will eventually disagree if maintained by hand
  indefinitely. `FORTH-ARCHITECTURE.md`'s own governing note (referenced
  by `00-OVERVIEW.md`) already names this as a real gap: a
  single-source-of-truth artifact generating every target's output from
  one description. Not built anywhere yet — worth flagging clearly
  rather than quietly living with hand-sync risk indefinitely, but not
  this document's job to build.
- **A unified, cross-subsystem error/exception sysvar convention.**
  `STORAGE.LAST-ERROR` (§10) is the only populated per-subsystem error
  field today; whether it and any future subsystem-specific error
  fields should ever be superseded by one general convention tied to
  `04-FORTH-CORE.md`'s exception model, or stay genuinely per-subsystem
  indefinitely, is undecided — that document's call, not this one's
  (§5 already declines to add a `CORE`-level field preempting the
  answer).
- **Per-group reserved-size tuning beyond the defaults in §4.** 64
  bytes (48 for `CORE`) is a starting calibration, not a permanently
  fixed ceiling on every group forever — revisit a specific group's
  reservation only once its real field count is known to be too tight,
  not speculatively.

## 13. Conformance checklist

| Requirement | Section |
|---|---|
| Sysvars read/written exclusively via `@`/`!`, no dedicated accessor words | §2 |
| Every field is exactly one full cell, individually `@`/`!`-addressable — no packed sub-cell layout | §2 |
| Field names are flat, unprefixed, and unique across the *entire* table, not just their own group | §2 |
| An optional field a target doesn't implement is entirely omitted, never populated-but-meaningless | §2 |
| Omitting an optional field never shifts another field's offset | §2 |
| Group base offsets match §4's table exactly | §4 |
| `CORE` does not define `COLOR-DEPTH`/`PALETTE-BANK`/a general `LAST-ERROR`; the resolved indexed-color mechanism (`PALETTE-BASE`) lives in `SCREEN` instead | §5, §6 |
| `SCREEN`/`KEYBOARD`/`STORAGE` field layout matches §6/§7/§10 exactly, consistent with `01-HAL.md`'s meanings | §6, §7, §10 |
| `FORTH` group present at `0x180` with §11's field layout, once a target has a Forth executor at all | §11 |
