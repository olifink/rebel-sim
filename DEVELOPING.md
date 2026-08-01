# Rebel-Sim: Developing & Writing Code

Status: **Living/exploratory document.** Unlike `DEBUGGING.md` (a single
fully-scoped milestone), this tracks a connected set of ideas around
*how source gets written, kept, and refined* — starting from one
concrete, buildable-now piece (§2, comment retention) and opening
outward into things that are real but genuinely not designed yet (§3-§5).
Expect this to grow across several sessions as the screen editor and
cart/baking infrastructure actually get built, rather than being
written once and left alone.

## 1. Motivation

A specific, remembered pain point from early interactive Forth systems:
a word typed at the prompt and refined interactively has no path back
into source you keep. `SEE` can show you what a word decompiles to, but
there's no way to take that and drop it into a screen to edit further —
the interactive session and the saved source are two disconnected
worlds. The Jupiter Ace's (non-standard) Forth did one thing right here
that mainstream Forths didn't: `( ... )` comments were compiled into the
definition as an actual string, not thrown away during compilation —
so a word's *rationale*, not just its code, survived being typed in
once.

The throughline: **comment retention is the prerequisite, not a side
feature.** Once the screen editor vocabulary exists (§4, not built),
"bring this interactive definition into a screen" is only worth having
if what comes back is something you'd actually want to keep editing —
and a decompiled word with no comments is a worse starting point than
what you'd type from scratch. So this gets built now, before screens
exist, using only what's already in place (`:`/`;`, `HERE`, `,`, the
same `nextInputToken()` cursor `S"`/`CREATE` already share) — it works
identically whether the source came from an interactive line today or
a loaded screen later, because `:`/`;` compilation is the same code
path either way. No engine change, per the read below.

## 2. Comment retention — concretely scoped, buildable now

### 2.1 Current state (verified by reading the code, not assumed)

Comments **do not exist at all yet** in this engine — not "discarded,"
genuinely absent. `Machine.tokenizeAndRun` (`repl.ts:351`) does
`line.trim().split(/\s+/)`: plain whitespace tokenization, nothing
comment-aware. A stray `(` typed today is just an unrecognized token
like any other and either resolves as a number-parse failure or an
"unrecognized word" error. There's no prior "strip comments" behavior
to preserve compatibility with — this is greenfield, which is exactly
why it's worth building retained-from-day-one rather than building the
lossy classic behavior first and upgrading later.

### 2.2 A related, already-known limitation worth reusing carefully

`S"`/`."`'s string parsing (`primitives.ts:74`, `compileInlineString`)
has a real, already-documented scope cut: it consumes exactly **one**
token via `nextInputToken()` and requires that token to end in `"` —
`S" hello world"` (a string with embedded spaces) does not actually
work today; only single-word strings do. Comments are close to useless
if they can't contain spaces, so `(`'s token-consuming logic needs to
be a genuine loop — keep calling `nextInputToken()`, accumulating text
with single spaces rejoining each token, until one ends in `)` — not a
copy of `S"`'s current one-shot grab. Building that loop once and using
it for both `(`'s comment parsing and a fixed multi-word `S"` is a
smaller, more honest piece of work than building two separate
mechanisms — worth doing together, flagged here so it isn't
accidentally done twice.

One real, worth-documenting limitation this reuse inherits either way:
because tokenization already collapsed the original line into
whitespace-separated tokens before `(` ever sees it, the text
reconstructed by rejoining tokens with single spaces won't byte-for-byte
preserve the original whitespace (tabs, double spaces, etc.) inside a
comment. Fine for now — nothing downstream (§3's `SEE`) needs
byte-exact whitespace — but worth stating rather than silently
discovering later.

### 2.3 Storage: reuse `(SLIT)`, or add a dedicated token?

Two real options, not yet decided:

**Option A — pure Forth, zero primitive changes (recommended default,
matches "no engine change" expectation).** Define `(` as an `IMMEDIATE`
word. While compiling (`STATE = -1`): loop-consume tokens as above,
then compile exactly what `S"` already compiles — `(SLIT)` + length +
raw bytes — followed immediately by a compiled `2DROP` (already a
primitive, per `CORE-VOCABULARY.md` §11's stack-word list). At runtime,
this makes a comment a genuine no-op: `(SLIT)` pushes `(addr, len)`,
`2DROP` throws it away, net stack effect zero, at the cost of two extra
token dispatches every time the surrounding word runs. While
interpreting (`STATE = 0`, comment typed outside a definition, nothing
to compile into): loop-consume and discard, same as classic Forth's
`( ... )` — there's no `HERE` to write into at interpret time, so
"retain" only ever applies to comments that end up *inside* a
definition, which is the case that actually matters (a comment typed
loose at the prompt has no word to attach its rationale to anyway).

**Option B — a dedicated `(COMMENT)` primitive**, structurally identical
to `(SLIT)` (length-prefixed inline bytes) but with a genuinely
no-op runtime (skip the bytes, push nothing) — same tier as `(SLIT)`
itself in `inner.ts`'s special-cased dispatch. Costs an actual engine
primitive (new token id in `rebel-opcodes.json`, a `threadFrom` branch
next to `SLIT_TOKEN`'s), but is cleanly, unambiguously distinguishable
from a real string literal in the compiled body — which matters for
§3's `SEE`: under Option A, a decompiler sees a `(SLIT)` cell followed
by a `2DROP` cell and has to *infer* "this pattern means comment," with
no way to tell that apart from a program that genuinely happens to
build and immediately discard a string for its own unrelated reasons
(rare, but not impossible — e.g. a string built solely for its length
as a side effect). Option B has no such ambiguity: the token itself
says "comment."

Leaning towards **A now, B later if `SEE` output ever turns out
ambiguous in practice** — consistent with this project's "build the
minimum real mechanism, revisit once an actual need shows up"
discipline (`CLAUDE.md`), and it means this ships with literally zero
`packages/engine` primitive/opcode changes, only new bootstrap Forth
source. Recorded here as a real, reversible decision, not a
foreclosed one.

### 2.4 `\` (rest-of-line comments) — open question, not decided

Classic Forth's `\` comments out everything to the end of the current
line — typically used for source-file bookkeeping (a screen's header
line, a TODO) rather than being part of a word's semantic content the
way an inline `( ... )` explaining a tricky line is. Worth deciding
once screens exist (§4) whether `\` should get the same retain-as-data
treatment as `(`, or stay genuinely discarded as a different, lesser
kind of comment. Not resolved here — flagged so it isn't silently
assumed either way.

## 3. `SEE` — decompiling a definition (near-term, not yet designed in detail)

`CORE-VOCABULARY.md` §12 already anticipated this: `WORDS` (shipped,
M8) was explicitly framed as proving the dictionary chain-walk
mechanics `SEE` would need, calling `SEE` itself "a bigger lift... worth
doing once `WORDS` proves the chain-walk mechanics work" — that
precondition is now met.

The core mechanism, sketched but not fully designed: walk a word's
Parameter Field cell by cell, same as `threadFrom` does at runtime, but
read-only and printing instead of executing. Two cases per cell:

- **A call to another word** (a `DOCOL`/`DODOES`/primitive-coded XT):
  resolve it back to a name. This doesn't need a separate lookup table —
  primitives are boot-installed as real dictionary entries too
  (`Machine`'s constructor calls `writeHeader` once per entry in
  `rebel-opcodes.json`'s primitive list), so "given a CFA, find the
  dictionary entry whose CFA matches it" is one uniform walk covering
  both user-defined and primitive words, no primitive-vs-user-defined
  special case needed at the `SEE` level.
- **An inline-data token** (`LIT`, `BRANCH`/`0BRANCH`, `(SLIT)`, and
  §2's comment encoding): needs the same special-casing `threadFrom`
  itself already does to know how many trailing bytes/cells belong to
  that token rather than being the next instruction — `SEE` is, in
  effect, a read-only Forth-level reimplementation of `inner.ts`'s own
  decode step.

The real payoff tying this back to §1/§2: once comments are retained,
`SEE` printing them back out inline is what actually closes the original
loop — a decompiled word with its rationale still attached is worth
bringing into a screen; one without is not obviously better than typing
it fresh. Flagged as the next concrete milestone after §2 ships, not
designed further here.

## 4. Bringing definitions into screens (future — blocked on infrastructure that doesn't exist yet)

Vision only: `SEE`'s output feeding directly into an editable screen
buffer — decompile `FOO`, drop the text into a screen, refine it there,
recompile from the screen. This is explicitly blocked on infrastructure
this repo hasn't built: `FORTH-ARCHITECTURE.md`'s `SCRS` bank (classic
1024-byte Forth screens as a *source-editing* concept, distinct from
the `CART`-tagged distributable-code bank) and the screen editor
vocabulary itself don't exist yet — `CORE-VOCABULARY.md` §11 notes the
loading subsystem is "deferred, depends on the `SCRS` bank." Nothing to
design here until that lands; noted so the connection to §1's original
motivation isn't lost between now and then.

## 5. "Baking" a cart and comment stripping (future — genuinely unscoped)

Vision only, using this repo's actual established terms:
`FORTH-ARCHITECTURE.md` distinguishes editable **screens** (`SCRS`
bank, source) from a distributable **cart** (`CART` bank,
`/CARTS/<name>.CRT` on Rebel-Sim per `PORTING-WEB.md`) — "baking"
would be the step that turns the former into the latter. Once that step
exists, stripping §2's retained comments during baking (produce a
leaner distributable cart while keeping the source-side screens fully
commented) is a plausible optional pass — but it's a real can of worms
even sketched at a high level: compiled comments live inline in a
word's Parameter Field, so removing them after the fact means splicing
bytes out of compiled code and relocating every address reference past
that point, closer to a real "compacting" pass than a simple strip.
Not designed here at all — flagged as a known future want, to be
designed for real once baking itself is defined anywhere, which it
currently isn't.
