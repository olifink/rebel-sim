# Rebel Forth: Core Vocabulary Specification

Status: Draft, 2026-07-31. Companion document to `FORTH-ARCHITECTURE.md`
and `CHANNELS-DESIGN.md` — lives at the same level (not nested under any
one target's docs) since, like those two, it's meant to be shared
verbatim across Rebel-Sim, Rebel-ROM, and Rebel-Board. Scoped from
`PLAN.md`'s M8 milestone.

Scope: the word set a "passable" Forth kernel needs before source screens
can build anything portable on top of it — memory access, control flow,
return-stack words, defining words, strings, and the remaining stack/
arithmetic ops M1-M7 didn't already ship.

---

## 1. Purpose

M1-M7 shipped arithmetic (`+ - * / MOD`), basic stack ops
(`DUP DROP SWAP OVER ROT`), comparison (`= < > 0=`), logic
(`AND OR INVERT`), screen (`CHAR! CHAR@ CLS AT-XY INK PAPER EMIT CR .`),
and keyboard (`KEY? KEY`, plus M7a's `ACCEPT`). That's a real interpreter,
but not yet a system anything could be *written in* — there's no memory
access, no control flow, and no way to define new data structures from
Forth source. This document specifies what closes that gap, once, in a
form all three targets implement identically at the behavioral level
(exact mechanism per §8's cross-target notes).

## 2. Notation

Stack effect comments follow standard Forth convention:
`( before -- after )`, items listed left-to-right in stack order (top of
stack rightmost). `x` = any cell, `n` = signed, `u` = unsigned,
`addr` = an arena offset (§1 of `FORTH-ARCHITECTURE.md` — never a raw
pointer), `flag` = Forth boolean (`TRUE = -1`, `FALSE = 0`, per
`FORTH-ARCHITECTURE.md` §7).

## 3. Word Categories — and a scoping note specific to Rebel

Classic Forth (and REI's own `CORE`/`STANDARD`/`USER` split,
`rei-project/REI`) distinguishes **primitives** (native code, in the
dispatch `switch`) from **standard words** (defined *in* Forth, from
primitives, typically loaded from source at boot). That split matters
here for a Rebel-specific reason:

**Every word below has to ship as a native primitive for now, regardless
of which category it would classically belong to.** `PLAN.md`'s M8 entry
already flags this: there's no `LOAD`/screen-source-interpretation
subsystem yet (deferred, depends on the `SCRS` bank), so there's no
bootstrap path that could load a "kernel written in Forth" at boot.
Rebel-Sim's `Machine` boot-registers every word directly in TypeScript
today (M2's write-up: "primitives are real dictionary entries too,
boot-registered"), and that's the only mechanism that exists.

So the table in §9 marks each word **CORE** (no other way to implement it
— raw memory/stack/control-flow access) or **STANDARD-for-now**
(conceptually derivable from CORE words once `LOAD` exists — e.g. `NIP`
is just `SWAP DROP` — but shipped as a native primitive today because
there's nowhere yet to load a Forth-source bootstrap from). This is a
real "temporarily wrong layer" list, worth revisiting word-by-word once
M9+ lands a loader — not a permanent classification.

## 4. Memory Access — all CORE

The highest-priority item in this whole document: `FORTH-ARCHITECTURE.md`
§4 already states the sysvars boundary works because Forth words "read/
write sysvars through `@`/`!`, exactly like any other variable." That's a
standing architectural promise with zero words behind it right now —
nothing in Forth source can touch a sysvar, or arena memory at all,
until this ships.

| Word | Effect | Notes |
|---|---|---|
| `@` | `( addr -- x )` | cell fetch. `addr` must be cell-aligned — no defined behavior for misaligned reads, matching §1's cell model. |
| `!` | `( x addr -- )` | cell store, same alignment requirement. |
| `C@` | `( addr -- x )` | byte fetch, zero-extended, no alignment requirement. |
| `C!` | `( x addr -- )` | byte store (low 8 bits of `x`). |
| `+!` | `( n addr -- )` | add `n` to the cell at `addr`. STANDARD-for-now (`DUP @ ROT + SWAP !` once `LOAD` exists), but see §3 — shipped as a primitive for now. |

## 5. Return Stack — all CORE

RSTK is already exercised internally by the DOCOL/EXIT machinery (M2)
but not exposed to Forth source. `DO`/`LOOP` (§7) depend directly on
these existing.

| Word | Effect | Notes |
|---|---|---|
| `>R` | `( x -- ) ( R: -- x )` | move top of data stack to return stack. |
| `R>` | `( -- x ) ( R: x -- )` | move top of return stack to data stack. |
| `R@` | `( -- x ) ( R: x -- x )` | copy top of return stack without removing it. |

**Implementation warning, not new to Rebel:** a word that does `>R`
without a matching `R>` before `EXIT` corrupts its own return address —
classic Forth's oldest footgun, not something this spec can prevent,
just worth the implementer being aware of when `DO`/`LOOP` push loop
control values onto the same stack (§7).

## 6. Control Flow — all CORE, needs new dispatch primitives

Nothing today gives the instruction pointer special treatment except
`LIT` (§5 of `FORTH-ARCHITECTURE.md`). Control flow needs two new
primitive tokens plus a set of immediate (compile-time) words that
emit and backpatch them:

- **`BRANCH`** — unconditional: read the next cell as a target `ip`
  value, jump there.
- **`0BRANCH`** — conditional: pop a flag; if `FALSE`, behave like
  `BRANCH`; if `TRUE`, skip the offset cell and continue.

**[NEW — needs adding to the canonical opcode table, `FORTH-ARCHITECTURE.md`
§0]** These are two more reserved tokens alongside `DOCOL`, needed
identically across all three targets before this section can be built on
any of them.

The compile-time (`IMMEDIATE`) words that use them hold their backpatch
addresses on the **data stack** while compiling — safe because these
words execute immediately even in compile mode (same mechanism `:`/`;`
already use, `FORTH-ARCHITECTURE.md` §5's DOCOL note), and each
construct's addresses are popped by its own closing word. An unbalanced
`IF` with no `THEN` leaves a stale address on the stack — a real footgun,
inherited from classic Forth, not new here.

| Word | Role |
|---|---|
| `IF` | compiles `0BRANCH` + placeholder; pushes placeholder's address (for `ELSE`/`THEN` to patch). |
| `ELSE` | compiles `BRANCH` + placeholder (jumps past the else-branch); patches `IF`'s placeholder to just past this cell; pushes its own placeholder address. |
| `THEN` | patches the address on top of the stack (from `IF` or `ELSE`) to point at `HERE`. |
| `BEGIN` | pushes `HERE` (backward-branch target) — emits nothing. |
| `UNTIL` | compiles `0BRANCH` + `BEGIN`'s address (known immediately — no patching needed, it's backward). |
| `WHILE` | compiles `0BRANCH` + placeholder (forward exit target), keeping `BEGIN`'s address underneath for `REPEAT`. |
| `REPEAT` | compiles `BRANCH` + `BEGIN`'s address (backward); patches `WHILE`'s placeholder to `HERE`. |
| `DO` | compiles code to pop limit/index off the data stack and push them onto RSTK *above* the current return address (§5's warning applies); pushes `HERE` as the loop-back target. |
| `LOOP` | compiles code to increment RSTK's loop index, compare to the limit; branch back to `DO`'s target if not done, else pop the loop control values off RSTK and fall through. |
| `+LOOP` | as `LOOP`, but increments by a value popped from the data stack rather than by 1. |
| `I` | `( -- n )` pushes the innermost loop's current index (peeks RSTK, doesn't pop). |
| `J` | `( -- n )` same, one loop level out — the next-innermost `DO`'s index. |
| `RECURSE` | compiles a direct call to the *current*, still-`HIDDEN` definition — its dictionary entry (and XT) already exists in the arena at compile time (M2's `writeHeader`), so this bypasses the normal lookup that would otherwise skip `HIDDEN` words. M2 explicitly left this unsupported; this is what resolves it. |

## 7. Defining Words — CORE, and the trickiest section here

What "loading source screens adds portable words on top" actually
depends on — colon-definitions alone compose *behavior*, not new *data
structures*. This needs `CREATE`...`DOES>`, the single most intricate
mechanism in a minimal Forth kernel, worth flagging clearly rather than
glossing over.

| Word | Effect |
|---|---|
| `HERE` | `( -- addr )` current dictionary-growth pointer — already exists internally (§3 of `FORTH-ARCHITECTURE.md`), just not callable from Forth yet. |
| `LATEST` | `( -- addr )` address of the most recent dictionary entry (start of the chain) — same situation as `HERE`: already tracked internally (`FORTH.LATEST`, `IMPLEMENTATION.md` §1.9), just not callable yet. Needed by any dictionary-walking word (`WORDS`, §13). |
| `,` (comma) | `( x -- )` compile `x` as the next cell at `HERE`, advance `HERE`. |
| `ALLOT` | `( n -- )` advance `HERE` by `n` bytes without writing anything — reserves raw space. |
| `VARIABLE` | `( "name" -- )` creates a dictionary entry reserving one cell, initialized to 0; executing the word pushes that cell's address. |
| `CONSTANT` | `( x "name" -- )` creates a dictionary entry; executing the word pushes `x`. |
| `CREATE` | `( "name" -- )` creates a bare dictionary entry whose parameter field starts empty; executing the word (before any `DOES>`) pushes its own parameter-field address. |
| `DOES>` | changes the *behavior* of the most recent `CREATE`d word — see mechanism below. |

**`CREATE`/`DOES>` mechanism — [OPEN, needs confirmation before
building]:** the standard technique needs two more reserved sentinel
tokens beyond `DOCOL`/`BRANCH`/`0BRANCH`:

- **`DOVAR`** — a plain `CREATE`d word's Code Field, before any `DOES>`:
  executing it just pushes the address immediately following the Code
  Field (its parameter field start) and returns. This is what makes bare
  `CREATE` (and `VARIABLE`, built from it) work.
- **`DODOES`** — what `DOES>` rewrites the Code Field to: the word's
  parameter field reserves a leading cell holding a pointer to the Forth
  code following `DOES>` (set by `DOES>` itself, via `,`-style compile).
  Executing a `DODOES` word pushes the address *past* that leading cell
  (the word's actual data), then calls the code at the stored pointer as
  a nested definition (push return sentinel, jump `ip`) — which typically
  ends in `EXIT` back to the caller.

This means every `CREATE`d word reserves one leading cell for a
does-pointer (unused/zero until `DOES>` sets it), a small but real memory
layout decision this section is introducing — flagged here rather than
assumed, since it affects the dictionary/parameter-field shape
`FORTH-ARCHITECTURE.md` §6 documents. Confirm before implementation
starts, same as `BRANCH`/`0BRANCH` above.

## 8. Strings — CORE, one open representational decision

**Decision:** addr/length pairs on the stack, not classic Forth's
counted strings (first byte = length, capping strings at 255 chars).
More portable, no arbitrary length ceiling, consistent with how this
project already departed from classic-Forth defaults elsewhere when the
classic convention didn't fit (`FORTH-ARCHITECTURE.md` §7's storage-model
note is the precedent for "diverge deliberately, document why").

| Word | Effect | Notes |
|---|---|---|
| `S"` | `( "string" -- addr len )` (compile-time: compiles the string inline in the parameter field, followed by code that pushes its addr/len when executed) | Needs the string bytes stored inline and skipped over at runtime — same general shape as `LIT`'s inline-literal mechanism (§5 of `FORTH-ARCHITECTURE.md`), generalized to a byte run rather than one cell. **[OPEN]** exact mechanism (a third inline-data convention, or reuse/extend `LIT`'s) needs a design pass, not assumed here. |
| `TYPE` | `( addr len -- )` | print `len` chars starting at `addr` through the current output (`EMIT`, looped). |
| `."` | `( "string" -- )` (compile-time: print the string when the compiled word runs) | sugar for `S" ... TYPE`, immediate. |

## 9. Stack & Arithmetic — rounding out what's missing

All STANDARD-for-now (§3) — every one of these is mechanically derivable
from what M1-M8 ships, but native for now since there's no loader yet.

| Word | Effect |
|---|---|
| `2DUP` | `( a b -- a b a b )` |
| `2DROP` | `( a b -- )` |
| `-ROT` | `( a b c -- c a b )` |
| `TUCK` | `( a b -- b a b )` |
| `NIP` | `( a b -- b )` |
| `?DUP` | `( x -- x x )` if `x` is nonzero, `( x -- x )` otherwise |
| `DEPTH` | `( -- n )` current data stack depth |
| `/MOD` | `( a b -- rem quot )` |
| `NEGATE` | `( n -- -n )` |
| `ABS` | `( n -- \|n\| )` |
| `MIN` / `MAX` | `( a b -- min/max )` |
| `1+` `1-` `2+` `2-` `2*` `2/` | increment/decrement/double/halve |
| `<>` `0<` `0>` `U<` | comparisons M1 didn't ship |

## 10. Sequencing — why this comes before a remote channel

A remote/MCP channel's value is in letting an agent define and exercise
Forth words interactively — with none of §4-§9 built, there's nothing to
define anything *with*. `Channel` binding and vocabulary completeness are
orthogonal axes; nothing here depends on a remote channel existing first,
and every reason to want a system worth talking to before opening a
remote surface onto it (`PLAN.md`'s M8/M9 ordering).

## 11. Explicitly Out of Scope Here

- **`LOAD`/screen-source interpretation** — a related but distinct
  subsystem (reading a `SCRS` bank's contents as Forth source,
  `FORTH-ARCHITECTURE.md` §7's storage-model note). This document is
  what a screen's *contents* would be written in, not the loader that
  reads them in.
- **`hal_error`/exception model** — still genuinely open everywhere
  (`FORTH-ARCHITECTURE.md` §9), and control-flow words here (`DO`/`LOOP`
  especially) will eventually want to interact with it (an early `LEAVE`
  or an out-of-range loop should probably raise something coherent) —
  not designed now, flagged as a future dependency.
- **`LEAVE`** (early loop exit) — a real classic-Forth word, cut from
  this pass deliberately; add later if a real need surfaces, same
  "don't build ahead" discipline as everywhere else in this project.

## 12. Worked Example: `WORDS` — a Sufficiency Check

A concrete test that §4-§9's vocabulary is actually enough, not just
plausible on paper: `WORDS` (a.k.a. `VLIST`, classic Forth's dictionary
listing) needs nothing beyond what's already scoped above, plus
`LATEST` (§7). Walking the chain:

```
: WORDS ( -- )
  LATEST
  BEGIN
    DUP                    \ nonzero addr = keep going; 0 = end of chain
  WHILE
    DUP 4 + C@ 1F AND      \ length: flags-byte is at entry+4, low 5 bits
    OVER 5 +               \ name addr: entry+5
    SWAP TYPE  32 EMIT     \ print the name, then a space (BL/SPACE not
                           \ scoped separately — a literal + EMIT covers it)
    @                      \ follow the Link Pointer (entry's own first
                           \ cell) to the previous entry
  REPEAT
  DROP                     \ drop the terminating 0
;
```

Note what *didn't* need adding: no `0<>`/comparison word (`WHILE` tests
zero/nonzero directly, per §6), no dedicated `SPACE`/`BL` word (a literal
`32` + `EMIT`, both already shipped, covers it — though those two are
cheap enough to add as named STANDARD-for-now words if used often enough
elsewhere to be worth naming). And since `:`/`;` already work standalone
at the prompt — M2's `SQUARE` example didn't need `LOAD` — `WORDS`
doesn't either; type it in once M8 ships, no loader dependency.

**Natural next step, not scoped here:** `SEE <word>` (decompile a
definition back to source-ish form, `.see` in REI's own convention) is a
bigger lift — it needs the reverse of what `WORDS` does: given a word's
Parameter Field, look up which dictionary entry each stored XT belongs to
(another chain walk per XT found), not just print a name. Worth doing
once `WORDS` proves the chain-walk mechanics work, not before.

## 13. Cross-Target Notes

- **New tokens (`BRANCH`, `0BRANCH`, `DOVAR`, `DODOES`) go in the
  canonical opcode source of truth** (`FORTH-ARCHITECTURE.md` §0) before
  any target implements them — the exact failure mode §0 exists to
  prevent.
- **Every word's *behavior* is identical across Rebel-Sim/Rebel-ROM/
  Rebel-Board; only the primitive's native implementation differs** — a
  TypeScript `case` in Rebel-Sim's `switch`, a C++ `case` in Rebel-ROM's,
  eventually RISC-V-appropriate code on Rebel-Board. None of this section
  is target-specific by design; if a word's behavior needs to differ per
  target, that's a sign it belongs in a HAL call or sysvar, not here
  (`FORTH-ARCHITECTURE.md` §4's portability boundary rule).
- **Rebel-ROM reconciliation:** unlike M3-M5, there's no shipped
  Rebel-ROM reference for any of this yet (Phase 11 hasn't started
  there) — this document is being authored ahead of Rebel-ROM this time,
  same relationship Rebel-Sim's M7 had to Rebel-ROM's still-pending
  Phase 11 channel work. Reconcile against Rebel-ROM's actual
  implementation once it exists, same as `CHANNELS-DESIGN.md` was
  reconciled against shipped modules.
