# WORLD-MAP.md

## Purpose

Defines the room and world-graph data structure shared across game
types: isometric (Ultimate-style), top-down, and cell-locked
platformers. One format serves all three by letting each interpret the
same axes differently, rather than maintaining separate world formats
per game type.

Screen transitions are flips between discrete rooms, not continuous
scrolling. A room is a single fixed screen; there is no camera, no
partial-room viewport, and no scroll offset anywhere in this format.
Exits are room-to-room jumps, not scroll boundaries.

## Relationship to 02-MEMORY-MODEL.md / 01-HAL.md

Unlike `SPRITE-BANK.md`, no bank tag exists yet for this data —
`02-MEMORY-MODEL.md` §4.6's known-tag list has nothing world/room-shaped,
and it's explicit that list "grows... as a target's own real, load-bearing
need" adds to it, not on spec. Given that, this format is scoped to live
in the generic `DATA` tag ("General-purpose scratch", §4.6; `.DAT`
extension and "ordinary content asset" persistence, `01-HAL.md` §6.3)
rather than proposing a new tag — the format itself is opaque bytes to
the memory model either way, and `02-MEMORY-MODEL.md` §4.7 already lets
multiple `DATA`-tagged banks coexist, distinguished by `name` (one world
per bank, named for the world/level), the same way `SPRITE-BANK.md`
distinguishes multiple sprite sheets under `SPRT`. Every "Offset" below
is relative to the bank's own base (byte 6 of a persisted `.DAT` file,
past the standard asset header, `01-HAL.md` §6.3). A world exceeding one
bank's `MAX_BANK_SIZE` (4 MiB, `02-MEMORY-MODEL.md` §4.3) needs
splitting across multiple `DATA`-tagged banks — not addressed by the
single-bank world-graph structure below.

Promoting this to its own tag only becomes worth raising against
`02-MEMORY-MODEL.md`/`01-HAL.md` if a real, load-bearing need shows up
(e.g. a tool or loader that must distinguish "world data" from other
`DATA`-tagged content by tag alone, not by name) — not by default.

## Two-level structure

1. **Room** — a fixed-size 3D grid of cells (x, y, z) plus exit
   definitions. This is the unit that gets drawn to screen and the
   unit collision/movement operates within.
2. **World graph** — the set of rooms and how their exits connect to
   each other. This is pure topology; it carries no coordinate space
   of its own; the room graph tells you which room you're in and which
   room each exit leads to, nothing more.

## Room grid

### Axes

Every room is a grid of cells addressed by (x, y, z). All three axes
are always present in the format; game types differ only in how they
use them:

- **Isometric** — x, y as ground plane, z as elevation. All three used
  for depth-sort and walk-behind/stand-on-top logic at render time.
- **Top-down** — x, y as the plane, z fixed at 0 for every cell in the
  room.
- **Side-view platformer** — x as horizontal, z as vertical/gravity
  axis, y fixed (or used for a fixed number of parallax/depth layers,
  not gameplay-relevant collision).

Carrying an always-zero axis for game types that don't use it is a
single byte per cell — not worth branching the format over.

### Cell contents

```
Offset  Size   Contents
0       1      tile bank entry index (references SPRITE-BANK.md)
1       1      solidity flags
```

**Open gap, not resolved here:** nothing in this format says *which*
`SPRT`-tagged bank (`SPRITE-BANK.md`) a room's tile indices resolve
against, and `02-MEMORY-MODEL.md` §4.7 allows several to be resident at
once, distinguished by name. `03-SYSVARS.md` §9's `SPRITE` group is
fully reserved with no fields defined yet — the natural home for an
"active tile bank" pointer, the same pattern `PALETTE-BASE`/`FONT-BASE`
already establish (`03-SYSVARS.md` §6/§8) — but that's a candidate, not
a decision made here. Until resolved, treat a room's tile indices as
resolving against a single implicit global tile bank, one per world at
most (not per-room), consistent with the current "one palette" scoping
elsewhere.

### Solidity flags (byte 1)

```
bit 0   BLOCKING    cannot occupy or pass through this cell
bit 1   PLATFORM    can stand on top of; does not block horizontal
                    entry from the side (relevant to isometric z-stacking
                    and platformer ground checks alike)
bits 2-7  reserved
```

A cell with neither bit set is open space. `BLOCKING` and `PLATFORM`
are not mutually exclusive from a storage standpoint, but a cell
should not sensibly set both; game code interprets combinations, the
format just carries the bits.

### Room dimensions

Room width/height/depth (cell counts along x, y, z) are fixed per room
and stored in a small room header preceding the cell data:

```
Offset  Size   Contents
0       1      width  (cell count, x axis)
1       1      height (cell count, y axis)
2       1      depth  (cell count, z axis — 1 for top-down/platformer
                        rooms that don't use elevation)
3       1      reserved
```

Cell data follows immediately, `width * height * depth` cells, 2 bytes
each, in the same row-major convention used elsewhere (x fastest, then
y, then z).

## Exits

Each room carries a fixed list of exits. An exit is a directional edge
from a cell (or cell range) in this room to a destination room and
entry point.

```
Offset  Size   Contents
0       1      direction (N/S/E/W/UP/DOWN — see below)
1       1      source cell reference (which edge cell(s) trigger this exit)
2       1      destination room index
3       1      destination entry cell reference
```

**Correctness gap, not a memory-model issue — an internal one:** a
"cell reference" here is 1 byte, but the room header (below) allows
width/height/depth each up to 255 independently, so a room whose
`width * height * depth` exceeds 256 has cells no single byte can
address as a linear index, and no byte in this 4-byte layout has room
for a packed (x, y, z) triple either. Exits fire from a room's edge, so
in practice only two of the three axes ever vary for a given direction
(e.g. a `NORTH`/`SOUTH` exit's source only needs an (x, z) pair, `y`
being fixed at the edge) — that may be enough to fit one byte per axis
pair for realistic room sizes, but this format doesn't yet say so
explicitly, and a room where even the two relevant axes multiply past
256 (e.g. a 32x32 isometric floor) still overflows. Needs resolving
before this is implemented, not just before it's optimized.

### Direction encoding

```
0  NORTH
1  SOUTH
2  EAST
3  WEST
4  UP      (z-axis, isometric/platformer vertical rooms)
5  DOWN
```

An exit fires when the player entity's logical cell position matches
the exit's source cell on the relevant edge of the room. On firing,
the current room is unloaded, the destination room is loaded, and the
player is placed at the destination entry cell. This is a flip, not a
scroll — no interpolation between rooms, no shared coordinate space
between source and destination room.

## World graph

The world graph itself is just the collection of rooms plus their
exit tables — there is no separate top-level structure beyond "list of
rooms," since all connectivity is already carried per-room in the exit
list. A room's exits reference destination rooms by index into this
list.

```
Offset  Size   Contents
0       1      room count
1..     -      room count x (offset to room header)
```

Room offsets are computed from room sizes at world-build time, same
approach as sprite bank entry offsets — not stored redundantly, kept
consistent with the poke-able-memory principle: room dimensions are
the single source of truth, offsets are derived.

## Movement granularity (cell-locked default, continuous optional)

The grid and room format describe **logical position** only — which
cell an entity occupies. This is deliberately separate from **render
position**:

- **Cell-locked (default)** — entity's logical position is the
  authoritative position. Movement between cells can still be
  rendered smoothly by interpolating render position from the
  previous cell to the next over N frames; the logical position itself
  still changes atomically. This interpolation is game-loop/entity
  state (see `EXECUTION-LOOP.md`), not part of this format.
- **Continuous** — entity tracks a sub-cell render position directly
  as its authoritative position; the grid is consulted only for
  collision queries (is the cell ahead blocking/platform). No change
  to this format is needed to support this — it's purely a difference
  in what the entity's position state means, layered above the grid.

`WORLD-MAP.md` does not need to declare which mode a given game uses;
that's a property of the entity/movement code, not the room data.

## Depth sorting (isometric)

Render order for a room's cells, when using the isometric renderer, is
determined by `x + y + z` (painter's algorithm) computed at draw time
from the same authoritative cell grid. No separate sort-order data is
stored — this is render-time logic, consistent with keeping projection
and screen placement out of stored data (see `SPRITE-BANK.md`).

## Explicitly deferred

- **Scrolling / continuous world space** — not supported by design.
  Rooms are discrete, connected only by exits. If this changes later,
  it is a different format, not an extension of this one.
- **Variable-size rooms within a single world** — the format allows
  different rooms to have different width/height/depth, but there is
  no assumption yet about how the designer tool authors non-uniform
  room sizes. To be resolved when the designer tool is built.
- **Multi-cell entities / large sprites spanning several cells for
  collision purposes** — not addressed here; assumed to be handled by
  entity-side logic checking multiple cells, not a room-format concern.

## Open questions

- Exact word names for room load/unload and exit-fire handling — to be
  finalized against `CORE-VOCABULARY.md` and `EXECUTION-LOOP.md`
  conventions once the game-loop primitives are drafted.
- Whether the designer tool authors rooms independently and links them
  via a separate pass, or builds the whole world graph as one editing
  session. Affects tooling, not this format.
