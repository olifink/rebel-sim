# IMPLEMENTATION.md

A living, concept-by-concept reference for how Rebel-Sim's Forth engine
actually works — grounded in the real code, not abstract Forth theory.

**Purpose:** two audiences, one document. (1) A technical reference for
anyone (human or agent) who needs to know how a mechanism works without
re-reading the source. (2) Raw material for future tutorials/docs aimed
at people who have never used Forth — every concept is explained in
plain language before it's tied to code.

**How this document grows:** after each milestone, append/extend the
relevant concept sections and add a row to the Milestone Status table.
Don't duplicate `PLAN.md` (the *decision log* — what we chose and why)
or `CLAUDE.md` (agent operating rules) — this document is the *how it
works* layer, kept current, not a historical record of how we got here.

---

## 0. Rebel-Sim in one paragraph

Rebel-Sim is a Forth interpreter running in TypeScript. Forth is a
programming language built around a very small set of ideas — a stack
for passing values, a dictionary of named "words" (Forth's term for
functions), and a text interpreter that either *runs* words immediately
or *compiles* them into new words — implemented directly on top of a
flat block of memory, the way it would be on real, tiny hardware. Rebel-
Sim's engine (`packages/engine`) mirrors exactly the memory-and-dispatch
model a bare-metal Forth (Rebel-ROM, C++) uses, so the same Forth source
code can run on both. `packages/app` is a thin Angular shell around it.

---

## 1. Core concepts

Each concept below: what it means (plain language) → how Rebel-Sim
implements it → where.

### 1.1 Stack-based / RPN

Forth has no operator precedence and no expression syntax. Everything is
a sequence of "words" separated by spaces, executed left to right, each
one either pushing a value onto a stack or popping values off it, doing
something, and pushing a result back. `2 3 +` means "push 2, push 3, run
`+`" — `+` pops two numbers and pushes their sum. This is Reverse Polish
Notation. There's no parser in the traditional sense — just a tokenizer
splitting on whitespace.

*Implementation:* `Machine.interpret()` in `packages/engine/src/repl.ts`
— split the line on whitespace, handle one token at a time.

### 1.2 Words

A "word" is Forth's unit of naming — closer to a function than a
keyword, but the term covers both: `+`, `DUP`, and a word you define
yourself (`SQUARE`) are all just "words." Two kinds exist in Rebel-Sim:

- **Primitives** — built directly into the interpreter (implemented in
  TypeScript), the fastest layer. `packages/engine/src/primitives.ts`.
- **Colon-definitions** — words *you* define in Forth itself, made of
  calls to other words. `: SQUARE DUP * ;` defines one. Implemented as
  real dictionary entries from M2 onward — see §1.6-§1.9.

### 1.3 Cell

Forth's native word size — the size of one stack slot, one dictionary
pointer, one piece of data. Rebel-Sim's cell is 32 bits (4 bytes), signed
or unsigned depending on the operation (arithmetic treats it signed,
addresses treat it unsigned) — chosen to match Rebel-ROM's cell exactly,
per `FORTH-ARCHITECTURE.md` §1.

*Implementation:* `CELL_SIZE` in `arena.ts`; `Arena.readCell`/`writeCell`
(signed) vs. `readCellUnsigned`/`writeCellUnsigned`.

### 1.4 The Arena — memory as one flat buffer, addresses as offsets

Instead of a heap with pointers, the whole machine's memory is one
pre-allocated flat byte buffer (the **arena**). Every address a Forth
program ever sees is an *offset into that buffer* — never a real
pointer. This is what makes "dump the memory to a file, load it on
different hardware" meaningful: an offset means the same thing
regardless of where the buffer physically lives.

*Implementation:* `Arena` class (`arena.ts`) wraps one `ArrayBuffer` +
`DataView`. It is the **only** place `DataView` methods are called
directly — every multi-byte read/write goes through it, always
little-endian (`FORTH-ARCHITECTURE.md` §2), because `DataView` defaults
to big-endian and getting this wrong silently produces a state dump that
looks fine in the browser and is garbage on real hardware.

### 1.5 Banks — named regions within the arena

The arena isn't one undifferentiated blob; it's carved into **banks** —
named, fixed-size regions handed out once and never moved (so nothing
that points into a bank ever needs to be "fixed up" later). Think of it
like partitioning a hard drive: the data stack lives in one partition,
the dictionary in another, sysvars in a third, and so on.

*Implementation:* `BankTable` (`banks.ts`) — `createBank(tag, name,
size)` / `findBank(tag, name)`. Current banks (in creation order):
`SYSV`, `DSTK`, `RSTK`, `DICT`. (`CHAR`/`SCRN` arrive in M3.)

### 1.6 Sysvars — the machine's "control panel"

A block of ordinary cells holding interpreter/machine state — things
like the current number base, whether the interpreter is compiling, and
pointers into the dictionary. Forth code reads/writes them exactly like
any other memory; the only thing special about them is what they mean.
Grouped by owning subsystem (`FORTH`, and in later milestones `SCREEN`,
`KEYBOARD`, etc.) rather than one flat list.

*Implementation:* `Sysvars` class (`sysvars.ts`), offsets sourced from
`rebel-opcodes.json`'s `sysvarGroups.FORTH`. Fields in use: `BASE`
(numeric radix), `STATE` (0 = interpreting, -1 = compiling), `HERE`
(next free dictionary address), `LATEST` (most recently defined word).

### 1.7 The Data Stack

The scratch space values pass through — Last In, First Out. `2 3 +`
pushes 2, pushes 3, then `+` pops both and pushes 5. Every primitive's
behavior is describable purely as a "stack effect" (what it pops, what
it pushes).

*Implementation:* `DataStack` (`stack.ts`) — grows *down* within its own
bank (a common Forth convention), bounds-checked, throws
`StackOverflowError`/`StackUnderflowError` on misuse. Reused verbatim for
the return stack (§1.11) — same growth/bounds rules apply to both.

### 1.8 Primitives & the switch dispatch

Each primitive has a small integer **token ID**. Executing a primitive
is a single `switch` statement keyed on that ID — this is "token
threading," the cheapest possible dispatch mechanism, matching what a
bare-metal target would do. Primitive IDs are 1..N; ID `0` is reserved
as a sentinel called `DOCOL` (§1.9) — never a real primitive.

*Implementation:* `executePrimitive(ctx, tokenId)` in `primitives.ts`.
The ID↔name table lives in `rebel-opcodes.json` (the project's
provisional stand-in for a cross-target generated source-of-truth —
`FORTH-ARCHITECTURE.md` §0).

### 1.9 The Dictionary — name lookup, and how a "call" is represented

The dictionary is Forth's name→code lookup table: every word the
interpreter knows, in a linked list from most-recently-defined backward.
Each entry has a fixed byte layout:

```
[ Link Pointer | Flags+Length | Name (padded) | Code Field | Parameter Field... ]
     4 bytes        1 byte        N bytes         4 bytes      (only if DOCOL)
```

- **Link Pointer** — offset of the *previous* entry (0 = start of the
  dictionary). Following these backward is how a name search works.
- **Flags + Length** — top 3 bits are flags (`IMMEDIATE`, `HIDDEN`,
  `COMPILE-ONLY`); bottom 5 bits are the name's length (0-31 chars).
- **Name** — the word's name in ASCII, zero-padded so the next field
  lands on a 4-byte boundary.
- **Code Field** — a token ID: either a primitive's ID, or the `DOCOL`
  sentinel meaning "this is a colon-definition; what follows is its
  body." The Code Field's *address* is called the word's **XT**
  (execution token) — it's what gets stored anywhere Forth needs to
  refer to "this word" (e.g. compiled into another word's body).
- **Parameter Field** — present only on `DOCOL` words: a list of XTs,
  i.e. the compiled body — "call this word, then this one, then...".

Classic Forth terminology, if you encounter it elsewhere: Link Pointer =
**LFA**, Flags+Length+Name = **NFA**, Code Field = **CFA**, Parameter
Field = **PFA**.

*Implementation:* `dictionary.ts` — `writeHeader` (create an entry),
`findWord` (walk the chain, skip `HIDDEN` entries, most-recent-match
wins — meaning redefining a word shadows the old one automatically, with
no special-case code needed). As of M2, **primitives are real dictionary
entries too** (boot-registered in `Machine`'s constructor) — there is
one uniform search path, not a separate table for built-ins vs.
user-defined words.

### 1.10 The Outer Interpreter (the REPL loop)

The "outer" interpreter is the one reading your text line by line. For
each whitespace-separated token, it either:
- looks the word up in the dictionary and executes it (**interpreting**,
  `STATE = 0`), or
- looks it up and compiles a call to it into the word currently being
  defined (**compiling**, `STATE = -1`), or
- if it's not a known word, tries to parse it as a number — pushing it
  (interpreting) or compiling it as a literal (compiling, via `LIT`,
  §1.12).

*Implementation:* `Machine.interpret()` in `repl.ts`, splitting into
`interpretExecuting`/`interpretCompiling` based on `sysvars.getState()`.

### 1.11 Compiling: what `:` and `;` actually do

`: SQUARE DUP * ;` — `:` starts a definition, `;` ends it. Concretely:

- `:` reads the next token as the new word's name, writes a dictionary
  header for it (Code Field = `DOCOL`, since it'll be a compound word),
  marks it `HIDDEN` (so it can't accidentally reference itself — Rebel-
  Sim doesn't support recursive self-reference yet, a known scope cut),
  and sets `STATE = -1`.
- Every subsequent token gets looked up and its **XT compiled** (its
  Code Field address written into the growing Parameter Field at
  `HERE`, which then advances) instead of executed.
- `;` compiles one final cell — the XT of the `EXIT` primitive (§1.13) —
  clears the `HIDDEN` flag, and sets `STATE = 0`.

If a compile-time error happens partway through (e.g. an unknown word),
the half-built definition is rolled back — `HERE`/`LATEST` are restored
to what they were before the `:` — so a typo at the REPL can't leave the
dictionary in a broken state.

**Deliberate scope cut:** `:`, `;`, and `IMMEDIATE` are *not* modeled as
dictionary words in Rebel-Sim — they're handled directly by the outer
interpreter (`repl.ts`), because they need to mutate compiler state
(`HERE`/`LATEST`/`STATE`) that an ordinary primitive's interface has no
access to. Many real Forths do implement `:`/`;` as actual (specially
flagged) dictionary words; this is a legitimate simplification for a
from-scratch minimal engine, not an oversight.

*Implementation:* `beginDefinition`/`endDefinition`/`abortDefinition` in
`dictionary.ts`, called from `Machine.interpret()`.

### 1.12 Literals — how a plain number ends up in compiled code

A colon-definition's body is a list of XTs — but `: FIVE 5 ;` needs to
embed the *number* 5, not a word to look up. The trick: compile a call
to a special primitive, `LIT`, immediately followed by the raw number as
its own cell. When the inner interpreter (§1.13) runs into `LIT`, it
reads the *next* cell as data (pushing it to the stack) instead of
treating it as another XT to execute, then skips past it.

*Implementation:* `LIT` token handling is special-cased inside
`Inner.executeXT`'s loop (`inner.ts`) — it's the one primitive that
needs to read/advance the instruction pointer, which a normal primitive
(§1.8) has no access to.

### 1.13 The Inner Interpreter — how a compiled word actually runs

This is the mechanism that makes "calling a word" work without relying
on the host language's (JavaScript's) own call stack — important because
a real Forth's call depth should be bounded by *its own* return-stack
memory, not by however deep the browser lets JS recurse.

Executing a word's XT:
1. Read its Code Field. If it's a primitive ID (not `DOCOL`), dispatch
   it directly (§1.8) — done.
2. If it's `DOCOL`, this is a compound word. Push a sentinel return
   address onto the **return stack**, and set an instruction-pointer
   variable (`ip`) to the start of its Parameter Field.
3. Loop: read the XT at `ip`, advance `ip` by one cell, then look at
   *that* XT's own Code Field:
   - `LIT` → push the next cell as a literal, skip past it (§1.12).
   - `EXIT` → pop the return stack back into `ip` (if that pops the
     top-level sentinel, the loop — and the call — ends).
   - `DOCOL` → this is a *nested* call to another compound word: push
     the current `ip` (the return address) onto the return stack, and
     jump `ip` into the nested word's Parameter Field. The same loop
     keeps running — no JS recursion, arbitrary nesting depth bounded
     only by the return-stack bank's own size.
   - anything else → it's a primitive; dispatch it, keep looping.

*Implementation:* `Inner.executeXT` in `inner.ts`. `EXIT_TOKEN`/
`LIT_TOKEN` are resolved by name from `rebel-opcodes.json` rather than
hardcoded, so they stay in sync with the source-of-truth table.

### 1.14 IMMEDIATE words

Normally, while compiling, a known word's XT gets compiled (deferred
until the new word is later called). An `IMMEDIATE`-flagged word instead
*runs right away*, even while compiling — this is how `;` works in
Forths where it's a real dictionary word (not here — see §1.11's scope
cut), and it's how you'd write your own compile-time tooling (macros,
roughly). Rebel-Sim supports `IMMEDIATE` as an outer-interpreter keyword
that flags the most-recently-defined word.

*Implementation:* `markLatestImmediate` in `dictionary.ts`; checked in
`Machine.interpretCompiling` before deciding whether to compile a call
or execute it immediately.

### 1.15 Boolean convention

Forth has no dedicated boolean type — flags are just cells. Rebel-Sim
(matching Rebel-ROM) uses `TRUE = -1` (all bits set) and `FALSE = 0` —
not C's `1`/`0` — because it composes correctly with bitwise `AND`/`OR`/
`INVERT` (`-1 AND x` is a no-op; `1 AND x` would corrupt anything but
bit 0). `FORTH-ARCHITECTURE.md` §7.

*Implementation:* `TRUE`/`FALSE` constants in `primitives.ts`, used by
`=`, `<`, `>`, `0=`.

---

## 2. Worked example: tracing `: SQUARE DUP * ; 5 SQUARE .`

This ties every mechanism above together, step by step, at the level of
actual memory writes.

**Compiling `: SQUARE DUP * ;`:**

| token | what happens |
|---|---|
| `:` | New dictionary entry for `SQUARE`: Link→previous `LATEST`, name="SQUARE", Code Field=`DOCOL`, flagged `HIDDEN`. `HERE` now points at the start of its (empty) Parameter Field. `LATEST` = SQUARE's entry. `STATE` = -1. |
| `DUP` | Found in the dictionary (a boot-registered primitive). Not immediate → its XT is compiled: `arena[HERE] = DUP.xt`, `HERE += 4`. |
| `*` | Same: `arena[HERE] = TIMES.xt`, `HERE += 4`. |
| `;` | Compiles `EXIT.xt` as the final cell, clears SQUARE's `HIDDEN` flag, `STATE` = 0. |

SQUARE's Parameter Field now holds exactly three XTs: `[DUP.xt,
TIMES.xt, EXIT.xt]`.

**Executing `5 SQUARE .`:**

| token | what happens | data stack after |
|---|---|---|
| `5` | Not a word; parses as a number; pushed. | `[5]` |
| `SQUARE` | Found; `executeXT`. Code Field is `DOCOL` → push return sentinel, `ip` = start of PFA. Loop: `DUP` runs (`executePrimitive`) → duplicates top; `*` runs → pops both, pushes product; `EXIT` runs → pops the sentinel off the return stack, loop ends. | `[5]` → `[5,5]` → `[25]` |
| `.` | Found (a primitive, not `DOCOL`) → dispatches directly: pops 25, formats it in the current `BASE`, appends to the output buffer. | `[]`, output: `"25 "` |

No JavaScript recursion occurred anywhere in `SQUARE`'s execution — the
nesting was carried entirely by the real (bank-backed) return stack,
exactly as it would be on the bare-metal target.

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **Cell** | Forth's native word size; 32 bits here. |
| **Word** | Forth's term for a named, callable unit — a "function." |
| **Primitive** | A word implemented directly in the host language (TypeScript), dispatched via `switch` on a small integer token ID. |
| **Colon-definition** | A word defined in Forth itself via `: name ... ;`. |
| **Dictionary** | The linked list of every known word (name → code). |
| **Arena** | The one flat byte buffer backing all of a machine's memory. |
| **Bank** | A named, fixed-size region within an arena (e.g. `DSTK`, `DICT`). |
| **Sysvar** | A cell in a reserved bank (`SYSV`) holding interpreter/machine state. |
| **LFA** | Link Field Address — a dictionary entry's link-pointer field. |
| **NFA** | Name Field Address — a dictionary entry's flags+length+name field. |
| **CFA** | Code Field Address — a dictionary entry's token-ID field. Also called the word's **XT**. |
| **PFA** | Parameter Field Address — where a `DOCOL` word's compiled body starts. |
| **XT** | "Execution token" — the address of a word's Code Field; what gets compiled into other words' bodies to represent "call this." |
| **DOCOL** | The reserved Code Field value (0) meaning "this word's Parameter Field is a list of further XTs to execute," i.e. it's a colon-definition, not a primitive. |
| **HERE** | Sysvar: the next free address in the dictionary (grows up as words are defined). |
| **LATEST** | Sysvar: the most recently defined dictionary entry's address. |
| **STATE** | Sysvar: `0` = interpreting, `-1` = compiling. |
| **BASE** | Sysvar: the current numeric input/output radix. |
| **IMMEDIATE** | Dictionary flag: this word executes even while compiling, instead of being compiled as a call. |
| **HIDDEN** | Dictionary flag: this word is invisible to name lookup (used while a definition is still being built). |
| **Outer interpreter** | The text-reading REPL loop: tokenize, then interpret-or-compile each token. |
| **Inner interpreter** | The mechanism that executes one word's XT — primitive dispatch, or threading through a `DOCOL` word's body. |
| **Data stack** | The LIFO stack values pass through between words. |
| **Return stack** | The LIFO stack of "where to resume" addresses, used when one compiled word calls another. |
| **LIT** | The primitive that embeds a raw number in a compiled word's body (compiled as `LIT` followed by the literal cell). |
| **EXIT** | The primitive that ends a compiled word's execution — pops the return stack back into the instruction pointer. |

---

## 4. Milestone status

| Milestone | What it added | Key files |
|---|---|---|
| **M1** | Arena, banks, sysvars (`FORTH` group), data stack, primitive dispatch (20 primitives), a line-based outer interpreter with no dictionary yet. | `arena.ts`, `banks.ts`, `sysvars.ts`, `stack.ts`, `primitives.ts`, `repl.ts` |
| **M2** | Real dictionary (§1.9), colon-definitions (§1.11), the DOCOL-threaded inner interpreter with a real return stack (§1.13), `IMMEDIATE` (§1.14). Primitives became real dictionary entries. | `dictionary.ts`, `inner.ts`, `repl.ts` (rewritten) |
| M3 (planned) | Screen: `CHAR` bank, canvas framebuffer, bitmap-font blitting. | — |
| M4 (planned) | Keyboard: non-blocking event queue, blocking `KEY`. | — |
| M5 (planned) | Storage: OPFS-backed projects/carts. | — |
| M6 (planned) | PWA packaging. | — |

See `PLAN.md` for the decision log and detailed per-milestone build notes.
