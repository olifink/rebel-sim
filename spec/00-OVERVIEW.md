# Rebel Forth System — Technical Specification Suite

## 1. What this is

This directory is a portable, implementation-independent technical
specification for the **Rebel Forth system**: a token-threaded Forth
engine plus the memory model, sysvar contract, and hardware abstraction
boundary it depends on. It is written to be implementable **from this
suite alone**, by an engineer or coding agent with no access to any
existing Rebel-family codebase (browser simulator or bare-metal
firmware).

Two concrete reference implementations already exist and independently
validate the decisions recorded here — a browser-based TypeScript
simulator (ahead on the interpreter/dictionary/primitive set) and a
bare-metal ARM firmware project (ahead on the hardware substrate: screen,
keyboard, storage, memory, scheduling). Where this suite states a rule as
settled, it is because both of those independent implementations already
converge on it, or because a real divergence between them was resolved
here in favor of one side, explicitly and with reasoning. Neither
reference implementation's source is required to read or implement
against this suite, and neither is authoritative over it — **this suite
is authoritative going forward**; an existing implementation that
diverges from it is non-conformant and needs updating, not the reverse.

## 2. Audience

Coding agents and engineers implementing a new Rebel-family target:

- A portable C/C++ implementation, buildable for any bare-metal or
  hosted target.
- A hand-optimized assembly implementation for a specific core (e.g.
  RP2350's Hazard3 RISC-V or Cortex-M33 cores) built directly against
  this suite rather than by transliterating the C/C++ implementation.

This suite is deliberately **generic**: it names no specific CPU,
board, toolchain, or vendor SDK. Anything target-specific belongs in a
target's own porting notes, not here.

## 3. Document index

| # | Document | Status | Covers |
|---|---|---|---|
| 01 | [`01-HAL.md`](01-HAL.md) | **v1.0** | The hardware abstraction boundary: screen, keyboard/input, the input-channel abstraction, storage, timing, error reporting. What every target must supply, and what's portable and must never be reimplemented per target. |
| 02 | `02-MEMORY-MODEL.md` | planned | Cell size and endianness, arenas, the bank table, addressing rules. |
| 03 | `03-SYSVARS.md` | planned | Sysvar group/field layout, encoding, the capability-flag convention this suite's HAL document already assumes exists. |
| 04 | `04-FORTH-CORE.md` | planned | Dictionary header, token-threaded dispatch, the outer/inner interpreter, the primitive word set, the error/exception model. |

Only `01-HAL.md` is written so far. The other three are named here so
cross-references from the HAL document resolve to a real (if not yet
written) target, and so the HAL document's own scope boundaries — what
it deliberately does *not* cover because it belongs to one of these —
are legible.

## 4. Normative language

This document and every document in this suite use the requirement
levels from RFC 2119:

- **MUST** / **REQUIRED** — an absolute requirement of a conformant
  implementation.
- **MUST NOT** — an absolute prohibition.
- **SHOULD** / **RECOMMENDED** — a strong recommendation; a conformant
  implementation may deviate only for a specific, documented reason,
  and should weigh the consequences.
- **SHOULD NOT** — the inverse.
- **MAY** / **OPTIONAL** — genuinely at the implementer's discretion.

A **conformant target** is one that implements every MUST/REQUIRED item
applicable to it (some are gated by target capability — e.g. a target
with no display is not required to implement graphics draw operations)
and does not violate any MUST NOT.

## 5. Governing design principles

These hold across every document in the suite, not just the HAL one.
Where a specific document restates one, it's for that document's own
readability, not because the rule is local to it:

- **One 32-bit, little-endian cell, everywhere, no exceptions.**
  (Full treatment: `02-MEMORY-MODEL.md`.)
- **Sysvars are the only portable/native boundary.** Forth source reads
  and writes target-specific or subsystem state exclusively through
  `@`/`!` on sysvar cells — never by branching on which target it's
  running on. If a behavior can be expressed as "read a sysvar, act the
  same way everywhere," it belongs in portable Forth source. If it
  genuinely needs different code per target, it belongs behind this HAL
  boundary, not scattered through Forth source with conditionals.
- **Token-threaded dispatch**, not indirect-threaded or subroutine
  models. (Full treatment: `04-FORTH-CORE.md`.) Irrelevant to the HAL
  boundary itself, listed here only because it's a suite-wide
  invariant.
- **HAL boolean convention:** `TRUE = -1` (all bits set at the cell
  width), `FALSE = 0` — never C-style `1`/`0` — for any value that
  ends up on the Forth data stack or in a sysvar cell.
- **Minimum real mechanism, not ahead of need.** This suite documents
  what a conformant implementation must actually provide today. Where a
  plausible future need is visible but not yet load-bearing anywhere
  (e.g. multi-arena management, per-channel-type configuration, generic
  bank introspection), it is named as an explicit open extension point,
  not designed prematurely and not silently ignored.

## 6. How to read a spec in this suite

Each document distinguishes two kinds of content, called out explicitly
wherever the distinction matters:

- **Portable logic** — behavior that is bit-for-bit identical on every
  conformant target, implemented exactly once against the interfaces
  this suite defines, and never reimplemented, only linked/ported.
- **The per-target boundary** — the actual, minimal set of functions a
  new target must supply, and the entry points target-specific driver
  code must call into the portable layer.

Conflating the two is the most common way an otherwise-careful port
drifts from this specification — duplicating portable logic per target
invites the two copies to diverge over time. Where a document marks
something portable, treat "port it once, share it" as a requirement,
not a suggestion.
