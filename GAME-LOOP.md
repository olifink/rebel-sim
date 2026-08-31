# GAME-LOOP.md

## Purpose

Defines how game execution — entity logic, the sprite render list, and
frame sync — relates to Rebel's core dispatch loop. This is proposed
as a consumer of the suspend/resume mechanism `04-FORTH-CORE.md` §4.4
establishes, not a parallel runtime — but §4.4 itself leaves the
driving loop's incremental-stepping mechanism target-specific and
unspecified, so this document is a candidate design for that gap, not
a reuse of something already decided. This document adds the
structures specific to games: a cooperative entity scheduler and a
decoupled sprite render list, both driven by the same per-frame tick.

Status: design reference for a milestone beyond the current sequence
(M7 → M7a → M8 → M9). Nothing here is scheduled yet; this document
exists so the shape is decided in advance and M8's core vocabulary
doesn't paint it into a corner.

## Relationship to 04-FORTH-CORE.md §4

The general execution-loop design was folded into `04-FORTH-CORE.md`
(§4, token-threaded dispatch) rather than staying a separate document.
This section has been corrected accordingly — and one claim from the
original draft needs walking back, not just re-pointing.

**What §4.4 actually establishes today:** the threading loop's only
loop-local state is `ip` plus the return/data stack contents (§4.2's
consequence of threading through an explicit loop rather than native
recursion). This is what makes suspend-and-resume at a blocking `KEY`
possible on every target (§4.3/§4.4), and §4.5 reuses that exact same
suspend point for optional word-level breakpoints. That reuse is real,
useful precedent: it's what makes "freeze the game, drop to the REPL,
inspect entity memory at that address" plausible without a bolted-on
separate debugger.

**What §4.4 does not establish:** a target's outer/driving loop being
able to run the interpreter *incrementally* — a bounded number of
steps, then hand control elsewhere and come back — is named in §4.4 as
something a target *should* support, but the document is explicit that
"the exact API shape for that (a step budget, a cooperative yield, an
interrupt-driven preemption point) is... target-specific and not
specified here." That's a real gap, not shared infrastructure this
document can assume already exists. `GAME-LOOP.md` is a candidate
design for filling that gap for the game case specifically — the game
tick is *a* step-function shape consistent with §4.4's suspension
model, not a reuse of one that's already been specified elsewhere.

## Cooperative entity scheduler

Game entities (player, enemies, projectiles, particles) are
represented as lightweight cooperative tasks, not preemptive threads.
This matches Forth's traditional multitasking model (round-robin,
save/restore only SP and RP on switch) and avoids the race conditions
and debugging cost of real preemption on a system with no OS
underneath it.

### Task table

A fixed-size table of active entity tasks. Each entry holds:

- execution state (where this task resumes on its next turn)
- entity data (position, velocity, whatever the entity's own logic
  needs — not prescribed here, entity-specific)
- active flag

### YIELD

A task runs until it calls a `YIELD`-equivalent word, at which point
control returns to the scheduler and the next active task gets its
turn. One full pass through the task table is one logic step —
typically once per frame, though nothing here requires a task to only
yield once per tick.

### Open dependency: this needs more than one stack

**This is a real gap surfaced by checking against `04-FORTH-CORE.md`,
not yet resolved here.** §4.4's suspension model — the property that
makes suspend/resume possible at all — is explicitly single-threaded:
one `ip`, one data stack, one return stack, tied to the single
`SP0`/`RP0` pair in `03-SYSVARS.md`'s `FORTH` group. "Each task holds
its own execution state" as written above implicitly assumes each
entity task gets its own `ip` *and* its own stack pair — classic
multitasking-Forth territory (the fig-Forth/F83 multitasker model),
which needs multiple independent stack regions that nothing in
`02-MEMORY-MODEL.md` or `03-SYSVARS.md` currently provides for.

Two directions, not decided here:

- **True multitasking** — extend the memory model with N stack-pair
  regions and a real per-task `SP`/`RP`, closer to the historical
  pattern this design was borrowing from. More capable (a task can be
  suspended mid-arbitrary-computation, not just at defined points), but
  a real extension to `02-MEMORY-MODEL.md`/`03-SYSVARS.md`, not a
  free reuse of what exists today.
- **Coroutines on the single stack** — each "task" is Forth-source code
  that only ever yields at defined call sites (structured like §4.4's
  `KEY`-suspend composition, §6.9's discussion of `ACCEPT`), saving just
  enough state (not a full second stack) to resume there next tick.
  Cheaper, fits the existing single-stack model unmodified, but more
  restrictive about where a task may yield.

This needs to be resolved — probably by looking at what
`02-MEMORY-MODEL.md` and `03-SYSVARS.md` can absorb — before task table
memory layout (already deferred below) can be pinned down at all.

### Why cooperative, not interrupt-driven

Driving entity logic directly from a hardware timer/VSYNC interrupt
(as White Lightning's IDEAL did on the Spectrum) is a viable historical
pattern, but on a multi-core bare-metal target it invites exactly the
stack-pollution and race-condition problems Rebel's other design
choices are trying to avoid. A cooperative scheduler keeps entity
switches deterministic and cheap (a few instructions, not an
interrupt-context save) and — critically for Rebel's REPL-native
identity — keeps the whole task table inspectable and pokeable from
the interactive prompt at any paused frame, the same way any other
memory is.

## Sprite render list (decoupled from the entity table)

The entity/task table is not the render list. They are kept separate
deliberately:

- Not every entity draws a sprite (a trigger volume, a timer, a script
  cue are entities with no visual).
- Some entities need more than one sprite (a multi-cell boss, a
  shadow, a trail).
- Sorting, culling, and z-ordering for rendering are render-layer
  concerns and have no reason to be tangled into entity logic.

This mirrors real sprite-hardware architectures (VIC-II, PPU-style
OAM): the developer-facing model is "declare where a sprite is," and
the engine handles drawing/erasing/z-order without the entity's task
code ever calling a blit directly.

### Render list slots

A fixed-size array of active sprite slots. Each slot:

```
flags        active bit, h-flip, v-flip, layer/priority bits
x, y         screen or world position (interpretation is render-mode
             dependent — see WORLD-MAP.md for cell-locked vs.
             continuous positioning)
bank-entry   index into a sprite bank (see SPRITE-BANK.md)
```

Entity tasks write to a slot (position, which bank entry, flip state)
the same way they'd update their own state — a plain memory write, not
a draw call. The task never erases its own previous frame, never
computes clipping, never calls a blit word directly.

### Render pass

Once per frame, after the entity scheduler pass and before flip:

1. Restore/redraw background under sprites that moved (see the "prev
   position" note below), or redraw affected tiles for the current
   room from `WORLD-MAP.md` data.
2. Sort active slots by z/priority where relevant (isometric depth
   sort per `WORLD-MAP.md` uses this same slot data).
3. Blit each active, on-screen slot from its sprite bank entry.
4. Flip.

### Background restoration

Two approaches, and this format doesn't mandate one:

- **Full redraw** — clear/redraw the room's tile layer each frame,
  then blit all active sprites on top. Simpler, costs more per frame.
- **Dirty-rect restore** — each slot also tracks its previous frame's
  x/y; only the previous-position rectangle is restored (from tile
  data) before the new position is blitted. Cheaper for sparse scenes,
  more bookkeeping.

Which one Rebel uses is a performance decision for the actual target
hardware, not a format decision — the slot structure supports either.

### Off-screen culling

The render pass should skip blitting slots whose bounds fall entirely
outside the visible room/screen area — ordinary bounds check against
the slot's x/y/w/h before touching the blit primitive.

## Collision

A single fast primitive is enough at this layer — bounding-box
overlap between two slots' x/y/w/h. This is a general-purpose word,
not sprite-specific, and belongs in `CORE-VOCABULARY.md`'s eventual
math/geometry section rather than being redefined here.

Per-frame collision results (which slots overlapped this tick) are a
render-pass byproduct, not stored state — entity tasks query for
collisions against specific other slots/entities as part of their own
logic step, the same way they'd query any other transient per-frame
fact.

## VSYNC / FLIP

The game loop's tick boundary is a frame sync, provided by the HAL
(see `01-HAL.md` — `04-FORTH-CORE.md` §1 is explicit that HAL-boundary
functions themselves are specified there, not in the core dispatch
document) regardless of
whether the underlying target is SPI-driven (tearing-effect line) or
HDMI/DVI (hardware vblank interrupt). This document treats frame sync
as an opaque HAL-provided signal — the actual interrupt/DMA mechanics
per target belong in `SCREEN-MODULE.md`'s hardware-facing sections,
not here. Nothing about the entity scheduler or render list depends on
which mechanism a given target uses to signal "next frame."

## Explicitly deferred

- **Exact task table size, slot count, and memory layout widths** —
  left unspecified until this is scheduled against real vocabulary and
  memory budget work.
- **Priority/interrupt-driven variant** — if a target's constraints
  ever demand it, an interrupt-driven entity update is not precluded
  by this design, but it's not the default and isn't specified here.
- **Multi-core task distribution** (e.g. render pass on one core,
  entity logic on another) — plausible future optimization on targets
  that support it, not part of the base model.
- **Animation timing driving sprite frame advance** — consistent with
  `SPRITE-BANK.md`, frame advance is entity/task logic choosing which
  bank entry to write into its slot, not a property of the render list
  or the bank itself.

## Open questions

- **Multi-stack vs. coroutine scheduler** (see the dedicated note under
  "Cooperative entity scheduler" above) — whether entity tasks get real
  independent stack regions (a `02-MEMORY-MODEL.md`/`03-SYSVARS.md`
  extension) or run as single-stack coroutines yielding only at defined
  call sites. This is the load-bearing open question in this document;
  most of the rest depends on which way it goes.
- Whether the game tick's incremental-stepping mechanism should be
  proposed as the concrete answer to `04-FORTH-CORE.md` §4.4's
  target-agnostic "step budget / cooperative yield / interrupt-driven
  preemption" gap, or stay a game-specific mechanism that doesn't try
  to generalize to the REPL/editor case.
- Word names for the scheduler (`YIELD`-equivalent), slot table access
  words, and the render pass entry point — to be finalized against
  `CORE-VOCABULARY.md` once this reaches an actual milestone.
- Whether the render list lives in the same memory space/bank
  conventions as other Rebel state, or gets a dedicated region —
  affects `MEMORY-MODEL.md`, not decided here.
- How pausing a game (dropping to REPL mid-frame) interacts with a
  partially-complete render pass — needs to be resolved alongside
  `04-FORTH-CORE.md` §4.4/§4.5's suspend/breakpoint mechanism.
