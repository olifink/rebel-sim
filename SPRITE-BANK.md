# SPRITE-BANK.md

## Purpose

Defines the on-disk/in-memory format for sprite banks: shared resources
containing a palette and a set of fixed-content bitmap entries. A single
format serves two consumers that differ only in how they are blitted:

- **Sprites** — freely positioned, arbitrary pixel coordinates. Used for
  game objects.
- **Tiles** — positioned on the 8x8 character grid, occupying the same
  coordinate space as text output. Used for UI elements and decoration
  rendered alongside text.

A bank does not know which entries will be used as sprites versus tiles.
That distinction is made by the caller at blit time, not encoded in the
bank.

## Relationship to 02-MEMORY-MODEL.md / 01-HAL.md

This is not a new system dependency — it names the payload format for
an existing bank tag. `02-MEMORY-MODEL.md` §4.6 already defines `SPRT`
("Sprite/tile data") as a per-arena bank tag, and `01-HAL.md` §6.3
already maps it to the `.SPR` project-asset extension with the standard
6-byte `'R','A'` + 4-char-tag header preceding the payload in every
saved file. Every "Offset" below is relative to the bank's own base (or
equivalently, byte 6 of a persisted `.SPR` file, per `01-HAL.md` §6.3) —
not the file's byte 0.

`02-MEMORY-MODEL.md` §4.7 lets multiple banks share one tag,
distinguished by `name`, not `tag` — so a project with several sprite
sheets resident at once (a UI tileset and a game-object spritesheet, say)
is several `SPRT`-tagged banks with different names, each independently
loadable/activatable, not one bank multiplexing several logical sheets.
`BUILD-BANK` (below) operates on one such bank by name, same as
`BANK@`/`BANK-SIZE` (`04-FORTH-CORE.md` §6.10) do for any other tag.

A single bank is still capped at `MAX_BANK_SIZE` (4 MiB,
`02-MEMORY-MODEL.md` §4.3) like any other carved bank — a sprite sheet
that would exceed that needs splitting across multiple `SPRT`-tagged
banks, not a format change here.

## Format

### Bit depth

4 bits per pixel (4bpp), fixed. This matches the 16-entry palette below
exactly: one byte encodes two horizontal pixels.

### Palette

Every bank begins with a 16-entry palette, each entry a 32-bit
`0xRRGGBB` value — same entry format as `02-MEMORY-MODEL.md` §4.6's
`PAL` bank (no alpha channel; a color either is or isn't drawn, decided
by the index-0 convention below, not by a per-entry alpha byte).

```
Offset  Size   Contents
0       64     16 x 0xRRGGBB palette entries (4 bytes each)
```

Palette index 0 is reserved as the transparent/color-key index. A blit
never writes index 0 to the destination. This applies uniformly to
sprites and tiles — a tile that only partially fills its 8x8 cell must
not stomp the rest of the cell.

This is a separate, embedded palette per sprite bank — deliberately not
the shared `PAL` bank (`02-MEMORY-MODEL.md` §4.6) `INK`/`PAPER` already
resolve through. `01-HAL.md` §3.6 scopes `PAL`/`ATTR` strictly to the
character-grid ink/paper path ("not a general pixel/graphics-mode
palette... a future indexed pixel/graphics mode remains genuinely out
of this version's scope") and names reuse-vs-own-mechanism for a future
pixel palette as an explicitly open, undecided question. Embedding a
bank-local palette here is the currently-correct choice given that, not
an oversight to reconcile away — revisit only if/when that HAL question
is actually resolved.

### Entry list

Following the palette, a list of entry headers, one per sprite/tile
definition:

```
Offset  Size   Contents
0       1      width in pixels (multiple of 8)
1       1      height in pixels (multiple of 8)
2       1      attribute flags
3       1      reserved (padding / future use)
```

4 bytes per entry header, entry count fixed at bank-build time and
known from the bank's own metadata (not stored per-entry).

### Attribute flags (byte 2 of entry header)

```
bit 0   H-FLIP   render mirrored horizontally
bit 1   V-FLIP   render mirrored vertically
bits 2-7  reserved
```

Flip is applied at blit time by walking pixel data in reverse order; it
is not a separate copy of the bitmap. This doubles usable sprite/tile
variety at zero storage cost.

### Pixel data

Immediately following the entry list, one contiguous block per entry,
in entry order. Each row is `width/2` bytes (guaranteed whole, since
width is always a multiple of 8, hence always a multiple of 4bpp
pixel-pairs). No row padding, no per-row alignment — rows are packed
back to back for `height` rows.

```
entry_size(n) = (width[n] / 2) * height[n]
```

## Offsets are computed, not stored

No offset table is persisted in the bank format. Storing offsets
alongside dimensions creates two representations of the same fact,
which can desync under direct memory writes — inconsistent with the
system's general poke-able-memory model, where a single write should
never leave derived state stale or invalid.

Offset of entry `n`'s pixel data is:

```
offset[n] = palette_size + entry_list_size + Σ entry_size(i)   for i < n
```

where `palette_size = 64` and `entry_list_size = 4 * entry_count`.

### Offset cache

Recomputing this sum on every blit is wasteful in a game loop. When a
bank is activated, a word (tentatively `BUILD-BANK`) walks the entry
list once and populates an in-memory offset cache — analogous to
building a dictionary from source. The cache is derived and disposable:
it can be discarded and rebuilt from the bank at any time, and nothing
depends on its contents surviving a raw memory poke to the bank itself.
The persisted bank format stays minimal; the cache is scratch state.

## Sprites vs. tiles at blit time

Both draw from the same bank format. They differ only in destination
addressing:

- **Sprite blit** — arbitrary (x, y) pixel destination, independent of
  the character grid.
- **Tile blit** — destination is a character-cell coordinate,
  translated to pixel coordinates via the same 8x8 grid text output
  uses. A tile occupies exactly one or more whole cells (width/8 x
  height/8 cells).

No format field distinguishes the two uses — an entry is just a bitmap
of a given size; whether it's blitted freely or grid-snapped is a
decision made by the calling word (e.g. `SPRITE!` vs `TILE!`), not a
property of the bank.

## Explicitly deferred

- **Palette-swap sprites** — recoloring an entry via an alternate
  palette lookup at blit time. Easy to add later as an extra index
  parameter to the blit word; not a bank format change. Not needed yet.
- **Animation / frame sequencing** — banks store static entries only.
  Sequencing frames over time is ordinary Forth game code indexing
  multiple entries manually; no timing or frame-order metadata belongs
  in the bank.
- **Per-sprite palettes** — one palette per bank, shared by all entries,
  consistent with a fixed, ZX Spectrum–era color budget. Multiple
  palettes per bank is not planned.

## Open questions

- Exact opcode/word names for `BUILD-BANK`, `SPRITE!`, `TILE!` — to be
  finalized against `CORE-VOCABULARY.md` conventions once graphics
  primitives (points/lines) land and blit words are drafted alongside
  them.
- Whether bank metadata (entry count, bank size) lives in a small fixed
  header before the palette, or is tracked separately by the loader.
  Currently assumed external to keep the described layout unchanged.
