# 04 — Forth Core Specification

**Version 1.0.** See `00-OVERVIEW.md` for normative-language definitions
and suite scope. Builds on `02-MEMORY-MODEL.md` (cells, arenas, banks —
in particular `DICT`/`RSTK`/`DSTK`) and `03-SYSVARS.md` (the `FORTH`
group: `SP0`/`RP0`/`HERE`/`LATEST`/`BASE`/`STATE`/`SP`/`RP`). Cross-checked
against a real, working, test-verified reference implementation, but
**not constrained by it** — see §2 for why that distinction matters and
where this document deliberately recommends a smaller kernel than that
reference currently ships.

## 1. Purpose and scope

This specifies the token-threaded Forth engine itself: the dictionary
entry format, the dispatch mechanism, the outer interpreter (tokenizer
and compile/interpret split), the minimum set of primitives a
conformant kernel must implement natively, and the bootstrap Forth
source layer that builds the rest of a usable system on top of that
minimum.

It does not specify:

- Anything HAL-boundary-shaped (`01-HAL.md`) — this document names
  which primitives call through to the HAL, not the HAL functions
  themselves.
- Memory/bank/cell layout (`02-MEMORY-MODEL.md`) or sysvar layout
  (`03-SYSVARS.md`).
- A finished numeric exception/error-code (`THROW`/`CATCH`) design —
  genuinely open, §8.

## 2. Design principle: minimum native kernel, not maximum

### 2.1 Why this needs saying explicitly

A real, working reference implementation of this system currently ships
**133 native primitives**. Cross-referencing that implementation's own
design history against itself surfaces something worth stating plainly:
its own governing design document (predating this specification)
already drew a **`CORE`/`STANDARD-for-now`** distinction — `CORE` words
needing genuinely native support, and `STANDARD-for-now` words that are
*mechanically derivable* from `CORE` words but were shipped as native
primitives anyway, for one specific, explicitly temporary reason: no
mechanism existed yet to load a body of Forth source at boot, before an
interactive session starts. That reference implementation has since
built exactly that mechanism (a boot-loaded Forth-source file already
defines several dictionary-manipulation words — `WORDS`, `SEE`, `HIDE`,
`FORGET`, `VOCABULARY`, `USE` — entirely in Forth, with zero engine
changes). **The blocker that justified a 130-primitive kernel is gone.**
This document is the actual word-by-word reckoning that follow-through
deserves: which primitives are genuinely irreducible, and which should
move to the bootstrap layer now that there's somewhere for them to move
to.

### 2.2 Classification used throughout §6

Every word in this document's primitive catalog is marked:

- **KERNEL** — must be a native, target-implemented primitive.
- **BOOTSTRAP** — must exist and behave exactly as specified, but as an
  ordinary Forth-source definition (built from KERNEL words), loaded at
  boot (§7) rather than dispatched natively.

A word belongs in KERNEL only if at least one of these holds:

1. It mutates the inner interpreter's instruction pointer or the return
   stack in a way no ordinary primitive dispatch can express (§4) —
   `LIT`, `EXIT`, `BRANCH`, `0BRANCH`, `(DOES>)`, `(SLIT)`, the loop
   runtime words.
2. It requires direct access to the host/target boundary (§1's HAL
   functions, or true host state like elapsed time) — screen, keyboard,
   storage, everything in `01-HAL.md`.
3. It requires direct compiler-state or raw-input-parsing access that
   the ordinary stack-effect primitive interface doesn't expose —
   consuming a raw name/text token directly from the current input
   line (§5.3), writing a dictionary header, or reading/writing `HERE`/
   `LATEST` as addresses rather than values.
4. It is the true minimal orthogonal basis other words are defined in
   terms of, and has no meaningful "derive it from something smaller"
   answer — `DUP`, `DROP`, `SWAP`; `>R`/`R>`/`R@`; the core arithmetic/
   comparison/bitwise ops.

Everything else is BOOTSTRAP, **regardless of whether a derivation is
convenient to write** — the point isn't code golf, it's that the
*correctness contract* lives in a portable Forth-source reference
definition, not in per-target native code that a new target would
otherwise have to reimplement and re-verify from scratch.

### 2.3 BOOTSTRAP is a floor, not a ceiling

**A target MAY implement any BOOTSTRAP-classified word natively for
performance, as long as its observable behavior matches the Forth-source
reference definition exactly.** This document fixes correctness and
behavior via that reference definition; it does not forbid a faster
native implementation underneath on a target where, say, `2DUP` being a
threaded call instead of two inlined stack ops is measurably worth
avoiding. What it does forbid is a target *skipping* the reference
definition's behavior on the theory that "it's just bootstrap, it
doesn't matter" — a target with no native fast-path MUST still provide
the word, correctly, by loading the bootstrap source. This is exactly
the same shape real production Forth systems already use: hundreds of
words with a standard Forth-source definition also get a native
fast-path in serious implementations, without that fast-path becoming
part of the *portable* contract.

### 2.4 The headline number

Applying §2.2's test to the full 133-word reference vocabulary (§6;
130 plus the `WARM`/`COLD` reset words, §6.12, plus `REDRAW`, §6.9,
added after this catalog's first pass) reclassifies **54 of them as
BOOTSTRAP** — everything from stack shufflers (`OVER`, `ROT`, `2DUP`,
`NIP`, `TUCK`, …) to, more significantly, **the entire
structured-control-flow compiler layer**
(`IF`/`ELSE`/`THEN`/`BEGIN`/`UNTIL`/`WHILE`/`REPEAT`/`DO`/`LOOP`/
`+LOOP`/`RECURSE`/`I`/`J`), **`VARIABLE`/`CONSTANT`**, and — once a
target already has `SP0`/`SP!`/`RP0`/`RP!` for `DEPTH`/`PICK`/`I`/`J`
anyway (§6.10) — **`WARM`** itself, all fully expressible from lower
primitives that already exist. That leaves a 79-word native kernel
before §6.13's addendum — see §6 for the full, word-by-word table,
§6.5/§6.6 for the two highest-value derivations, and §6.12/§4.6 for why
`COLD`, unlike `WARM`, has no such shortcut.

### 2.5 The outer interpreter itself is not exempt

§2.1–§2.4 reduce the compiler layer built *on top of* dispatch and
number-parsing. They do not touch dispatch and number-parsing
themselves — as first drafted, this catalog's outer interpreter
(tokenizing, dictionary search, number conversion) is engine-internal
behavior with no dictionary presence at all, the one part of a classic
fig-Forth/Forth-79 system this document had not yet reduced. §6.13
closes that gap: `WORD`, `FIND`, `NUMBER`, and `INTERPRET` itself
**MUST** be ordinary dictionary words — three of them BOOTSTRAP — built
from primitives §6 already establishes, and `:`, `;`, `IMMEDIATE`
**MUST** carry genuine dictionary entries rather than being invisible
outer-interpreter syntax (§5.2, revised). This is not optional polish:
it is what makes the interpreter itself inspectable, redefinable, and
traceable through the same mechanisms (`WORDS`, `SEE`, `'`,
breakpoints, §4.5) that already apply to every other word in the
system — matching the self-hosting property classic fig-Forth/Forth-79
actually had for this specific layer, which this document's first pass
did not.

Folding §6.13 in: the reference vocabulary is **143 words**, of which
**84 are required-native KERNEL** and **59 are BOOTSTRAP**. `'` was
considered for the same KERNEL→BOOTSTRAP move `FIND`/`NUMBER`/
`INTERPRET` make, but stays KERNEL (§6.10): §6.5's control-flow layer
needs `'` to resolve `BRANCH`/`0BRANCH`/`(DO)`/`(LOOP)`/`(+LOOP)`'s own
tokens by name before any Forth-level loop construct exists — and
`FIND`, the word a BOOTSTRAP `'` would be built from, itself needs a
loop construct from that same control-flow layer to compile its own
comparison loop. Moving `'` to BOOTSTRAP would make the first thing
the bootstrap loader needs depend on the last thing it can build; kept
native, that cycle never opens.

---

## 3. Dictionary header layout

Every dictionary entry — boot-registered primitive or user
colon-definition alike — shares one layout:

| Field | Size | Contents |
|---|---|---|
| Link Pointer (LFA) | 4 bytes | Offset of the previous entry; `0` = end of chain. |
| Flags + Length (NFA start) | 1 byte | Bit 7 `IMMEDIATE`, bit 6 `HIDDEN`, bit 5 `COMPILE-ONLY`, bits 4–0 name length (`0`–`31`). |
| Name | *N* bytes | ASCII, **case-insensitive** — canonicalized to uppercase at both definition and lookup time, so a target's tokenizer and dictionary never need a separate case-folding pass at the comparison site. Zero-padded so the Code Field starts 4-byte aligned. |
| Code Field (CFA) | 4 bytes | A token ID: a primitive (§4), or one of the reserved sentinels `DOCOL`/`DOVAR`/`DODOES` (§4.2). |
| Parameter Field (PFA) | variable | Present for `DOCOL`/`DODOES`-coded entries: a list of further token/XT cells, or raw inline data (a literal, a string). |

**Alignment applies to the whole entry**, not just the name — the
*next* entry's Link Pointer must also land 4-byte aligned, so an
entry's total size (link + flags/length byte + name + padding) is
rounded up to a cell boundary before the Code Field begins
(`align4`, `02-MEMORY-MODEL.md` §2).

**Chain walk**: dictionary lookup starts at `LATEST` and follows Link
Pointers toward `0`. A `HIDDEN` entry is invisible to lookup and to any
dictionary-walking word (`WORDS`, §7) — skipped, not matched. On a name
collision, the **most recently defined** entry wins (the chain walk
finds it first) — this is what lets a word be redefined by simply
defining a new one with the same name; the old entry still exists and
is still reachable by address (`RECURSE`, §6.5), just no longer found
by name.

`COMPILE-ONLY` (bit 5) gates a word so the outer interpreter rejects
using it while interpreting (`STATE = 0`) — needed for control-flow
words (§6.5) that only make sense inside a colon-definition; using one
outside `:`...`;` is a compile-time-only construct with no sensible
interpret-time meaning, not merely discouraged.

`31` characters is the maximum name length (5-bit length field). No
mechanism accommodates longer names.

---

## 4. Token-threaded dispatch

### 4.1 Token space

Every dictionary entry's Code Field holds a token ID:

- **Token IDs `1..N`** are native primitives (§6), dispatched directly.
- **`DOCOL`** (a single reserved sentinel value, conventionally `0`) —
  the Parameter Field is a list of further token/XT cells; executing
  this entry means "thread through the Parameter Field," §4.3.
- **`DOVAR`** — the entry was made by `CREATE` (directly, or via
  `VARIABLE`) and has not had `DOES>` applied. Executing it pushes the
  address of its Parameter Field, **past a reserved leading cell**
  (below), and returns — no threading.
- **`DODOES`** — the entry was made by `CREATE`...`DOES>`. Its
  Parameter Field's leading cell holds a "does-pointer": the address of
  the Forth code that runs whenever this word executes. Executing it
  pushes the Parameter Field address *past* that leading cell (the
  word's own data), then threads into the code at the does-pointer,
  exactly like `DOCOL` threading into a Parameter Field.

**Every `CREATE`d entry, `DOVAR`- or `DODOES`-coded, reserves one
leading Parameter Field cell for the does-pointer**, whether or not
`DOES>` is ever actually applied to it — paid uniformly at `CREATE`
time (a plain `CREATE`d word that's never `DOES>`'d just carries one
permanently-unused cell) rather than needing two different runtime
shapes depending on information not yet known when `CREATE` runs.

**A fourth sentinel, `DOCON` (a dedicated "this is a constant, its one
Parameter Field cell is the value" Code Field), is a real design option
some implementations add — this specification does not include it.**
`CONSTANT` is fully expressible via `CREATE`...`DOES> @` (§6.6) once
`DOVAR`/`DODOES` exist, at the cost of one extra threading step per
constant read versus a dedicated fourth sentinel's direct dispatch.
Given constants are read, not computed in a hot loop, that cost is not
worth a fourth Code-Field case threaded through every place this
specification's dispatch/breakpoint/decompile mechanisms already have
to special-case `DOCOL`/`DOVAR`/`DODOES` — one fewer sentinel is a real,
if modest, kernel-surface reduction. A target MAY add `DOCON` back as a
pure performance optimization (§2.3) as long as `CONSTANT`'s observable
behavior is unchanged.

### 4.2 The threading loop

Executing a `DOCOL`- or `DODOES`-coded entry means: push a return
sentinel onto the return stack, set an instruction pointer (`ip`) to
the start of the relevant Parameter Field (or the stored does-pointer),
then loop:

1. Read the cell at `ip`, call it `slotXt`; advance `ip` by one cell.
2. Read the Code Field at `slotXt`.
3. Dispatch on it:
   - `LIT` — push the cell at `ip` onto the data stack; advance `ip`
     by one cell.
   - `EXIT` — pop `ip` from the return stack. (Popping the original
     return sentinel ends the loop.)
   - `BRANCH` — set `ip` to the cell at `ip` (an unconditional jump).
   - `0BRANCH` — pop a flag; if `FALSE`, behave like `BRANCH`;
     otherwise skip the target cell (`ip += 1 cell`) and continue.
   - `(SLIT)` — read a length cell at `ip`, advance `ip` past it; push
     `(ip, length)` as a string's `addr len` (the bytes live right
     there, inline); advance `ip` past the (cell-aligned) byte run.
   - `(DOES>)` — rewrite `LATEST`'s own Code Field to `DODOES` and store
     the *current* `ip` (already past this slot — exactly the code that
     followed `DOES>` in the definition being compiled) as its
     does-pointer; then behave like `EXIT`.
   - `DOCOL`/`DODOES` — recurse into §4.2 itself: push `ip` (the return
     address) onto the return stack, set `ip` to the new Parameter
     Field/does-pointer start, continue the *same* loop (not a nested
     native call — see §4.4).
   - `DOVAR`/`DODOES`-as-a-slot (i.e. this slot itself is a `CREATE`d
     word being *referenced*, not called through `DOCOL`) — same
     "push address past the reserved cell" behavior as top-level
     execution (§4.1).
   - Anything else — an ordinary primitive token: dispatch it (§6),
     with the one exception in §4.3.

`LIT`, `EXIT`, `BRANCH`, `0BRANCH`, `(SLIT)`, `(DOES>)` **MUST NOT** be
reachable through any path except this loop — a target executing one of
these tokens directly (top-level, not as a threaded slot) has
encountered malformed compiled data and should treat it as an error,
not attempt to define a meaning for it.

### 4.3 Primitives that need loop-local access

`KEY` is dispatched specially, not because its own behavior differs,
but because of *when* it may need to suspend (§4.4): a conformant
dispatcher checks whether the bound input channel (`01-HAL.md` §5) has
data available *before* running `KEY`'s own body, and if not, suspends
the whole interpreter rather than running `KEY` to a "no data"
failure. `KEY` itself, once dispatched, is an ordinary primitive with no
special access to `ip`.

### 4.4 The suspension contract — deliberately target-agnostic

**The threading loop's only loop-local state is `ip`** (plus whatever
the return stack already holds) — this is a deliberate consequence of
§4.2 threading via an explicit loop rather than native-language
recursion for `DOCOL`/`DODOES`. That choice is what makes the following
requirement satisfiable on every target, not just one with
coroutine/generator support:

**A conformant target's interpreter MUST be able to suspend at a
blocking `KEY` dispatch point (`01-HAL.md` §5.5) and resume later
without re-executing any already-completed step, using only `ip` and
the return/data stack contents as the state that needs to survive the
suspension.** This document does not mandate *how* a target implements
that suspension — a generator/coroutine yielding at defined points, an
RTOS task blocked on a synchronization primitive tied to the channel's
non-empty condition, or a hand-written state machine explicitly
re-entered by a driving loop are all valid, and are genuinely
target-specific implementation choices (`01-HAL.md` §5.5, §9). What is
*not* a target-specific choice is the underlying structural requirement
that makes any of those mechanisms possible: `DOCOL`/`DODOES` threading
through an explicit `ip` + return-stack loop, never through the host
language's own native call/return stack. A target that threads nested
word calls via native recursion has no portable way to suspend a call
several levels deep and resume it later — that path is closed off
before a blocking `KEY` is ever reached.

A target's outer/driving loop should also be able to run the
interpreter incrementally (a bounded number of steps at a time) rather
than only to completion, so a long-running or currently-blocked Forth
computation doesn't prevent other target responsibilities (rendering, a
scheduler's other tasks) from getting a turn — but the exact API shape
for that (a step budget, a cooperative yield, an interrupt-driven
preemption point) is, again, target-specific and not specified here.

### 4.5 Optional: word-level breakpoints

A target MAY implement word-level breakpoints (pause execution right
before a specific `DOCOL`/`DODOES`-coded word's body runs, resumable the
same way a blocked `KEY` is) as a debugging aid, reusing exactly the
suspension mechanism §4.4 already requires — checked once per entry
into a compiled word's body, keyed by a session-local set of addresses,
never persisted as dictionary state. This is **not** part of the
portable conformance surface — a target without it is not
non-conformant — but where a target does implement it, reusing the
existing suspend point rather than inventing a second mechanism is
strongly RECOMMENDED, since one interpreter re-entrancy model
(§4.4) is simpler to get right than two.

### 4.6 `COLD`: ending the session, not suspending it

`COLD` (§6.12) is dispatched specially for a different reason than
`KEY`/`ACCEPT` (§4.3, §6.9): it is not a suspend point to resume later —
it is a **terminal** signal that the entire current interpreter session
must end and be replaced by one equivalent to a fresh boot, not merely
paused.

**Dispatching `COLD` MUST result in the dictionary (`DICT`), bank
layout (`MMAP`), both stacks, and every sysvar being reinitialized
exactly as they would be at a fresh boot, before the next line of
Forth source is interpreted.** This document does not mandate *how* —
the two valid shapes mirror §4.4's own target-agnostic framing:

- A target whose core interpreter state is genuinely reinitializable in
  place (a bare-metal target simply re-running its own boot routine
  against the same resident RAM, the same way a real power-on reset
  works) MAY implement `COLD` as an ordinary primitive that performs
  that reinitialization directly, returning control to the now-fresh
  outer interpreter itself.
- A target whose implementation makes in-place reinitialization
  impractical (core interpreter state established once, immutably, at
  process startup, say) MAY instead implement `COLD` as a signal that
  unwinds the current interpreter session entirely and hands control to
  a supervising boot routine — the same one a genuine first boot already
  runs — to construct a replacement from scratch.

From the perspective of the next line of Forth source, the two are
indistinguishable; which one a target uses is an artifact of that
target's own implementation language and runtime, not a cross-target
requirement (`01-HAL.md` §5.5's treatment of the suspension mechanism
is the direct precedent for this framing).

**Either way, `COLD` reduces the dictionary to its fresh-boot state —
every bootstrap-layer word (§7) is gone immediately afterward**, `WARM`
(§6.12) included, since it's one of them. A conformant target's
post-`COLD` sequence MUST re-run the same bootstrap load (§7.1) a
genuine power-on boot runs — not merely restart the interactive prompt
against a dictionary that currently has nothing in it past the native
KERNEL words.

---

## 5. The outer interpreter

### 5.1 Structure

The outer interpreter tokenizes one line of input (whitespace-delimited,
case-insensitive, §3) and, per token, either **executes** it
(`STATE = 0`, interpreting) or **compiles** a call/literal into the
definition currently under construction (`STATE ≠ 0`, compiling) — the
classic Forth text-interpreter loop, driven entirely by the `FORTH`
sysvar group's `STATE` field (`03-SYSVARS.md` §11).

### 5.2 `:`, `;`, `IMMEDIATE` are ordinary dictionary words

**`:`, `;`, and `IMMEDIATE` MUST be native KERNEL primitives with
genuine dictionary entries** — findable via `FIND`/`'` (§6.13), listed
by `WORDS` (§7.2), subject to the same `HIDDEN`-skipping chain walk as
any other entry (§3). They are KERNEL, not BOOTSTRAP, for the same
reason `CREATE` and `DOES>` are (§6.6 rule 1/3): they need direct
access to compiler state (`HERE`/`LATEST`/`STATE`) and raw-token
consumption (§5.3) in a shape no ordinary primitive's stack-effect
interface expresses. What changes from a prior draft of this
specification is *not* their classification — it is that they **MUST
NOT** be special-cased by string comparison inside `INTERPRET` (§5.6,
§6.13). `INTERPRET` dispatches them through the exact same
`FIND`-then-execute-or-compile path as every other word, distinguished
only by ordinary dictionary properties (the `IMMEDIATE` flag, and each
word's own internal `STATE` precondition check) — never by matching
their spelling as a special token before `FIND` is consulted.

- `:` — **only valid while interpreting**; a conformant definition
  MUST check `STATE` itself and error if invoked while compiling, since
  nothing external gates this once dispatch is uniform. Reads the next
  raw token as the new word's name, writes its dictionary header
  immediately (linked in right away, so `HERE`/`LATEST` reflect it at
  once), marks it `HIDDEN` (so it can't be found/called
  mid-compilation — this is exactly the gap `RECURSE`, §6.5, exists to
  work around), and switches to compiling. `:` itself is **not**
  `IMMEDIATE` — it runs at ordinary interpret time, the same as any
  other word `INTERPRET` looks up while `STATE = 0`.
- `;` — **only valid while compiling**; MUST check `STATE` itself and
  error otherwise. Compiles a trailing `EXIT` call, clears the `HIDDEN`
  flag, switches to interpreting. `;` **MUST** carry the `IMMEDIATE`
  flag — `INTERPRET`'s compiling-mode dispatch rule (§5.4) is what
  causes it to run rather than compile as a call, and that rule has no
  special case for `;`'s spelling; the flag is the only thing that
  makes it work.
- `IMMEDIATE` — **only valid immediately after a `:`...`;` pair
  completes**, while interpreting; sets the `IMMEDIATE` flag (§3) on
  `LATEST`. Not itself `IMMEDIATE` — it is always typed and executed
  directly at the prompt, never compiled into another definition.

### 5.3 The shared input cursor

Several words (`CREATE`, `VARIABLE`, `CONSTANT`, `S"`, `.`", `(`, `'`,
`BANK@`, `CREATE-BANK`, `PROJECT`, `RESTORE`, `BSAVE`, `BLOAD`, §6) need
to consume the *next raw token* directly from whatever line is
currently being interpreted — not through dictionary lookup, a literal
piece of text (a name, a quoted string) that has no business being
looked up as a word at all.

**This consumption mechanism MUST itself be exposed as an ordinary
KERNEL word, `WORD`** (§6.13) — not merely used internally by the
native words listed above. `INTERPRET` (§5.6, §6.13) is itself a
consumer of `WORD`, and every other raw-token-consuming word in this
document MAY be understood as a thin wrapper around `WORD` plus its own
subsequent handling of the returned text (a header write for `CREATE`,
a delimiter-matched multi-token read for `S"`/`(`, a dictionary search
for `'`).

**This MUST be a cursor shared across the whole current line, not a
value local to whichever word's own execution is consuming it** — a
word like `CREATE`, invoked from *inside* another word's execution
(the classic `: CONST CREATE , DOES> @ ;` pattern), must consume its
name from `CONST`'s **caller's** line (e.g. `5 CONST FIVE` — `CREATE`
needs `FIVE`, not anything from `CONST`'s own compiled body). A target
implementing this as a per-call local variable instead of one shared
position over the actual input line will misbehave the moment a
name-consuming word is used from inside a colon-definition rather than
typed directly at the prompt.

**Two different consumption patterns follow from this, and conflating
them is the mistake to avoid.** A defining/utility word invoked
*interactively* (`CREATE`, `VARIABLE`, `CONSTANT`, `BANK@`,
`CREATE-BANK`, `PROJECT`, `RESTORE`, `BSAVE`, `BLOAD`, `'` itself, and
§7.2's `SEE`/`HIDE`/`FORGET`) is correctly **not** `IMMEDIATE` — it's
meant to consume from whatever line is live *when it runs*, which is
exactly the caller's own line, whether that word was typed directly or
reached through any number of ordinary deferred calls (the `CONST`/
`FIVE` example above). A word whose raw text is meant to be **baked
into the definition that contains it** (`S"`, `."`, `(`, and the
`…-XT`-resolving use of `'` in §6.5's control-flow layer) needs the
opposite: it must run at *that containing definition's own compile
time*, which requires `IMMEDIATE` — deferred, it would instead consume
text from whatever line later calls the containing word. §6.5's note
and §6.7's `S"`/`."`/`(` rows have the worked-through reasoning.

### 5.4 Number parsing

A token not found in the dictionary is tried as a number in the current
`BASE` (§3's `03-SYSVARS.md` `FORTH.BASE` field): an optional leading
`-`, then one or more digits valid in that base. Failing both lookup
and number parsing is an error (`unrecognized word`), not a silent
no-op.

- **Interpreting**: a recognized word executes immediately (error if
  it's `COMPILE-ONLY`, §3); a valid number is pushed.
- **Compiling**: a recognized `IMMEDIATE` word executes immediately
  (even while compiling — this is the mechanism every control-flow
  word in §6.5 depends on); a recognized non-`IMMEDIATE` word has its
  XT compiled as a call; a valid number is compiled as `LIT` followed
  by its literal cell value.

**This entire section is a behavioral contract, not a description of
bespoke engine logic.** §5.6 and §6.13 specify `WORD`, `FIND`, and
`NUMBER` as the ordinary dictionary words that realize it, and
`INTERPRET` as the ordinary (BOOTSTRAP) dictionary word whose body
implements the interpreting/compiling branch above. A conformant target
MUST satisfy this section's contract by providing those words with
these exact observable behaviors — not by keeping the tokenize/dispatch
logic native and un-exposed, which was this document's own prior
draft and is superseded by §6.13.

### 5.5 Error recovery mid-compilation

An error thrown while a definition is under construction (`STATE ≠ 0`)
**MUST** roll back the half-built entry before control returns to a
clean interpreting state: reclaim its `DICT` space (`HERE` back to the
aborted entry's own address) and restore `LATEST` to what it linked
from. This applies uniformly regardless of a target's native
error-propagation mechanism (an exception, a longjmp, an error-return
code checked at every call site) — whatever that mechanism is, it MUST
route through this rollback before the outer interpreter is ready for
its next line. A target that skips this leaves a `HIDDEN`,
un-rollbacked partial entry sitting in `DICT` forever, corrupting
`HERE`/`LATEST` bookkeeping for everything defined afterward.

### 5.6 `INTERPRET` is a BOOTSTRAP dictionary word

**§5.1–§5.4's outer-interpreter contract MUST be realized as an
ordinary BOOTSTRAP word named `INTERPRET`**, built from `WORD`, `FIND`,
`NUMBER`, `STATE`, `EXECUTE`, and `,` (§6.13 gives the full
derivation). A conformant target's actual driving loop — the
native-level equivalent of classic Forth's `QUIT` — is reduced to:
read a line into the input buffer, reset the shared cursor (§5.3), call
`INTERPRET`, repeat. `INTERPRET` itself contains none of that outer
housekeeping and no target-specific I/O; it is portable Forth source
loaded like every other BOOTSTRAP word (§7.1), identical across
Rebel-Sim, Rebel-ROM, and Rebel-Board.

**This changes *where*, not *whether*, §5.5's rollback obligation is
discharged.** Once `INTERPRET` is Forth-threaded rather than the native
driving loop itself, an error raised inside it (via `ABORT`, §8) MUST
unwind out through the threading mechanism §4.4 already specifies for
suspension — not through a native-language stack unwind — before the
still-native `QUIT`-equivalent performs the `DICT`/`HERE`/`LATEST`
rollback. §8's `ABORT` contract already commits to this ("whatever that
mechanism is, it MUST route through this rollback"); this section
records the specific new case that contract now has to cover, the same
way §4.6 records `COLD`'s analogous obligation. No new mechanism is
introduced — `INTERPRET` becoming BOOTSTRAP composes with mechanisms
this document already requires elsewhere.

**Load-order requirement**: `INTERPRET` MUST be the last BOOTSTRAP word
loaded in §7.1's sequence, since it is the first point at which the
bootstrap loader's own line-by-line reading MAY switch from whatever
native fallback mechanism loads the bootstrap file itself to `INTERPRET`
proper. §6.13 gives the full ordering constraint across `WORD`, `FIND`,
`STATE`, `[`, `]`, `'`, `NUMBER`, and `INTERPRET`.

---

## 6. The primitive catalog

Stack effects use standard notation (`( before -- after )`,
`x`/`n`/`u`/`addr`/`flag` as in `CORE-VOCABULARY.md`'s own convention:
`n` signed, `u` unsigned, `flag` the HAL boolean convention `TRUE=-1`/
`FALSE=0`). **KERNEL**/**BOOTSTRAP** per §2.2; a BOOTSTRAP row gives
either its exact reference Forth-source definition (where the
derivation itself is the finding worth showing) or the words it's
trivially built from.

### 6.1 Stack manipulation

| Word | Effect | | Definition (if BOOTSTRAP) |
|---|---|---|---|
| `DUP` | `( x -- x x )` | **KERNEL** | — |
| `DROP` | `( x -- )` | **KERNEL** | — |
| `SWAP` | `( a b -- b a )` | **KERNEL** | — |
| `OVER` | `( a b -- a b a )` | BOOTSTRAP | `: OVER >R DUP R> SWAP ;` |
| `ROT` | `( a b c -- b c a )` | BOOTSTRAP | `: ROT >R SWAP R> SWAP ;` |
| `-ROT` | `( a b c -- c a b )` | BOOTSTRAP | `: -ROT ROT ROT ;` |
| `2DUP` | `( a b -- a b a b )` | BOOTSTRAP | `: 2DUP OVER OVER ;` |
| `2DROP` | `( a b -- )` | BOOTSTRAP | `: 2DROP DROP DROP ;` |
| `2SWAP` | `( a b c d -- c d a b )` | BOOTSTRAP | classic ANS derivation via `ROT`/return-stack; more intricate than the others here — verify against a reference ANS Forth definition rather than re-deriving casually. |
| `2OVER` | `( a b c d -- a b c d a b )` | BOOTSTRAP | same caveat as `2SWAP`. |
| `NIP` | `( a b -- b )` | BOOTSTRAP | `: NIP SWAP DROP ;` |
| `TUCK` | `( a b -- b a b )` | BOOTSTRAP | `: TUCK SWAP OVER ;` |
| `?DUP` | `( x -- x x \| x )` | BOOTSTRAP | `: ?DUP DUP IF DUP THEN ;` |
| `DEPTH` | `( -- n )` | BOOTSTRAP | `: DEPTH SP0 SP@ - 4 / ;` — needs `SP0`/`SP@` (§6.10), both themselves KERNEL. |
| `PICK` | `( xu…x0 u -- xu…x0 xu )` | BOOTSTRAP | `: PICK CELLS SP@ + @ ;` — the data stack is ordinary arena memory (`DSTK`, `02-MEMORY-MODEL.md`); `PICK` is nothing more than indexed access into it via `SP@`. |
| `ROLL` | `( xu…x0 u -- xu-1…x0 xu )` | BOOTSTRAP, low priority | Expressible via `SP@`-based memory shuffling the same way `PICK` is, but the multi-cell shift is genuinely more intricate to get right by hand. Reasonable for a target to keep this one native pending a verified bootstrap definition, rather than ship an untested hand-derivation. |

### 6.2 Arithmetic, comparison, bitwise

| Word | Effect | | Definition (if BOOTSTRAP) |
|---|---|---|---|
| `+` `-` `*` | `( a b -- a±b / a*b )` | **KERNEL** | Map to single hardware instructions on every named target; no derivation is smaller or faster. |
| `/` `MOD` | `( a b -- quot )` / `( a b -- rem )` | **KERNEL** | Both do real division work; keeping both native avoids computing a division twice for the common single-result case. |
| `/MOD` | `( a b -- rem quot )` | BOOTSTRAP | `: /MOD 2DUP MOD -ROT / ;` — computes the division twice (once via `MOD`, once via `/`). A target with a genuine combined-divmod hardware instruction MAY implement this natively instead (§2.3) — this is exactly the kind of word this document expects a real target to reconsider once it knows its own hardware. |
| `AND` `OR` `INVERT` | bitwise | **KERNEL** | Map to single hardware instructions. |
| `XOR` | `( a b -- a^b )` | **KERNEL**, borderline | Derivable from `AND`/`OR`/`INVERT` (`(a AND (INVERT b)) OR ((INVERT a) AND b)`), but every named target has a native XOR instruction and the boolean-algebra derivation is needlessly indirect for something this fundamental. Kept native on the strength of §2.2 rule 4, not rule 1–3. |
| `=` `<` `>` `0=` | comparisons | **KERNEL** | The minimal comparison basis everything else in this section derives from. |
| `<>` | `( a b -- flag )` | BOOTSTRAP | `: <> = INVERT ;` — valid specifically because `=` only ever produces `TRUE`(`-1`)/`FALSE`(`0`), so bitwise `INVERT` is exactly logical negation here. |
| `0<` `0>` | `( n -- flag )` | BOOTSTRAP | `: 0< 0 < ;`  `: 0> 0 > ;` |
| `U<` | `( a b -- flag )` unsigned | **KERNEL**, borderline | Derivable via the classic sign-bit-XOR trick (`a MIN_INT XOR` vs `b MIN_INT XOR`, then signed `<`), but unsigned comparison is fundamental enough (memory-range checks, `WITHIN`) and the trick non-obvious enough that native is the safer default (§2.2 rule 4). |
| `1+` `1-` `2+` `2-` `2*` | `( n -- n±1/±2/×2 )` | BOOTSTRAP | `: 1+ 1 + ;` and so on; `2* = DUP +` (exact for any sign, unlike a division-based doubling). |
| `2/` | `( n -- n/2 )`, **arithmetic shift right**, not truncating division | **KERNEL**, flagged | Not equal to `2 /`'s truncate-toward-zero behavior for negative odd inputs (`-3 2/` is `-2`; `-3 2 /` is `-1`) — a real, easy-to-get-wrong divergence. This specification's primitive set has no general bit-shift word (`LSHIFT`/`RSHIFT`) at all today; **recommend adding both as KERNEL** (single hardware instructions, and a real gap for any future bit-manipulation word) and redefining `2/` as `: 2/ 1 RSHIFT ;` once available — noted as a recommendation for the next revision of this catalog, not retroactively assumed here. |
| `NEGATE` | `( n -- -n )` | BOOTSTRAP | `: NEGATE 0 SWAP - ;` |
| `ABS` | `( n -- \|n\| )` | BOOTSTRAP | `: ABS DUP 0< IF NEGATE THEN ;` |
| `MIN` `MAX` | `( a b -- min/max )` | BOOTSTRAP | `: MIN 2DUP > IF SWAP THEN DROP ;` and the `<` mirror for `MAX`. |
| `WITHIN` | `( n lo hi -- flag )` | BOOTSTRAP | Classic ANS derivation: `OVER - >R - R> U<` — a real showcase of why `U<` earns its native slot (rule 4): the unsigned-wraparound trick this relies on is exactly the kind of thing worth having one correct, native primitive for rather than every derived word re-deriving it. |

### 6.3 Memory access

| Word | Effect | | Definition (if BOOTSTRAP) |
|---|---|---|---|
| `@` `!` `C@` `C!` | cell/byte fetch/store | **KERNEL** | The literal foundation everything else in this document reads/writes through. |
| `+!` | `( n addr -- )` | BOOTSTRAP | `: +! DUP @ ROT + SWAP ! ;` — already identified as derivable in this project's own design history; carried forward here as settled, not a new finding. |
| `CELLS` | `( n -- n×4 )` | BOOTSTRAP | `: CELLS 4 * ;` — `4` is a true constant here (`02-MEMORY-MODEL.md`'s cell size is fixed at 4 bytes on every target, not something to abstract over). |
| `CELL+` | `( addr -- addr+4 )` | BOOTSTRAP | `: CELL+ 4 + ;` |
| `FILL` | `( addr len char -- )` | BOOTSTRAP | A loop over `C!` using `DO`/`LOOP` (§6.5) and `I`. |
| `CMOVE` | `( addr1 addr2 len -- )` | BOOTSTRAP | A loop over `C@`/`C!`. Low-to-high, overlapping-range corruption is a documented footgun inherited from the reference behavior, not something a Forth-source loop changes. |

### 6.4 Return stack

| Word | Effect | |
|---|---|---|
| `>R` | `( x -- )` `( R: -- x )` | **KERNEL** |
| `R>` | `( -- x )` `( R: x -- )` | **KERNEL** |
| `R@` | `( -- x )` `( R: x -- x )` | **KERNEL** |

The foundation §6.1's `OVER`/`ROT` derivations (among others) build on.
**Implementation warning, inherited from classic Forth, not new here:**
a word that does `>R` without a matching `R>` before it returns
corrupts its own return address.

### 6.5 Control flow — the flagship reduction

`BRANCH`/`0BRANCH` and the three loop-runtime words are the **only**
genuinely native control-flow primitives this specification requires.
**Every compile-time control-flow word — the ones a Forth programmer
actually types — is fully expressible in Forth source**, using only
`'` (tick, to resolve the five native words below into constants once,
at the top level — see the note below), `CONSTANT`, `,` (comma),
`HERE`, `SWAP`, and `!`. This is not a novel technique — it's how several
well-known minimal Forth kernels already structure this layer — but it
is a real, substantial reduction from a 13-primitive control-flow
surface to a 5-primitive one, and worth verifying word-by-word rather
than taking on faith:

| Word | Effect | |
|---|---|---|
| `BRANCH` | unconditional jump — read next cell as target `ip` | **KERNEL** |
| `0BRANCH` | pop a flag; jump like `BRANCH` if `FALSE`, else skip the target cell | **KERNEL** |
| `(DO)` | `( limit index -- )` `( R: -- index limit )` — push loop control onto the return stack | **KERNEL** |
| `(LOOP)` | `( -- flag )` `( R: index limit -- index' limit \| -- )` — increment, compare, leave a continue/done flag for the compiled `0BRANCH` to act on | **KERNEL** |
| `(+LOOP)` | as `(LOOP)`, incrementing by a popped value rather than `1` | **KERNEL** |

Reference bootstrap definitions for everything built on top (verified
by hand-tracing each against the dispatch semantics in §4.2 and the
reference primitive behavior they replace — not merely asserted).

**A correction from an earlier pass of this catalog**: these cannot use
inline `' WORDNAME ,` inside each `IMMEDIATE COMPILE-ONLY` word's own
body, tempting as that looks. `'` is not, and must not be, `IMMEDIATE`
itself (§6.10) — the reference bootstrap layer's actual `SEE` depends
on `'` staying an ordinary, deferred call: `SEE`'s own body opens with
a bare `'` that resolves *`SEE`'s own caller's* argument (`SEE FOO`
resolves `FOO`), exactly the shared-input-cursor behavior §5.3 already
specifies for `CREATE` used inside `CONSTANT`. Marking `'` `IMMEDIATE`
would fix the trace below but break `SEE`/`HIDE`/`FORGET` the same way,
since it would stop `'` from working as a deferred reference at all.

The actual requirement is narrower: each native word a control-flow
word needs to compile a call to must be resolved *once*, at the top
level (ordinary interpreting, where `'` always executes immediately
regardless of its own flag — §5.4), into a named `CONSTANT` — exactly
the pattern the reference bootstrap layer already uses for `LIT`
itself (`' LIT CONSTANT LIT-XT`, `system.fth`). The control-flow words
below reference those constants instead of `'` directly:

```forth
' BRANCH   CONSTANT BRANCH-XT
' 0BRANCH  CONSTANT 0BRANCH-XT
' (DO)     CONSTANT (DO)-XT
' (LOOP)   CONSTANT (LOOP)-XT
' (+LOOP)  CONSTANT (+LOOP)-XT

: IF     0BRANCH-XT , HERE 0 ,                 ; IMMEDIATE COMPILE-ONLY
: ELSE   BRANCH-XT , HERE 0 , SWAP HERE SWAP ! ; IMMEDIATE COMPILE-ONLY
: THEN   HERE SWAP !                           ; IMMEDIATE COMPILE-ONLY
: BEGIN  HERE                                  ; IMMEDIATE COMPILE-ONLY
: UNTIL  0BRANCH-XT , ,                        ; IMMEDIATE COMPILE-ONLY
: WHILE  0BRANCH-XT , HERE 0 ,                 ; IMMEDIATE COMPILE-ONLY
: REPEAT BRANCH-XT , SWAP , HERE SWAP !        ; IMMEDIATE COMPILE-ONLY
: DO     (DO)-XT , HERE                        ; IMMEDIATE COMPILE-ONLY
: LOOP   (LOOP)-XT , 0BRANCH-XT , ,            ; IMMEDIATE COMPILE-ONLY
: +LOOP  (+LOOP)-XT , 0BRANCH-XT , ,           ; IMMEDIATE COMPILE-ONLY
: I      RP@ @                                 ;
: J      RP@ CELL+ CELL+ @                     ;
: RECURSE LATEST >CFA ,                        ; IMMEDIATE COMPILE-ONLY
```

Why this version works where the inline one doesn't: `0BRANCH-XT` is an
ordinary, non-`IMMEDIATE` word (a `CONSTANT`), so the token `0BRANCH-XT`
inside `IF`'s own body compiles as a deferred call into `IF`'s *own*
Parameter Field — same as any other reference. When `IF` later runs
(because `IF` itself is `IMMEDIATE`, invoked while compiling some
caller word `FOO`), that deferred call executes *then*: it pushes
`0BRANCH`'s xt (a value resolved once, at bootstrap load time), and the
following `,` — also an ordinary deferred call — consumes it and
appends it into `FOO`'s body, which is exactly what `HERE` correctly
refers to at that moment. No token in this version is ever looked up
by name at `FOO`'s compile time; `'` runs only once per primitive,
at bootstrap load time, entirely at the top level.

Notes on the less-obvious lines:

- The `…-XT` constants **MUST** be loaded before this block, and
  `CONSTANT` (§6.6) before them — both have no dependency on this
  block itself, so either can load any time earlier.
- `IF`'s placeholder cell (written as `0`, patched later by `ELSE`/
  `THEN`) is left on the *data* stack as `HERE`'s value at the moment
  right after it was compiled — exactly the placeholder-patching
  technique §6 of `CORE-VOCABULARY.md` already specifies; this
  definition just performs it in Forth instead of native code.
- `I`/`J` read loop control directly out of `RSTK` as ordinary memory
  via `RP@`+`@` (peeking depth 0 and depth 2 respectively) — the same
  "the stack is just memory, addressed via its own pointer primitive"
  technique `PICK` (§6.1) uses for `DSTK`.
- `RECURSE` depends on `>CFA` (`entry-addr -- cfa`, computing a Code
  Field address from a dictionary entry address — itself a short,
  already-proven bootstrap word: `DUP 4 + C@ 31 AND SWAP 5 + + 3 + -4
  AND`, reading the flags byte, masking the name-length bits, and
  aligning) — **so `>CFA` MUST be defined before `RECURSE` in the
  bootstrap load order** (§7). `LATEST` correctly points at the
  still-`HIDDEN` word being compiled at the moment `RECURSE` runs
  (§5.2), so this reaches exactly the right entry. `RECURSE` doesn't
  use `'`/the `…-XT` constants at all, so it's unaffected by the
  correction above.
- Every `: WORDNAME ... ;` line above (not the `…-XT` `CONSTANT` lines,
  which are ordinary, callable-anywhere words) is marked
  `COMPILE-ONLY` (§3) — using any of them while interpreting is a
  compile-time-only construct with no interpret-time meaning, matching
  how the reference primitive implementations already gate them.

### 6.6 Defining words — the second flagship reduction

| Word | Effect | | |
|---|---|---|---|
| `HERE` | `( -- addr )` | **KERNEL** | Direct compiler-state read. |
| `LATEST` | `( -- addr )` | **KERNEL** | Direct compiler-state read. |
| `,` | `( x -- )` compile one cell | **KERNEL** | Direct compiler-state write. |
| `ALLOT` | `( n -- )` advance `HERE` by `n` | **KERNEL** | Direct compiler-state write. |
| `CREATE` | `( "name" -- )` | **KERNEL** | Needs raw name consumption (§5.3) + dictionary-header write — the one truly irreducible defining word. |
| `DOES>` | changes a `CREATE`d word's runtime behavior | **KERNEL** | `(DOES>)`'s IP-mutating runtime (§4.2) has no Forth-expressible equivalent. |
| `VARIABLE` | `( "name" -- )`, reserves one initialized-to-`0` cell | BOOTSTRAP | `: VARIABLE CREATE 0 , ;` |
| `CONSTANT` | `( x "name" -- )` | BOOTSTRAP | `: CONSTANT CREATE , DOES> @ ;` |

`CONSTANT`'s derivation is worth tracing once: `CREATE` reserves the
usual does-pointer cell; `,` compiles the popped value into the next
cell; `DOES> @` rewrites the Code Field to `DODOES` and sets the
does-code to "fetch and push the cell right after the does-pointer" —
i.e. exactly the value `,` just stored. Executing the resulting word
pushes that value. This is *behaviorally* identical to a dedicated
`DOCON` sentinel's direct dispatch (§4.1) at the cost of one extra
threading step per read — which is exactly why this specification
recommends dropping `DOCON` as a fourth sentinel entirely rather than
carrying it alongside a now-redundant bootstrap definition.

### 6.7 Strings

| Word | Effect | | |
|---|---|---|---|
| `S"` | `( "string" -- addr len )`, compile-time inline / interpret-time via scratch text | **KERNEL, IMMEDIATE** | Needs raw multi-token text consumption up to a closing delimiter (§5.3) — genuinely a parsing primitive, not a stack-effect one. **MUST carry `IMMEDIATE`**, for the same reason `'` must *not* (§6.5's note, §6.10): used inside another colon-definition (`: GREET S" HELLO" TYPE ;`), its text lives only in *that* definition's own source. A deferred (non-`IMMEDIATE`) `S"` would instead run at `GREET`'s own call time and consume text from whatever line calls `GREET` — `IMMEDIATE` is what makes it run at `GREET`'s own compile time instead, where "HELLO" actually is. |
| `."` | `( "string" -- )`, prints at compile *and* interpret time | **KERNEL, IMMEDIATE** | Same reason as `S"` — sugar for `S" ... TYPE` at compile time, direct emit at interpret time — and needs the same `IMMEDIATE` flag for the same reason. |
| `(` | `( -- )`, comment to matching `)` | **KERNEL, IMMEDIATE** | Same raw-consumption mechanism as `S"`, and the same reason it must carry `IMMEDIATE`: a `(` comment written inside a colon-definition's own source has to be consumed at that definition's own compile time, not deferred to whenever the definition is later called. Discarded, compiling or not — classic Forth behavior. **[Revised]** an earlier version of this row specified retaining the comment as compiled inline data so a decompiler (`SEE`) could still show it; Rebel-Sim shipped and then reverted that (M11, M44) once `SEE` proved unable to render it back as `( ... )` syntax at all — it printed indistinguishably from a genuine string a program discards on purpose, which defeated the entire point of retaining it. Does not nest — the first closing `)` always ends it, a documented limitation, not a bug. |
| `(SLIT)` | inline string-literal runtime | **KERNEL** | §4.2's IP-mutating dispatch. |
| `TYPE` | `( addr len -- )` | BOOTSTRAP | `: TYPE OVER + SWAP DO I C@ EMIT LOOP ;` — sets the loop's index to walk `addr..addr+len` directly (so `I` *is* the current address, no extra offset arithmetic needed). **Caveat**: classic `DO`/`LOOP` semantics execute the body at least once even when `index = limit` at entry — so `len = 0` prints one stray character under this definition. Either guard with `DUP 0= IF 2DROP EXIT THEN` up front, or keep `TYPE` native if that edge case matters more than the kernel-size reduction. |
| `BL` | the space character, `32` | not even a word — a `CONSTANT` | `32 CONSTANT BL` — this doesn't need a colon-definition at all; it's a bare literal with a name, exactly what `CONSTANT` (§6.6) is for. |
| `SPACE` | `( -- )`, emit one space | BOOTSTRAP | `: SPACE BL EMIT ;` |

### 6.8 Numeric output

| Word | Effect | | |
|---|---|---|---|
| `.` | `( n -- )`, print in current `BASE` | **KERNEL**, flagged for a future refactor | A real Forth system's usual layering puts pictured-numeric-output primitives (`<#`/`#`/`#S`/`#>`/`HOLD`/`SIGN`) at the true kernel boundary, with `.` (and `U.`, field-width variants, …) defined *in Forth* on top of them. This specification does not require that refactor now — it's a bigger structural change than the rest of this catalog — but records it as the recommended direction: adding that small primitive set and demoting `.` to BOOTSTRAP is a natural next revision, not a rejected idea. |
| `.S` | `( -- )`, non-destructive stack dump | BOOTSTRAP | A loop from `SP@` to `SP0` (or the reverse, depending on print order) printing each cell via `.` — the same "the stack is memory" technique `PICK`/`I`/`J` already use. |
| `BASE` | `( -- addr )` | **KERNEL** | Direct sysvar-cell address exposure, same pattern as `HERE-ADDR`/`LATEST-ADDR` (§6.10). |
| `HEX` `DECIMAL` | `( -- )` | BOOTSTRAP | `: HEX 16 BASE ! ;`  `: DECIMAL 10 BASE ! ;` |

### 6.9 Screen, keyboard, and channel (all HAL-touching)

| Word | Effect |
|---|---|
| `EMIT` `CR` `CHAR!` `CHAR@` `CLS` `AT-XY` `INK` `PAPER` | Screen (`01-HAL.md` §3). |
| `KEY?` `KEY` | Non-blocking poll / blocking read via the bound channel (`01-HAL.md` §4, §5). |
| `CURSEN` `CURSDIS` | Visible-cursor show/hide (`01-HAL.md` §3.5). |
| `REDRAW` | `( -- )`, repaint the whole framebuffer from `CHAR`'s current content (`01-HAL.md` §3.2's `redraw_all()`). |

All **KERNEL** — every one calls directly into the portable Screen/
Keyboard/Channel modules `01-HAL.md` specifies, which is exactly the
boundary rule this whole suite is built around (`00-OVERVIEW.md` §5):
genuinely different behavior per target belongs in a HAL call, never
faked from Forth source. `CURSEN`/`CURSDIS` specifically trigger an
*immediate redraw* of the cursor's cell, not merely a sysvar toggle —
there's no other Forth-visible way to invoke a glyph redraw, so a
Forth-source version that only flipped `CURSOR-VISIBLE` would leave the
screen stale until the next unrelated cursor move. Genuinely CORE, not
an oversight.

`REDRAW` exists for the same underlying reason, generalized to the
whole grid: `CHAR!` (and everything built on it) keeps `CHAR` and the
framebuffer synchronized automatically, but a direct `C!` into the
`CHAR` bank (`BANK@ CHAR ...`) bypasses that write-through entirely,
same as a storage operation overwriting `CHAR` in bulk (`RESTORE`/
`BLOAD`, §6.11) does. There is no way to express "repaint from `CHAR`
without touching it" in terms of any other primitive in this
catalog — `CHAR!` always writes `CHAR` as a side effect, which is
precisely what needs avoiding here — so this is genuinely CORE, not an
oversight either. **`RESTORE`/`BLOAD` (§6.11) call the same portable
`redraw_all()` internally**, whenever the bank they just loaded is
`CHAR`; `REDRAW` is that exact mechanism exposed as an ordinary word so
Forth source that pokes `CHAR` directly has its own way to
resynchronize, without needing a storage operation as an excuse to
reach it. Confirmed as a genuine cross-target concept, not a
browser-only convenience: a reference bare-metal implementation already
has the identical operation.

**`ACCEPT`** — `( addr len -- len2 )`, classic line input (read-echo,
handle Backspace, stop at Enter) — is **KERNEL today**, but is this
document's single strongest candidate for the *next* round of
reduction, and worth explaining why it isn't already BOOTSTRAP:

A reference implementation special-cases `ACCEPT` as a native primitive
specifically because it's a *multi-step* blocking operation — it needs
to suspend once per character read, and a single ordinary primitive
dispatch (§4.2's "anything else" case) runs to completion in one
uninterrupted step, with no way to suspend partway through. But this
reasoning has a gap: **once `KEY` is itself a suspend-capable
primitive** (§4.3/§4.4), *any* ordinary Forth-source loop built from
repeated `KEY` calls is automatically suspend-capable too, for free —
the suspension lives in `KEY`'s own dispatch, and `DOCOL`-threaded
execution already yields control at every slot regardless of what that
slot's primitive does. There is no structural reason `ACCEPT` needs to
be a bespoke multi-step primitive at all; a `BEGIN`/`WHILE` loop calling
`KEY`, checking for Enter/Backspace, and calling `EMIT`/`C!` would
suspend and resume correctly using the exact same mechanism §4.4
already requires for `KEY` alone.

**What actually blocks this today**: writing `ACCEPT`'s echo/backspace
handling in Forth needs the current cursor position, which — unlike
`HERE`/`LATEST`/`BASE` — has no Forth-visible address today (`CURSOR-X`/
`CURSOR-Y` live in the `CORE` sysvar group, `03-SYSVARS.md` §5, but no
`CURSOR-ADDR`-style constant exposes them the way `HERE-ADDR`/
`LATEST-ADDR` expose the `FORTH` group's fields, §6.10). **Recommended
follow-up, not designed further here**: extend the `HERE-ADDR`/
`LATEST-ADDR` precedent to the `CORE` group's cursor fields, then define
`ACCEPT` in bootstrap Forth source using `KEY`/`EMIT`/`C!`/`AT-XY` and
ordinary control flow. Once that lands, no primitive in this
specification needs to be a bespoke multi-step suspend-capable native
op — the general principle (§4.4's suspension mechanism composes
through ordinary Forth-source loops automatically) covers every case
that would otherwise seem to need one.

### 6.10 Dictionary/interpreter-state access primitives

| Word | Effect | | Definition (if BOOTSTRAP) |
|---|---|---|---|
| `'` | `( "name" -- xt )`, tick — look up a name, push its Code Field address, error if not found | **KERNEL** | Behaviorally equivalent to `WORD FIND 0= IF ." ?" ABORT THEN >CFA` (§6.13) — but **MUST stay native, not become BOOTSTRAP built from those**, for the opposite reason `WORD`/`FIND` themselves were reduced: it's needed the other way round. §6.5's control-flow layer needs `'` to resolve `BRANCH`/`0BRANCH`/`(DO)`/`(LOOP)`/`(+LOOP)`'s own tokens by name (via a `' WORDNAME CONSTANT WORDNAME-XT` pattern, §6.5) before any Forth-level loop construct exists to compile `FIND`'s own comparison loop with. A BOOTSTRAP `'` built from `FIND` would need control-flow already loaded; control-flow needs `'` already available — a genuine cycle, not a preference. Also **MUST NOT** carry the `IMMEDIATE` flag: `'`'s own top-level, non-immediate behavior is exactly what `SEE`/`HIDE`/`FORGET` (§7.2) depend on to resolve *their own caller's* argument (`SEE FOO`) — see §6.5's note for the full reasoning. |
| `EXECUTE` | `( xt -- )`, run the word at `xt` | **KERNEL** | Re-enters §4.2's threading loop at an arbitrary address; not expressible as a primitive that doesn't itself touch `ip`. |
| `STATE` | `( -- addr )`, the `FORTH.STATE` sysvar's own address | **KERNEL** | Direct sysvar-address exposure, same pattern as `HERE-ADDR`/`LATEST-ADDR`/`BASE` (§6.8). The foundation `[`, `]`, and `INTERPRET` itself (§6.13) build on — without it, `STATE`'s interpret/compile distinction is readable only from native code, which is exactly the gap that kept `INTERPRET` from being self-hosted (§2.5). |
| `LATEST-ADDR` | `( -- addr )`, the `FORTH.LATEST` sysvar's own address | **KERNEL** | Direct sysvar-address exposure. |
| `HERE-ADDR` | `( -- addr )`, the `FORTH.HERE` sysvar's own address | **KERNEL** | Same pattern; this is the exact precedent §6.9 recommends extending to `CURSOR-X`/`CURSOR-Y`. |
| `SP0` | `( -- addr )`, the data stack's constant empty-state address | **KERNEL** | Set once at boot (`03-SYSVARS.md` §11's `FORTH.SP0`), never mutated again; direct sysvar-address exposure, same shape as `HERE-ADDR`/`LATEST-ADDR`. |
| `SP@` | `( -- addr )`, the data stack's *live* pointer | **KERNEL** | The foundation `DEPTH`/`PICK` (§6.1) and `.S` (§6.8) all build on; nothing lower to derive it from. |
| `SP!` | `( addr -- )`, set the data stack's live pointer | **KERNEL** | Direct stack-pointer mutation; what `WARM` (§6.12) resets with. |
| `RP0` | `( -- addr )`, the return stack's constant empty-state address | **KERNEL** | Same pattern as `SP0`, for `RSTK`. |
| `RP@` | `( -- addr )`, the return stack's *live* pointer | **KERNEL** | What `I`/`J` (§6.5) read loop control through. |
| `RP!` | `( addr -- )`, set the return stack's live pointer | **KERNEL** | Direct stack-pointer mutation; the other half of what `WARM` resets. |

`WORDS`, `SEE`, `HIDE`, `FORGET`, `VOCABULARY`, `USE` are **not** in
this catalog at all — they are bootstrap-layer library words (§7),
built entirely from the KERNEL words above (principally `LATEST`, `,`,
`@`, `C@`, `!`, `LATEST-ADDR`, `HERE-ADDR`, and now `'`/`FIND`, §6.13)
with zero additional native support, already proven as working Forth
source. This specification records their *existence and contract*
(§7.2) as part of a conformant target's expected bootstrap layer, not
their implementation — the working reference definitions are the
reference to build against.

### 6.11 Storage / project

| Word | Effect |
|---|---|
| `PROJECT` `SAVE` `RESTORE` `BSAVE` `BLOAD` | Direct `01-HAL.md` §6 Storage-module access — naming, saving, and restoring project state. |

All **KERNEL** — these are the Forth-level surface of the storage HAL
boundary itself, not derived behavior. `RESTORE`/`BLOAD` call the
portable `redraw_all()` (`01-HAL.md` §3.2, `REDRAW`'s own underlying
mechanism, §6.9) whenever the bank they just overwrote is `CHAR`, so
the visible screen never goes stale after a project or single-bank
load. `SAVE` (save every active bank)
is mechanically "loop over every bank, save it" — if a future revision
adds a Forth-visible bank-*enumeration* primitive (there isn't one
today; `BANK@` only looks up by tag, it doesn't walk the table), `SAVE`
would become expressible as a loop over `BSAVE`-equivalent calls. Not
recommended as a change on its own — the enumeration primitive isn't
otherwise needed, and adding one solely to shrink this one word isn't
worth it by itself.

### 6.12 System reset

| Word | Effect | | Definition (if BOOTSTRAP) |
|---|---|---|---|
| `WARM` | `( -- )`, soft reset: clears both stacks; `DICT`/`MMAP`/every sysvar otherwise untouched | BOOTSTRAP | `: WARM SP0 SP! RP0 RP! ;` |
| `COLD` | `( -- )`, full reset: dictionary, bank layout, stacks, and every sysvar reinitialized exactly as at a fresh boot | **KERNEL** | See §4.6 — the contract (fresh-boot-equivalent state before the next line runs) is fixed there; no target-independent mechanism can be given here, because none exists. |

`WARM`'s derivation is worth tracing once, since it's a genuine finding
in its own right: `SP0 SP!` resets the data stack's live pointer to its
own constant empty-state address (§6.10); `RP0 RP!` does the same for
the return stack, using the (already-just-reset) data stack as
transient scratch space to carry `RP0`'s value across to `RP!` — safe
precisely because a push immediately followed by a pop nets to zero
effect on the very stack `WARM` is in the middle of resetting. **A
dedicated `WARM` primitive is not required at all** once a target has
`SP0`/`SP!`/`RP0`/`RP!` (§6.10) — which it needs regardless, as the
foundation `DEPTH`/`PICK`/`I`/`J`/`.S` already build on (§6.1, §6.5,
§6.8). `COLD` has no equivalent shortcut: it isn't that no one has
found the derivation yet, it's that no primitive dispatch — Forth-
defined or native — can rebuild the environment it's currently
executing inside of (§4.6).

### 6.13 The outer interpreter, self-hosted

This section closes the gap §2.5 identifies: `WORD`, `FIND`, `NUMBER`,
and `INTERPRET` **MUST** exist as ordinary dictionary words realizing
§5.1–§5.4's contract exactly, not as engine-internal logic with no
dictionary presence. `[` and `]` **MUST** exist as the ordinary
mode-switch words classic Forth systems use to leave and enter
compilation from within a colon-definition. Together with `:`/`;`/
`IMMEDIATE` (§5.2, now KERNEL-with-a-real-entry) and `'` (§6.10 —
staying KERNEL; see that row for why), this is the complete
self-hosted outer-interpreter layer.

| Word | Effect | | Definition (if BOOTSTRAP) |
|---|---|---|---|
| `:` | `( "name" -- )`, begin a definition | **KERNEL** | See §5.2 for full behavior. Not `IMMEDIATE`; dispatched like any other word found while interpreting. |
| `;` | `( -- )`, end a definition | **KERNEL, IMMEDIATE** | See §5.2. Must carry `IMMEDIATE` — it is `INTERPRET`'s compiling-mode dispatch rule (§5.4), not spelling, that makes it run instead of compile. |
| `IMMEDIATE` | `( -- )`, flag `LATEST` immediate | **KERNEL** | See §5.2. Not itself `IMMEDIATE` — always typed and executed directly, never compiled into another definition. |
| `WORD` | `( char "<chars>ccc<char>" -- addr len )` — skip leading occurrences of `char` (typically the space returned by `BL`), then read characters up to the next occurrence of `char` or end of line, advancing the shared input cursor (§5.3) past what was read | **KERNEL** | Raw-input-parsing access, same basis as `S"`/`(`/`'`'s prior classification (§2.2 rule 3). Returns a view into the live input line — **not** a copy into a scratch buffer, unlike classic fig-Forth's counted-string convention. Callers that need the text to outlive the current line (`CREATE` writing a dictionary header, `S"` compiling inline data) MUST copy it themselves; this specification does not add a scratch-buffer concept solely to preserve a convention nothing here still depends on. |
| `FIND` | `( addr len -- entry-addr flag )` — chain-walk from `LATEST` (§3) toward `0`, skipping `HIDDEN` entries, comparing each candidate's stored name (already uppercased at definition time, §3) against `addr len` case-insensitively; `flag = 0` if no match, non-zero if found | BOOTSTRAP | Built from `LATEST`, `@`, `C@`, and a per-character comparison loop over `addr len` against each candidate's name bytes (`entry-addr + 5 .. entry-addr + 5 + namelen`, `namelen` read the same way `>CFA` does, §7.2). **This specification fixes the contract and required composition; the exact comparison loop MUST be verified against a working reference implementation before being treated as canonical source**, the same standard §6.1 applies to `2SWAP`/`2OVER`/`ROLL`. Returns `entry-addr`, not `xt` — callers needing `xt` apply `>CFA` themselves; `entry-addr` is what a caller needs to read the flags byte (`entry-addr + 4`) for the `IMMEDIATE`/`COMPILE-ONLY` checks `INTERPRET` performs. |
| `[` | `( -- )`, switch to interpreting | BOOTSTRAP, `IMMEDIATE` | `: [ 0 STATE ! ; IMMEDIATE` — must be `IMMEDIATE` so it takes effect while compiling, matching `03-SYSVARS.md`'s `FORTH.STATE` encoding for "interpreting" exactly (verify the literal value against `03-SYSVARS.md` §11 rather than assuming `0` here). |
| `]` | `( -- )`, switch to compiling | BOOTSTRAP | `: ] -1 STATE ! ;` (or whichever value `03-SYSVARS.md` §11 defines as "compiling" — this specification's own body has used `STATE ≠ 0` as the compiling test throughout §5, so any non-zero encoding is conformant; verify the exact constant against that document rather than this one). |
| `NUMBER` | `( addr len -- n )` — convert `addr len` to a signed single-cell integer in the current `BASE`, per §5.4's contract | BOOTSTRAP | See reference definition below. Single-cell only, matching §5.4's own singular phrasing ("a valid number is pushed") — this specification does not include classic Forth's double-number (`DPL`) machinery, and `NUMBER` should not grow it without a corresponding update to §5.4. |
| `INTERPRET` | `( -- )` — tokenize and dispatch one line per §5.1–§5.4's contract | BOOTSTRAP | See §5.6 for its role in the driving loop and its interaction with §5.5/§8's error-rollback contract. Reference definition below. **MUST be the last word loaded in §7.1's bootstrap sequence.** |

**`NUMBER`'s reference definition** (verified against the dispatch
semantics in §4.2 and hand-traced stack effects, in the same spirit as
§6.5's control-flow block):

```forth
: NUMBER  ( addr len -- n )
  DUP 0= IF 2DROP 0 EXIT THEN
  OVER C@ 45 = >R                 ( addr len )            ( R: neg? )
  R@ IF 1 - SWAP 1 + SWAP THEN    ( addr' len', '-' skipped if present )
  DUP 0= IF ABORT THEN            ( a lone '-' with no digits is an error )
  0 -ROT                          ( accum addr' len' )
  OVER + SWAP                     ( accum limit addr' )
  DO
    I C@                                    ( accum char )
    DUP 96 > OVER 123 < AND IF 32 - THEN    ( accum char', lowercase folded )
    DUP 48 58 WITHIN OVER 65 91 WITHIN OR 0= IF ABORT THEN
                                    ( reject anything outside '0'-'9'/'A'-'Z' )
    DUP 57 > IF 55 - ELSE 48 - THEN  ( accum digit )
    DUP BASE @ < INVERT IF ABORT THEN  ( reject a digit >= BASE )
    SWAP BASE @ * +                ( accum' )
  LOOP
  R> IF NEGATE THEN
;
```

**[Revised]** an earlier version of this reference definition omitted
the three `ABORT` guards above (the lowercase-fold-then-range check,
the BASE-range check, and the lone-`-` check), and this section
documented the gap as "not a bug, a limitation" — the theory being
that `FIND` failing first covers the normal case of malformed input,
so `NUMBER` accepting garbage past `'9'` (e.g. a token containing `:`
or `;`, ASCII 58/59, silently read as digit value 3/4) or accepting a
digit `NUMBER` was never given a definition for in the current `BASE`
(e.g. a `'9'` in `BASE 8`) only mattered for contrived input. Building
this against real typed input (`follow-specs` branch, M43) showed
that theory doesn't hold: `NUMBER` is the *fallback* path once `FIND`
has already failed on a token — the normal case for a genuinely
malformed token *is* to reach `NUMBER`, not to be intercepted before
it — so a validation gap here means an ordinary typo (transposing two
characters, e.g., or typing a digit outside the active `BASE`) is
silently accepted as *some* number instead of failing the same way
any other unrecognized token does, which is a strictly worse outcome
than the `unrecognized word` error §5.4 promises. The lone-`-` case
(minus sign with no digits, `len' = 0` after sign-stripping) had the
same root problem in sharper form: the `DO`/`LOOP` that follows still
executes its body once even though `index = limit` at entry — the
same classic `DO`/`LOOP` quirk `TYPE`'s own row (§6.7) documents —
reading `C@` one byte past the token's own bounds and folding it into
`accum` as a bogus digit. All three gaps are closed the same way:
`NUMBER` itself calls `ABORT` (§8) the moment it can prove its input
isn't cleanly a number in the current `BASE`, rather than continuing
to accumulate a value nothing asked for. This composes for free with
the rest of this specification's error handling — an `ABORT` from
inside `NUMBER` propagates and rolls back exactly like any other
`ABORT`, including the one `INTERPRET`'s own step below already
relies on §5.5/§5.6's contract for.

**Echoing the token before each `ABORT` above is RECOMMENDED, not
required** — see §8's own note on this. `NUMBER` is the natural place
to do it: it already holds the token's original `addr len` (stashed
before sign-stripping alters them, since a guard can fail after that
point) at every one of its three failure sites, which is exactly what
`TYPE`ing it back out before `ABORT`ing needs and what no other word
in this call chain still has by the time `NUMBER` fails.

**`INTERPRET`'s required behavior**, stated precisely enough to
implement and verify independent of any one literal listing:

1. Call `WORD` with `BL` as the delimiter. If the returned length is
   `0`, the line is exhausted — return.
2. Call `FIND` on the returned `addr len`.
3. **If found** (`flag ≠ 0`): read the entry's flags byte
   (`entry-addr + 4`) and compute its `xt` via `>CFA`.
   - **Interpreting** (`STATE @ = 0`): if the `COMPILE-ONLY` bit (§3)
     is set, this is an error (§3's own rule — "using one outside
     `:`...`;` is a compile-time-only construct with no sensible
     interpret-time meaning"); otherwise `EXECUTE` the `xt`.
   - **Compiling** (`STATE @ ≠ 0`): if the `IMMEDIATE` bit is set,
     `EXECUTE` the `xt` regardless of `STATE` (§5.4's own rule, the
     mechanism every §6.5 control-flow word depends on); otherwise
     compile a call by appending the `xt` via `,`.
4. **If not found** (`flag = 0`): call `NUMBER` on the same `addr len`.
   - **Interpreting**: push the result.
   - **Compiling**: compile `LIT` followed by the literal value (two
     `,` appends — the `xt` of `LIT` itself, then the value).
   - `NUMBER`'s own failure path (any token that isn't cleanly a
     number in the current `BASE`, per its reference definition's
     `ABORT` guards above) signals via `ABORT` (§8) directly —
     `INTERPRET` does not need to detect or distinguish this failure
     itself, since it routes through §5.5/§5.6's rollback contract
     exactly as any other mid-compilation error does.
5. Repeat from step 1 until the line is exhausted (step 1's `len = 0`
   exit).

**`INTERPRET` obtains `LIT`'s own xt via a pre-resolved `LIT-XT`
constant** (`' LIT CONSTANT LIT-XT`, loaded once at bootstrap time,
before `INTERPRET` itself is defined) — the exact same pattern §6.5
uses for `BRANCH-XT`/`0BRANCH-XT`/etc., and the one the reference
bootstrap layer already establishes for exactly this purpose
(`system.fth`). `INTERPRET` does not call `'` itself at every compile
step; that would work (`'` is native and always available, §6.10) but
is needless per-call name resolution for a value that never changes
after boot.

**Load-order requirement, binding across §5.6, §6.10, §6.5, and this
section**: `WORD` and `STATE` are KERNEL — always available from boot,
not part of any load ordering. `'` is also KERNEL (§6.10) and likewise
always available; it is *not* one of the words this addendum loads.
What genuinely has to load in order: §6.5's control-flow block (using
only `'`/`,`/`HERE`/`SWAP`/`!`/`CONSTANT`, all already available)
**MUST** precede `FIND` (its comparison loop needs a control-flow
construct to compile with) and `NUMBER` (same, for its `IF`/`DO`/
`LOOP`); `FIND` **MUST** precede `NUMBER` and `INTERPRET` (both call
it); the `LIT-XT` constant above **MUST** precede `INTERPRET`; `[`/`]`
need only `STATE` and MAY load anywhere; `INTERPRET` **MUST** be
loaded last of all — see §7.2 for how this combines with the rest of
the bootstrap file's own ordering constraints. A target's bootstrap
file that violates this ordering fails to load, the same class of
failure §6.5's note on `>CFA`-before-`RECURSE` and §7.2's note on
`SEE`-before-its-`HIDE`-ing already document for this specification's
other load-order constraints.

---

## 7. The bootstrap layer

### 7.1 Requirement

**A conformant target MUST be able to load a body of portable Forth
source at boot, before any interactive session starts, that defines
every BOOTSTRAP-classified word in §6.** This is the mechanism whose
absence is what justified shipping a 130-primitive kernel in the first
place (§2.1) — a target that can't do this has no way to actually be
conformant with the reduced KERNEL set §6 specifies, since the
BOOTSTRAP words still have to exist and behave correctly for the system
to be usable.

**This document deliberately does not specify the loading mechanism's
own shape.** A reference implementation currently does this by fetching
a host text file over HTTP at page load, before the on-screen REPL
starts — that is a genuinely web-specific expedient, not a cross-target
requirement, and this specification does not adopt it as one. Any
mechanism satisfying the requirement is conformant: a Forth-source blob
linked directly into a bare-metal target's ROM image, a resident bank
loaded from the target's own storage medium at boot (`01-HAL.md` §6),
or a host-file fetch on a hosted target where that's the natural fit.
What's fixed is the *outcome* — every BOOTSTRAP word from §6, defined
and callable, before the first interactive prompt — not the delivery
mechanism.

**This same load MUST run again after `COLD`** (§4.6, §6.12) — a full
reset wipes `DICT` back to its fresh-boot state, so every BOOTSTRAP
word is gone until the bootstrap layer is reloaded exactly as it was at
genuine first boot.

### 7.2 Bootstrap library words beyond §6

Beyond promoting every BOOTSTRAP row in §6 into loaded Forth source, a
conformant target's bootstrap layer is expected to define the following
— already proven, working Forth-source definitions exist and this
specification treats them as the reference to implement against rather
than re-specifying byte-for-byte:

| Word | Contract | Depends on |
|---|---|---|
| `WORDS` | `( -- )` — lists every non-`HIDDEN` dictionary entry name, most-recently-defined first. | `LATEST`, `@`, `C@`, `TYPE`, `EMIT` |
| `>CFA` | `( entry-addr -- cfa )` — computes a dictionary entry's Code Field address from its own address (reads the flags byte, masks the name-length bits, aligns past the name). | `@`, `C@` |
| `XT-NAME` | `( xt -- )` — reverse of `WORDS`: given a Code Field address, prints the dictionary entry name whose own `>CFA` matches it. | `LATEST`, `>CFA`, `@`, `TYPE` |
| `SEE` | `( "name" -- )` — decompiles a `DOCOL`-coded colon-definition back to source-ish form, special-casing `LIT`/`(SLIT)`/`BRANCH`/`0BRANCH` as inline data rather than further calls to decompile. Scoped to `DOCOL`-coded words only — `CONSTANT`/`VARIABLE`/`DOES>`'d words report "not supported" rather than guessing wrong. | `'`, `>CFA`, `XT-NAME`, `@` |
| `HIDE` | `( "name" -- )` — sets the `HIDDEN` flag (§3) on an already-defined word's entry, found by reverse chain-walk via `>CFA` (the same technique `XT-NAME` uses). Already-compiled callers of a hidden word are unaffected (a compiled call is a raw address, not a name to re-resolve) — only future lookup and `WORDS` listings change. | `'`, `>CFA`, `@`, `C!` |
| `FORGET` | `( "name" -- )` — removes a word *and everything defined after it*, reclaiming `DICT` space: rolls `LATEST` back to the target word's own Link Pointer and `HERE` back to its own address, the same rollback §5.5 already performs automatically on a compile error, reachable here for any named word rather than only the currently-mid-compilation one. Needs `HERE`'s *address* (`HERE-ADDR`, §6.10), the exact gap that word closed. **Known, deliberately unaddressed limitation**: forgetting a word another `VOCABULARY` branch depends on leaves that vocabulary's chain corrupted — not designed against, since nothing needs it yet. | `'`, `>CFA`, `LATEST-ADDR`, `HERE-ADDR`, `@`, `!` |
| `VOCABULARY` / `USE` | Branching dictionary chains — a named vocabulary remembers a `LATEST` position; `USE` swaps which chain is currently active for both lookup and new definitions, saving the outgoing chain's position and loading the target's. Deliberately **not** how `HIDE`/decluttering is implemented (visibility and `WORDS`-listing are the same underlying chain-walk; a branching chain only ever lets a *later* vocabulary see an *earlier* one, never the reverse — no way to make something callable-but-unlisted with vocabularies alone). Reserved for their real use case — project/cart namespace isolation — once that's a concrete need. | `LATEST`, `CREATE`, `,`, `LATEST-ADDR` |

`>CFA`/`XT-NAME` and the internal constants `SEE` needs (`LIT`'s own
XT, `EXIT`'s own XT, …) are themselves `HIDE`-able once nothing later
in the bootstrap load still needs to find them by name — but `HIDE`
itself has to already be defined and those helpers still need to be
*findable* right up until `SEE`'s own closing `;`, so `HIDE`-ing them
happens **after** `SEE` is fully defined, not inline immediately after
each helper. This is a real load-order constraint on the bootstrap
file, not an arbitrary style choice — get the order wrong and `SEE`
fails to compile.

**This table's `'` dependency stays a native primitive** (§6.10), not a
BOOTSTRAP one — precisely so this table's own words (`SEE`/`HIDE`/
`FORGET`, each of which calls `'` as an ordinary deferred reference
that resolves *its own caller's* argument, e.g. `SEE FOO` — the
reference bootstrap layer's actual `SEE` does exactly this,
`system.fth`) and §6.5's control-flow block (which needs `'` to build
its `BRANCH-XT`/`0BRANCH-XT`/… constants before any Forth-level loop
exists to compile `FIND`'s own comparison loop with) can both depend
on it with no circularity.

The combined bootstrap sequence, folding in every per-word constraint
stated across §6.5, §6.13, and this section: `>CFA` before §6.5's
control-flow block (which itself needs its `…-XT` constants built
first); control-flow before `XT-NAME`/`WORDS`/`SEE`/`HIDE`/`FORGET`/
`VOCABULARY`/`USE` (all use `BEGIN`/`WHILE`/`IF`/`REPEAT` internally)
and before `FIND`/`NUMBER` (same reason, for their own loops); `FIND`
and the `LIT-XT` constant (§6.13) before `INTERPRET`, which **MUST**
load last of all. `'` itself needs nothing beyond native availability
and imposes no ordering constraint of its own; `[`/`]` need only
`STATE` (also native) and may load anywhere in this sequence. A
target's bootstrap loader MUST satisfy these dependencies — the exact
interleaving beyond them (e.g. `SEE` relative to `FIND`, since neither
depends on the other) is not fixed by this document.

---

## 8. Error / exception model

**Genuinely open, matching every other document in this suite's
treatment of it** (`01-HAL.md` §8, `02-MEMORY-MODEL.md`). What exists
today:

- **`ABORT`** — `( -- )`, **KERNEL**: clears the data stack and signals
  an unrecoverable condition through whatever native mechanism the
  target uses to propagate an error (an exception, in a hosted target;
  something target-appropriate on bare metal). It cannot be BOOTSTRAP
  today because there is no Forth-expressible way to "signal an
  uncatchable error" without a native primitive to do it — the moment a
  general `THROW` exists, `ABORT` becomes expressible in terms of it
  (a reserved, always-uncaught code), following classic ANS Forth's own
  precedent for the relationship between the two.
- **Uncaught-error recovery**, required regardless of `ABORT`
  specifically (§5.5 already states the mid-compilation half): any
  uncaught error, from any source, MUST leave the system at a genuinely
  clean prompt — both stacks cleared, any half-built definition rolled
  back, the error reported via `01-HAL.md` §8's `hal_report_error`, and
  the outer interpreter ready for its next line. This is stronger than
  "the process doesn't crash" — it's "the *session* recovers to a
  known-good state," which is what makes an interactive Forth prompt
  usable at all after a typo.
- **Echoing the failing token before `ABORT`** — RECOMMENDED, not
  required. Neither of this specification's classic ancestors
  (fig-Forth, Forth-79) had `THROW`/`CATCH` at all; their entire
  error-reporting convention was `ABORT` plus `TYPE`ing the offending
  token first (the familiar `TOKEN ?`, printed by the word that
  detects the failure, since it's the one still holding that token's
  `addr len` at the moment it fails — nothing needs to carry a message
  anywhere for this). §6.13's `NUMBER` reference definition follows
  this precedent directly, at each of its three validation guards. It
  costs nothing beyond `TYPE` (already BOOTSTRAP, §6.7) and composes
  with plain `ABORT` with no new mechanism, but it is not itself a
  general message-carrying facility — a word other than `NUMBER` that
  calls `ABORT` for its own reasons is not obligated to echo anything,
  and nothing here binds a future `THROW`/`CATCH` design to preserve
  this specific convention.

**Not designed by this document, deliberately** (matching
`CORE-VOCABULARY.md`'s own explicit scope cut):

- A numeric `THROW`/`CATCH` exception-code convention (stack underflow,
  unknown token, divide-by-zero, out-of-range access, …) — `01-HAL.md`
  §8 already defers this here; this document defers it further, having
  nothing new to resolve it with. When it is designed, it should reuse
  `hal_report_error` as its final reporting sink (§8's own point) rather
  than inventing a second one.
- **`LEAVE`** (early loop exit) — a real classic-Forth word, genuinely
  useful, cut here on purpose. Unlike most of §6's control-flow
  reductions, `LEAVE` doesn't have an obvious clean Forth-source
  derivation from what this document specifies: it needs to unwind a
  `DO` loop's return-stack control cells and branch to just past the
  matching `LOOP`/`+LOOP`, which either needs a small dedicated
  primitive or a `THROW`/`CATCH`-based implementation once one exists.
  Not designed now; revisit once a real need surfaces or `THROW`/`CATCH`
  lands, whichever comes first.

---

## 9. Explicitly out of scope

- **`LOAD` / classic screen-source interpretation** — reading a
  resident `BLKS` bank's contents as Forth source (`01-HAL.md` §6.5,
  generic block storage — **[Renamed, 2026-08-18]** was `SCRS`).
  Distinct from §7's bootstrap-loading requirement: §7 is how a target
  gets its *own* system vocabulary running before anything else exists;
  `LOAD` would be a *user-facing* word for interpreting arbitrary
  block-resident source at runtime. Blocked on the same `BLKS`
  infrastructure `01-HAL.md` already flags as optional/future.
- **Comment nesting.** `(` (§6.7) does not nest — the first closing `)`
  always ends it. A `\` (rest-of-line comment) word is not specified
  here either; not scoped by any word table in this document, added
  only if a real need surfaces.
- **Floating point** — `02-MEMORY-MODEL.md`'s own deferral; if ever
  added, a separate float stack, never packed into the integer cell.
- **A cross-target code-generation tool** producing token IDs,
  dictionary flag bits, and this catalog's KERNEL/BOOTSTRAP split from
  one source of truth — flagged repeatedly across this suite
  (`00-OVERVIEW.md`, `01-HAL.md`, `03-SYSVARS.md`) as a real gap, not
  built anywhere yet. Two independent targets hand-assigning token IDs
  from this document's tables risks exactly the drift that tool would
  prevent — worth building before a second real target's kernel is
  actually implemented against this document, not after.

---

## 10. Conformance checklist

| Requirement | Section |
|---|---|
| Dictionary entries use the fixed LFA/flags+len/name/CFA/PFA layout, whole-entry cell alignment, case-insensitive names | §3 |
| Chain walk skips `HIDDEN`, most-recently-defined wins on collision | §3 |
| `DOCOL`/`DOVAR`/`DODOES` are the only Code-Field sentinels (no `DOCON`) | §4.1 |
| `DOCOL`/`DODOES` thread through an explicit `ip` + return-stack loop, never native-language recursion | §4.2, §4.4 |
| `LIT`/`EXIT`/`BRANCH`/`0BRANCH`/`(SLIT)`/`(DOES>)` are unreachable outside the threading loop | §4.2 |
| Interpreter can suspend at a blocking `KEY` dispatch and resume using only `ip` + stack contents | §4.4 |
| `:`/`;`/`IMMEDIATE` are native KERNEL words with genuine dictionary entries, dispatched by `INTERPRET` uniformly via `FIND` — never special-cased by spelling | §5.2 |
| The raw-token input cursor is shared across a whole line, not local to one word's call, and is itself exposed as the KERNEL word `WORD` | §5.3, §6.13 |
| A mid-compilation error rolls back the half-built entry before the next line runs | §5.5 |
| `INTERPRET`, `NUMBER`, `FIND`, `[`, `]` are ordinary BOOTSTRAP dictionary words realizing §5.1–§5.4's contract exactly — not engine-internal-only logic | §5.6, §6.13 |
| The bootstrap sequence follows §7.2's combined ordering (`>CFA` → control-flow block → `XT-NAME`/`WORDS`/`SEE`/`HIDE`/`FORGET`/`VOCABULARY`/`USE` and `FIND`/`NUMBER` → `LIT-XT` → `INTERPRET` last; `'` native/unordered, `[`/`]` anywhere) | §6.5, §6.13, §7.2 |
| `'` stays a native KERNEL primitive, never BOOTSTRAP, and never carries `IMMEDIATE` | §6.10, §6.5 |
| `S"`/`."`/`(` carry the `IMMEDIATE` flag so their raw-consumed text is read from their own containing definition, not a later caller | §5.3, §6.7 |
| An error raised inside `INTERPRET` unwinds through §4.4's threading mechanism, not a native stack unwind, before §5.5's rollback runs | §5.6, §8 |
| Every §6 KERNEL-marked word is implemented natively | §6 |
| Every §6 BOOTSTRAP-marked word, plus §7.2's library words, is defined and loaded before the first interactive prompt | §7.1 |
| `COLD` reinitializes `DICT`/`MMAP`/both stacks/every sysvar to fresh-boot state before the next line runs, by whatever target-appropriate mechanism | §4.6, §6.12 |
| The bootstrap load (§7.1) re-runs after `COLD`, exactly as at genuine first boot | §4.6, §7.1 |
| Any uncaught error clears both stacks, reports via `hal_report_error`, and returns to a clean prompt | §8 |
