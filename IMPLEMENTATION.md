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

Every bank has two separate identifiers, easy to conflate but serving
different jobs: **`tag`** says *what kind* of bank this is (`DSTK`,
`DICT`, `DATA`, ...) — tags repeat, e.g. a project can have several
`DATA`-tagged banks at once. **`name`** says *which one* — always
unique, auto-generated as an 8-digit zero-padded serial
(`"00000000"`, `"00000001"`, ...) unless a caller supplies one
explicitly. M1-M4's banks (`SYSV`, `DSTK`, ...) never needed a stable
name, so they all use auto-generated serials; M5's project-asset banks
(§1.22) *do* need one, since a bank's `name` doubles directly as its
saved file's basename — no separate mapping between "what a bank is
called" and "what file represents it."

Bank sizes are drawn from a fixed ladder of **size classes** — every
power of two from 2 KiB (`MIN_BANK_SIZE`, M58 — 4 KiB through M55–M57)
through 4 MiB (`MAX_BANK_SIZE`) — rather than arbitrary byte counts.
(An earlier revision used six named classes, `XS` through `XXL`, each
4x the previous, with no class in between; §1.67 covers why that
changed.) Most banks (`SYSV`, `DSTK`, ...) just happen to be sized in
code to match a class already; the ladder's real payoff is loading a
file of unknown length (§1.22): round its size up to the smallest class
that fits, and that's the bank's size — a lookup, not a calculation.

*Implementation:* `BankTable` (`banks.ts`) — `createBank(tag, size,
name?)` / `findBank(tag, name?)` / `findBankByName(name)` /
`roundToSizeClass(bytes)`. Current banks (in creation order): `SYSV`,
`DSTK`, `RSTK`, `DICT`, `CHAR` (§1.16), `KMAP` (§1.21), `FONT` (§1.71,
M59), plus whatever a project's `openProject()` call creates (§1.22).
`SCRN` — the pixel framebuffer — is deliberately **not** one of these;
see §1.17.

### 1.6 Sysvars — the machine's "control panel"

A block of ordinary cells holding interpreter/machine state — things
like the current number base, whether the interpreter is compiling, and
pointers into the dictionary. Forth code reads/writes them exactly like
any other memory; the only thing special about them is what they mean.
Grouped by owning subsystem — `CORE`, `SCREEN`, `KEYBOARD`, `FONT`,
`SPRITE`, `STORAGE`, plus Rebel-Sim's own `FORTH` group (interpreter
state Rebel-ROM's Phase 11 doesn't have yet) — rather than one flat
list. As of M3, group names/order/offsets match the real Rebel-ROM
implementation exactly (see `rebel-opcodes.json`'s header); only the
*field*-level layout within each group is Rebel-Sim's own (cell-sized
fields vs. Rebel-ROM's packed byte/`u16` C structs).

*Implementation:* `Sysvars` class (`sysvars.ts`) — a generic
`get(group, field)`/`set(group, field, value)` pair (offsets sourced
from `rebel-opcodes.json`'s `sysvarGroups`), plus a few named
convenience wrappers for the hottest FORTH-group fields. Fields in use:
`FORTH.BASE` (numeric radix), `FORTH.STATE` (0 = interpreting, -1 =
compiling), `FORTH.HERE`/`FORTH.LATEST` (dictionary pointers, §1.9),
`CORE.CURSOR-X`/`CORE.CURSOR-Y` (§1.18), `SCREEN.INK`/`SCREEN.PAPER`/
`SCREEN.CHAR-COLS`/`SCREEN.CHAR-ROWS`/etc. (§1.16).

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

**As of M43 (`spec/04-FORTH-CORE.md` §5.2/§6.13), this is genuinely
self-hosted Forth source, not engine-internal TypeScript** — see §1.54
for the full mechanism. `WORD` scans real arena bytes (the `TIB`) for
the next token, `FIND` chain-walks the dictionary, `NUMBER` parses
digits, and `INTERPRET` ties them together exactly per the bullets
above — all ordinary dictionary words (`system.fth`), findable via
`FIND` and listed by `WORDS` like anything else. What used to be this
section's whole story — `Machine.tokenizeAndRun()`/`interpretExecuting`/
`interpretCompiling` in `repl.ts` — still exists, but demoted to the
**native fallback**: the mechanism that loads `system.fth` itself
(nothing can call `INTERPRET` before it's defined) and the path any
`Machine` that never loads a bootstrap layer at all still uses, by
design — most engine-level tests deliberately construct a bare one, to
exercise a primitive in isolation without paying for the whole
vocabulary. `Machine.dispatchLine()` is the one place that decides
which of the two actually runs a given line.

*Implementation:* `system.fth`'s `INTERPRET`/`FIND`/`NUMBER` (the real
path); `repl.ts`'s `dispatchLine()`/`tokenizeAndRun()`/
`interpretExecuting`/`interpretCompiling` (the native fallback).

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

**As of M43, `:`, `;`, `IMMEDIATE` (and `COMPILE-ONLY`) ARE ordinary
dictionary words** — genuine `primitives.ts` cases, found via `FIND`
like anything else, never special-cased by spelling
(`spec/04-FORTH-CORE.md` §5.2's own requirement: "nothing external
gates this once dispatch is uniform"). They're native KERNEL
primitives rather than BOOTSTRAP Forth source specifically because they
need to mutate compiler state (`HERE`/`LATEST`/`STATE`) an ordinary
primitive's stack-effect-only interface doesn't otherwise reach — that
was always the real reason, this document's older framing just
conflated "needs to be native" with "has no dictionary entry," which
M43 shows aren't the same thing. One real, deliberate behavioral
consequence: since `:`/`IMMEDIATE`/`COMPILE-ONLY` aren't themselves
`IMMEDIATE`, typing one *while compiling* now compiles a call to it
(deferred) rather than erroring immediately — `;` still self-checks
`STATE` and errors correctly either way, since it stays `IMMEDIATE`.

*Implementation:* `beginDefinition`/`endDefinition`/`markLatestImmediate`/
`markLatestCompileOnly` in `dictionary.ts` are unchanged; what moved is
*who calls them* — `primitives.ts` cases 136-139 now, not `repl.ts`'s
old special-casing.

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

### 1.16 The Screen — one framebuffer, always graphics

There's no separate "text mode." The screen is a pixel framebuffer,
period; text is a second, independent description of what's on it,
layered on top. Two pieces of state:

- The **`CHAR` bank** — an ordinary arena bank, one byte per screen
  cell, holding just the character *code* at each column/row. Plain
  addressable memory, like anything else — `base + row*cols + col`.
- The **framebuffer** — the actual pixels. Unlike `CHAR`, this is
  **not** arena memory (§1.17).

Writing a character updates both, one-directionally: the code goes into
`CHAR`, and the corresponding glyph gets drawn into the framebuffer.
Reading a character (`CHAR@`) only ever looks at `CHAR` — cheap, no
pixel inspection. If something else later draws over those pixels
(raw graphics, not yet implemented), `CHAR@` still reports the original
code; the two aren't kept in sync in the other direction.

*Implementation:* `Screen` class (`screen.ts`) — `writeChar`/`readChar`
(`CHAR!`/`CHAR@`), `emit` (§1.18), `cls` (`CLS`). Matches Rebel-ROM's
`CScreenModule` behavior exactly, including two easy-to-miss details:
out-of-range coordinates are silently ignored/return-a-space rather than
throwing, and there's deliberately no way to read back what color a
character was written in (colors aren't stored in `CHAR`, only used at
the moment of writing — see §1.17).

### 1.17 The HAL boundary — why the engine never touches a canvas

`packages/engine` has zero DOM dependencies (`PORTING-WEB.md` §1) — it
can't import a canvas API even if it wanted to. But drawing a glyph's
pixels is unavoidably host-specific (a `<canvas>` in a browser, an SPI
panel on real hardware, nothing at all in a test). The fix is the same
one real hardware abstraction layers always use: the engine defines an
*interface* describing what it needs done, and whoever constructs the
engine supplies an implementation.

```ts
interface ScreenHal {
  blitGlyph(col, row, charCode, ink, paper): void; // paint one glyph cell
  clearScreen(paper): void;                        // paint the whole framebuffer
}
```

Every `CHAR`-bank write calls the injected `ScreenHal` synchronously, in
the same tick — this is why `packages/app` doesn't need any kind of
"redraw the canvas" step after `Machine.interpret()` returns; by the
time it returns, every pixel is already correct. Tests (and any future
headless use) get `NULL_SCREEN_HAL`, a no-op, for free — `CHAR`-bank/
sysvar state is fully correct without a real HAL, which is all
engine-level tests need to verify.

This is also *why* the framebuffer (`SCRN` on Rebel-ROM) was never made
an arena bank the way `CHAR` was: it's owned and drawn by the host side
of this boundary, not by the engine, so it was never arena-resident
memory to begin with — consistent with `FORTH-ARCHITECTURE.md` §8
excluding it from the "dump the arena, load it elsewhere" portability
claim.

*Implementation:* `ScreenHal` interface + `NULL_SCREEN_HAL` in
`screen.ts`. The real implementation, `CanvasScreenHal`
(`packages/app/src/app/canvas-screen-hal.ts`), fills a cell in `paper`
then draws the glyph's set pixels in `ink`, reading from a ported
bitmap font table (§1.19). `INK`/`PAPER` are raw 24-bit `0xRRGGBB`
truecolor values by default — M62 (§1.74) adds an indexed palette mode
(values 0-15 become a looked-up color) sitting in front of this same
HAL call, active from boot (M62 follow-up 3); the HAL boundary itself
never gains any palette awareness, it always receives a resolved
`0xRRGGBB` value either way. `spec/01-HAL.md` §3.6 has since made this
mechanism (`PAL`/`ATTR` banks, `PALETTE-BASE`) **REQUIRED** for every
display-capable target, not merely something Rebel-Sim happens to add
(M62 follow-up 4) — it's a software indirection layer, not something
only indexed-color display hardware could support.

The host is free to do whatever it wants with the surface it's drawing
into beyond that — `CanvasScreenHal` targets a DOM-detached, true-
resolution (320x240) offscreen canvas rather than the visible one
directly; `packages/app`'s own per-frame pump is what presents that
onto the actually-visible canvas (a `drawImage` upscale, sized to always
land on a clean integer pixel multiple regardless of the display's
`devicePixelRatio` — a real rendering bug, fixed after M7a shipped, see
`PLAN.md`'s M7a follow-up note). None of that is visible at the `ScreenHal`
contract level; it's purely how the host chooses to present what the HAL
already drew correctly.

### 1.18 Cursor & wrap-only output — no scrolling

`EMIT`'s streaming behavior (as opposed to `CHAR!`'s positioned
writes) needs a cursor. It lives in sysvars (`CORE.CURSOR-X`/`-Y`), not
engine state, so it's just as poke-able as anything else. `AT-XY`
repositions it with **no bounds-checking at all** — an absurd position
just self-corrects the next time something advances the cursor, rather
than being rejected up front (matching Rebel-ROM's `SetCursor` exactly).

The interesting part is what happens at the edges: reaching the end of
a row wraps to the start of the next one; reaching the last row wraps
back to **row 0**, silently overwriting whatever was there. There is no
scrolling. This is a real, deliberate Rebel-ROM design point (not a
Rebel-Sim shortcut) — scrolling was explicitly cut from its screen
module's first pass and can be revisited later if a real need shows up.

`\r` and `\n` are handled as cursor-control codes *inside* `emit`
itself, not as glyphs to draw — `\r` moves to column 0 without changing
row, `\n` moves to the next row (wrapping per the above). Rebel-Sim's
`CR` primitive is just `screen.emit(10)` — there's no separate
cursor-move-only code path, because Rebel-ROM's `Emit()` doesn't have
one either.

*Implementation:* `Screen.emit`/`Screen.advanceCursor` (private) in
`screen.ts`.

### 1.19 Bitmap font blitting

Character glyphs are a flat lookup table — one fixed-size bitmap per
character code, nothing computed at render time. Rebel-Sim ported
Rebel-ROM's own `font_zxspectrum.cpp` (8×8, generated once from a `.ttf`
by Rebel-ROM's own tooling) byte-for-byte rather than inventing a font
or rasterizing one at runtime — real data, not a Rebel-Sim shortcut.
Each glyph is 8 bytes, one per pixel row, most-significant-bit =
left-most pixel. A code outside the font's covered range (including
space) renders as a blank cell.

Drawing a glyph is always two steps: fill the whole cell in the current
`PAPER` color, then draw only the glyph's *set* pixels in `INK` — never
draw text with a host text-rendering API (`fillText` and friends) as
the actual render path, since that can't represent "a Forth program
poking one glyph cell directly as memory" the way a real bitmap-blit
does.

*Implementation:* `packages/app/src/app/font-zxspectrum.ts` (the ported
data + `glyphRows(charCode)` lookup), consumed by `CanvasScreenHal`
(§1.17).

### 1.20 The keyboard queue — raw events in, translated chars out

Mirroring the screen module's shape (§1.16-§1.18), keyboard input is a
two-layer pipeline: a host-specific *raw* layer feeding a small,
engine-owned, host-agnostic *event queue*.

- The host (an Angular `keydown`/`keyup` listener in Rebel-Sim; a USB HID
  report handler on real hardware) turns a physical key press/release
  into a **raw usage code** — a small integer identifying *which key*,
  independent of what character (if any) it produces. Modifier keys
  (Ctrl/Shift/Alt/GUI, left and right kept distinct) get *pseudo* usage
  codes in a reserved range (`0x80 + bit`) rather than a separate
  mechanism, so they flow through the exact same event pipeline as an
  ordinary letter key.
- `Keyboard.pushRawEvent(usageCode, pressed)` is the one entry point from
  that raw layer into the engine. It does two things: updates a live
  modifier bitmask (visible as a sysvar, so Forth code can read "is Shift
  currently held" without draining the queue), and — on a *press* only —
  translates the usage code into a character via the `KMAP` bank (§1.21),
  then pushes a `{usageCode, modifiers, char, pressed}` event onto a
  fixed-size ring buffer. A *release* event carries no character
  (`char = 0`) even for an otherwise-printable key.
- The queue is deliberately **non-blocking and lossy under pressure**: if
  it's full, a new event is silently dropped rather than overwriting an
  older unconsumed one or blocking the caller. Forth reads it with two
  primitives — `KEY?` (peek: is there anything queued, without consuming
  it) and `KEY` (pop the oldest event's character). Both are immediate,
  synchronous operations; there is currently no way for a Forth program
  to *wait* for a key ("block" until one arrives) — see the note below.

**Why modifier presses are their own queue entries, not just a bitmask
flip:** it's tempting to assume only "real" keys (letters, digits, ...)
belong in the queue and Shift/Ctrl/Alt are purely a side-channel state
bit. They're both: every press *and* release — including a bare tap of
Shift with nothing else held — is a real, orderable event in the queue,
in addition to updating the live bitmask. This matters for anything that
needs to reconstruct exact timing/ordering (e.g. "was Shift already down
*before* this letter, or did they arrive in the same tick") rather than
only ever seeing the modifier bitmask's *current* value at some later,
unrelated read.

**Why there's no blocking `KEY` yet:** a traditional Forth `KEY` blocks
the calling task until a key is available — useful for writing
`: MAIN BEGIN KEY ... AGAIN ;`-style programs without a manual poll
loop. Building that requires *something* to suspend on ("come back to
this exact point once the queue is non-empty") — a task-suspension or
async execution model the interpreter doesn't have yet (today,
`Machine.interpret()` runs one line to completion, synchronously, with
no notion of "pause here"). `KEY` (§3) errors on an empty queue rather
than pretending to block; adding real blocking later is additive (a new
code path layered on the same queue), not a redesign of anything built
here — the same shape as `hal_draw_*` being deferred in M3.

### 1.21 The `KMAP` bank — usage code to character, as data not code

Rather than a `switch` statement or if-chain mapping usage codes to
characters, translation is table-driven: a bank (tag `KMAP`) holding two
256-entry planes — unshifted and shifted — indexed directly by usage
code. Translating a key is just `table[shiftPlane][usageCode]`, an
ordinary byte read.

Only keys with an obvious single character get a non-zero entry:
letters, digits (and their shifted symbol-row counterparts, e.g. `1` /
`!`), the standard US punctuation row, and Enter/Backspace/Tab/Space
(mapped to `'\n'`/`'\b'`/`'\t'`/`' '`). Everything else — Caps Lock,
function keys, Print Screen, arrow keys, the GUI/Windows key — is left
at `0` in the table. Those keys are still fully visible to Forth code
(their press/release events still flow through the queue with their real
usage code), just with no character meaning; a program that wants to
react to, say, an arrow key reads `usageCode` directly rather than
`char`. This is a deliberate "identify the key now, decide what it does
later" split, not an oversight — a command-palette or game-input word
built later can react to raw usage codes without this table needing to
change at all.

Being a real bank (not a JS object/`Map`) means the table lives in the
same portable arena memory as everything else — swapping to a different
physical layout (a non-US keyboard, say) is only ever a matter of
loading different bytes into this bank, never a code change.

### 1.22 Storage — projects, carts, and why there's no "read block N"

Classic Forth systems store source code as fixed-size numbered "blocks"
on disk, read/written by primitives like `BLOCK`/`UPDATE`. Rebel doesn't
do this. Instead, storage is organized around two concrete, named
things:

- A **project** is a folder of *asset files* — one file per bank, each
  file's contents an exact byte-for-byte dump of that bank. A project is
  editable, in-progress material.
- A **cart** is a single flat baked binary, meant only to be run, never
  edited — the "insert a cartridge" experience. (Baking — how a cart's
  contents actually get produced from an open project — isn't built yet;
  it needs a compiler/assembler pass over the project that doesn't exist
  until Forth itself can express it.)

The key idea that makes this simpler than it sounds: **a bank's on-disk
identity is just its own `name`+`tag`** (§1.5) — the file's basename is
literally the bank's `name`, and its extension is looked up from the
bank's `tag` (`DATA`→`.DAT`, `SCRN`→`.SCR`, ...). There's no separate
"filename for this bank" concept to keep in sync; saving a bank and
naming a bank are the same act.

Loading a project means: list its folder, and for every file whose
extension is recognized, create a new bank (sized by rounding the file's
byte length up to the nearest size class, §1.5) named after the file's
own basename, and copy the bytes in. An unrecognized extension, or a
file too large for even the biggest size class, is skipped — not an
error, just "not something this loads." Saving a bank writes the
opposite direction: the bank's raw bytes, preceded by a small 6-byte
sanity header (a two-byte magic plus the bank's own tag — a cheap,
optional cross-check, not something a load actually depends on).

**Storage operations are ordinary synchronous Forth primitives, same as
everything else:** `PROJECT`/`SAVE`/`RESTORE`/`BSAVE`/`BLOAD`
dispatch through the same `switch` as `DUP`/`+`, no different from any
other word — persistence only ever happens at *project open/close* time
(now: when one of these five words runs), as an explicit act, not on
every individual memory read/write a Forth program makes. Once a
project's banks are loaded, Forth code just reads and writes them
directly, the same as any other bank — no storage-device call hides
behind an ordinary `@`/`!`. **[Revised, M33]** this used to require a
dedicated interpreter-suspension mechanism (a `'storage'` `StepStatus`,
§1.23's blocking-`KEY` shape reused for a different reason) because the
original backend (OPFS) was Promise-based — that's gone now that storage
is genuinely synchronous; see `DEVELOPING.md` §25 for the full story.

*Implementation:* `storage.ts` — the `Storage` class (`openProject`,
`saveAsset`, `loadAsset`, `loadCart`, `saveCart`), all plain synchronous
methods. Talks to a host-supplied `StorageHal` (`ensureDir`/`listFiles`/
`readFile`/`writeFile`) rather than any browser API directly — in
`packages/app`, `LocalStorageStorageHal` backs this with `localStorage`
(base64-encoded payloads under one key namespace; a real directory
hierarchy doesn't exist over a flat key-value store, so `ensureDir` is a
no-op and "listing a directory" is a prefix scan over `localStorage`'s
own keys). `runStorageSelfTest()` is a standalone round-trip proof
(write a byte-pattern bank, save it, reload it fresh, compare) that
`app.ts` runs once at startup, surfaced as a small `storage: OK`/`FAILED`
status line.

### 1.23 Blocking `KEY` — suspending mid-execution, without threads

Every primitive before M7 ran to completion the instant it was
dispatched — `+` pops two cells and pushes their sum, all in one
synchronous step, no waiting involved. `KEY` breaks that assumption on
purpose: a classic Forth `KEY` is supposed to wait for a keypress if none
is available yet, effectively pausing the *entire program* — including
whatever colon-definition called it, and whatever called *that* — until
one arrives.

JavaScript has no threads to "pause" in the traditional sense, and
Rebel-Sim's inner interpreter deliberately avoids using the host call
stack for word-calling-word nesting (§1.13) — which turns out to make
this easier, not harder. Because nesting is already carried by an
explicit instruction pointer (`ip`) and a real return stack rather than
JS function calls, there's no hidden call-stack state that would need
capturing to "come back later." A JavaScript **generator function** —
one that can `yield` control back to its caller mid-execution and later
resume exactly where it left off — is a natural fit: `ip` is just a
local variable inside the generator, and it stays alive across a `yield`
for free, the same way any local variable in a paused function does.

So `executeXT` (§1.13) is a generator. It `yield`s once after every
ordinary step (one primitive dispatched, one literal pushed, one `EXIT`
processed) — a signal meaning *"I made progress, but there's likely more
to do."* When it reaches a `KEY` dispatch with no input available, it
instead `yield`s a *different* signal — *"I'm stuck, nothing to do until
more input shows up"* — and, critically, does **not** advance past that
point. The very next time it's resumed, it checks again, in exactly the
same spot, whether input has arrived; if not, it reports "stuck" again;
if so, it finally proceeds.

Something has to actually call this generator repeatedly to make
progress happen — a generator that's never resumed just sits there
forever. That's `Machine.step(budget)`: it resumes the current line's
generator up to `budget` times, stopping early the instant it sees a
"stuck" signal (there's no point spending more of the budget hammering a
question whose answer can't change until something external — a
keypress — happens), or once the whole line finishes. The host
(`packages/app`) calls `step()` repeatedly, once per animation frame, for
as long as there's a line in flight — which is what actually gives the
browser tab a chance to keep handling keystrokes, rendering, and
everything else *while* Forth code is "waiting" on `KEY`, instead of the
page appearing frozen.

*Implementation:* `inner.ts`'s `Inner.executeXT` (a `Generator<StepSignal,
void, void>`, `StepSignal` = `'progress' | 'blocked'`) and `repl.ts`'s
`Machine.beginLine()`/`step()`/`interpret()`. `interpret()` itself is
unchanged in what it *feels* like to call for any line that never
touches `KEY` — it still runs the whole line synchronously and returns,
exactly as before M7; see §4's M7 row for why that compatibility was
worth preserving deliberately rather than treated as a side effect.

### 1.24 The Channel abstraction — what blocking `KEY` actually waits on

`KEY` doesn't check the keyboard directly. It asks a **`Channel`** —
an interface with exactly two operations: *"do you have something for
me?"* (`hasData()`) and *"give me the next thing"* (`readByte()`). The
keyboard is the only real implementation today (`KeyboardChannel`,
wrapping the M4 `Keyboard` class), but nothing about `KEY` or the
generator-based suspend/resume mechanism in §1.23 knows or cares that
it's specifically a keyboard behind that interface.

This indirection is the entire point, not incidental plumbing: a
*different* input source — a remote command sent over the network, say
— can be made to look like a `Channel` too (same two methods, different
implementation), and `KEY` would suspend and resume against it exactly
the same way, with **zero changes** to `inner.ts`, `repl.ts`, or `KEY`
itself. That's the shape a future "control this Forth session remotely"
feature is expected to take — not designed or built yet, but the reason
`Channel` exists as its own small interface now rather than `KEY` simply
calling `Keyboard` by name.

`KeyboardChannel` also does one small but meaningful filtering job: some
keyboard events (a Caps Lock press, a Shift release) have no printable
character at all (§1.21) — `hasData()`/`readByte()` silently skip past
those, so `KEY` only ever sees events that actually produce a character.
This is a deliberately different, lower-level view than `KEY?`
(§1.20), which still reports on *every* queued event, translated or not
— two tools answering two different questions over the same underlying
queue.

*Implementation:* `channel.ts` — the `Channel` interface and
`KeyboardChannel`. `Machine` holds one bound `Channel` (`MachineOptions.
channel`, defaulting to a `KeyboardChannel` over its own `keyboard`).

### 1.25 The on-screen REPL — `ACCEPT` and a self-driving prompt loop

Through M7, "type Forth, see it run" happened via a browser text box: a
real HTML `<input>` element, typed into with ordinary cooked keyboard
input, submitted with a form. That was always a stand-in — a real
machine doesn't have a second, separate text field bolted on next to its
one screen. M7a replaces it with the real thing: the prompt, what you
type, and any output all appear directly on the one canvas, exactly the
way they would on the physical hardware.

Two pieces make this possible, both building directly on M7's work
rather than needing anything new at the suspend/resume level:

- **`ACCEPT`** is a classic Forth word: give it a buffer address and a
  maximum length, and it reads keyboard input one character at a time —
  echoing each onto the screen as it's typed, handling Backspace by
  erasing the last echoed character, and stopping (without storing or
  echoing the key itself) the moment Enter is pressed. It's built the
  same way blocking `KEY` (§1.23) is — suspend when there's nothing to
  read, resume once there is — just looped, once per character, with a
  running count of how much has been typed so far.
- **The self-driving REPL loop** (`Machine.startRepl()`) is what used to
  be `packages/app`'s job, moved into the engine: draw a prompt, `ACCEPT`
  a line onto the screen, interpret it (printing `? <message>` directly
  to the screen instead of crashing if it was bad Forth), and loop back
  for another line — forever. This uses the exact same "session" a
  single typed-and-driven line already used (§1.23) — there's still only
  ever one thing running at a time, it's just that "one thing" is now an
  infinite loop instead of a single line, and the host's job shrinks to
  "keep calling `step()`" for the entire lifetime of the page, not just
  while a submitted line is in flight.

A small but real UX detail worth internalizing: `ACCEPT` erasing a
character via Backspace can't just move the cursor left and blank a
cell — if the line being typed is long enough to have already wrapped to
a new screen row (§1.18), backspacing past the start of that row needs
to walk back onto the *previous* row's last column, the same wrap
convention output already uses going forward. And the loop is careful to
only print a blank line before the next prompt when something was
actually printed — otherwise every silent command (most of them; only a
few words like `.`/`EMIT` produce visible output) would leave a stray
empty row before the next `>` for no reason.

*Implementation:* `inner.ts` — `Inner.accept()` (the character loop) and
`readCharBlocking()` (the one-character suspend/resume primitive it's
built from, factored out of `KEY`'s own dispatch logic). `repl.ts` —
`Machine.startRepl()`/`replLoop()`, and the small `TIB` ("Terminal Input
Buffer") bank `ACCEPT` reads each line into.

### 1.26 Control flow — `BRANCH`/`0BRANCH` and the IMMEDIATE compiler words

Every Forth control-flow word (`IF`, `BEGIN`, `DO`, ...) compiles down to
the same two primitives: `BRANCH` (unconditional jump — read the next
compiled cell as a target `ip`, jump there) and `0BRANCH` (pop a flag;
`FALSE` jumps like `BRANCH`, anything else falls through to the cell
*after* the target). Both are `ip`-mutating, so — like `LIT`/`EXIT`
before them — they're special-cased directly in `threadFrom`'s slot loop
(§1.13), never reaching `primitives.ts`'s switch.

`IF`/`ELSE`/`THEN`/`BEGIN`/`UNTIL`/`WHILE`/`REPEAT`/`RECURSE` are
themselves ordinary dictionary entries, but flagged both `IMMEDIATE`
(§1.14 — they run *while compiling*, not get compiled as calls) and, new
in M8, `COMPILE_ONLY`: a dictionary flag reserved in the header layout
since M2 but never actually checked until now. The outer interpreter
rejects a compile-only word found while interpreting (`STATE = 0`)
instead of letting it silently start corrupting `HERE`.

Each of these words' *entire* job is emitting `BRANCH`/`0BRANCH` plus a
target cell, and tracking backpatch addresses — on the data stack, the
same stack everything else uses, since compilation and interpretation
never run concurrently. `IF` compiles `0BRANCH` + a placeholder cell and
pushes the placeholder's own address; `THEN` patches whatever address is
on top of the stack (from `IF` or `ELSE`) to `HERE`. `BEGIN` needs no
placeholder at all — it just pushes `HERE` itself, a backward target
already known. `RECURSE` compiles a direct call to the *current*,
still-`HIDDEN` definition's own CFA, computed straight from `LATEST`
(bypassing `findWord`'s HIDDEN skip) — resolving the self-reference gap
M2's dictionary design left open.

*Implementation:* `inner.ts` (`BRANCH`/`0BRANCH` in `threadFrom`),
`primitives.ts` (the IMMEDIATE compiler-word cases), `dictionary.ts`
(`FLAG_COMPILE_ONLY` now read back off `DictionaryEntry`).

### 1.27 Counted loops — `DO`/`LOOP`/`+LOOP`

`DO`/`LOOP` need something `IF`/`BEGIN` don't: real state that outlives
one iteration (the loop's index and limit), carried across however many
times the loop body runs. Classic Forth's answer — and this project's —
is to keep that state on the *return stack*, pushed just above the
current return address, where `EXIT`-style unwinding never has to know
it's there.

`DO` (`immediate`, `compileOnly`) compiles a call to `(DO)` — a plain
runtime primitive that pops `limit`/`index` off the data stack and
pushes them onto `RSTK` — then pushes `HERE` (the loop-back target) for
`LOOP` to consume. `LOOP` compiles a call to `(LOOP)` (increments the
`RSTK`-resident index, compares to the limit, pushes a data-stack flag,
and on completion drops the loop-control cells off `RSTK`) followed by
`0BRANCH` back to `DO`'s target. `+LOOP` is identical except `(+LOOP)`
pops a caller-supplied increment instead of using 1, and terminates via
a simple directional boundary check (continue while `next < limit` for
a non-negative increment, `next > limit` for a negative one) rather than
the full ANS "unsigned crossing" algorithm — correct for ordinary
counting-up/counting-down `+LOOP`s, not exhaustively specified any more
precisely than this by `CORE-VOCABULARY.md` §6 either. `I`/`J` just peek
`RSTK` at depth 0 / depth 2 — the innermost
loop's index sits right above the return address; the next-outer loop's
sits two loop-control-cell-pairs further down.

Nothing here is `ip`-mutating in a way `LIT`/`BRANCH` aren't already, so
`(DO)`/`(LOOP)`/`(+LOOP)` are ordinary `primitives.ts` cases (given
direct `rstack` access via `PrimitiveContext`, §1.8) — only `DO`/`LOOP`/
`+LOOP` themselves are IMMEDIATE/compile-only, same tier as `IF`/`BEGIN`.

*Implementation:* `primitives.ts` (`DO`/`LOOP`/`+LOOP` compiling; `(DO)`/
`(LOOP)`/`(+LOOP)`/`I`/`J` running).

### 1.28 `CREATE`/`DOES>` — defining new defining words

`VARIABLE`/`CONSTANT` are themselves just two more dictionary entries —
but `CREATE`...`DOES>` is what lets *Forth code* define new words like
them, rather than only ever getting the ones already built in. This
needed two more Code Field sentinels, same tier as `DOCOL` (checked once
at the top of `executeXT`, never inside the slot loop):

- **`DOVAR`** — a plain `CREATE`d word's Code Field: executing it pushes
  its own parameter field's start address and returns. `VARIABLE` is
  built directly on this.
- **`DODOES`** — what `DOES>` rewrites a word's Code Field *to*.
  Executing a `DODOES` word pushes its parameter field's start address,
  then threads into a stored "does-pointer" exactly the way `DOCOL`
  threads into a Parameter Field — pushing a return address and jumping
  `ip`, unwinding on `EXIT` like anything else.

The one real design decision M8 had to settle (flagged `[OPEN]` in
`CORE-VOCABULARY.md` §7 before implementation): **every `CREATE`d word
reserves one leading parameter-field cell**, initialized to 0, whether or
not `DOES>` ever gets applied to it. That cell is where `DOES>` later
writes the does-pointer if it's used — and because it's *always* there,
`DOVAR`'s and `DODOES`'s "push the parameter field start" both skip
exactly the same one cell, so a word's own PFA never changes based on
whether `DOES>` was applied before or after it was first executed.
`VARIABLE` reserves that same leading cell (permanently unused, since
`VARIABLE`-made words never get `DOES>`'d in practice) plus one more for
its actual storage — the classic `: VARIABLE CREATE 0 , ;` relationship,
just spelled out directly rather than composed.

`DOES>` itself compiles a single call to `(DOES>)` — an `ip`-mutating
runtime primitive, special-cased in `threadFrom` like `BRANCH`: it
rewrites `LATEST`'s Code Field to `DODOES`, stores the *current* `ip`
(exactly the code following `DOES>` in the *defining* word, since this
dispatch already advanced past its own slot) into `LATEST`'s reserved
leading cell, then unwinds the return stack exactly like `EXIT`. The
defining word's own execution (e.g. `CREATE , DOES> @`, run once per
`CONST`-alike word created) ends there — the `DOES>`-clause only runs
*later*, whenever the newly-made word itself is executed.

*Implementation:* `inner.ts` (`DOVAR`/`DODOES` sentinel dispatch in both
`executeXT` and `threadFrom`; `(DOES>)`'s runtime). `primitives.ts`
(`CREATE`/`VARIABLE`/`CONSTANT`/`DOES>`'s compile-time halves).
`rebel-opcodes.json` (`dovarTokenId`/`doconTokenId`/`dodoesTokenId`:
negative, distinct from `docolTokenId` (0), the positive primitive token
space, and `inner.ts`'s own `-1` return-stack sentinel).

### 1.29 Strings — inline literals and a deliberate tokenizer scope cut

`S"`/`."` compile a length-prefixed byte run directly into the compiled
word's body — `(SLIT)`, `LIT` generalized from one cell to a byte run:
reads the next cell as a length, pushes `(ip, length)` as the string's
addr/len pair, then advances `ip` past the bytes (cell-aligned) instead
of past one fixed cell. `TYPE` prints `len` bytes from `addr`; `."` is
plain sugar for `S" ... TYPE`.

The real open question flagged while planning M8 wasn't the runtime
mechanism above — it was the *outer interpreter*. `tokenizeAndRun`
splits a line on whitespace before any word ever sees it (`repl.ts`), so
`S" hello world"` would already be two tokens (`hello` and `world"`) by
the time `S"`'s own logic runs — no amount of cleverness inside `S"`
fixes that; it needs a genuinely different, character-level parser (the
classic Forth `WORD`/`>IN` pattern reading a raw buffer, not an
array-of-tokens). **Deliberate scope cut, not a silent gap:** M8 ships
`S"`/`."` supporting only a single token with no embedded spaces, and
`S"` used while interpreting (rather than compiling) throws a clear
error rather than pretending to support it. A real multi-word string
parser is real, scoped-out follow-up work, not a bug.

*Implementation:* `inner.ts` (`(SLIT)`'s `ip`-mutating runtime).
`primitives.ts` (`compileInlineString`, shared by `S"`/`."`).

---

### 1.30 The remote channel — `RemoteChannel`, `CompositeChannel`, and WebMCP

M7 built `Channel` (`hasData()`/`readByte()`) specifically so blocking
`KEY` never has to know *which* input source it's bound to. M9 is that
design paying off: `RemoteChannel` (`channel.ts`) is a plain FIFO of
chars with one method, `push(text)` — no capacity cap, unlike
`Keyboard`'s 32-slot ring buffer, since that cap models real USB HID
hardware and programmatic input has no such constraint to honor.
`CompositeChannel` merges any number of `Channel`s into one,
first-ready-wins in argument order. `Machine`'s constructor
(`repl.ts`), given a `remoteChannel` option, binds
`CompositeChannel([KeyboardChannel, remoteChannel])` instead of a bare
`KeyboardChannel` — a human at the keyboard and a remote caller share
one session, one `Machine`, no arbitration logic needed anywhere.

The actual "remote" part isn't a server. **WebMCP**
(`webmachinelearning/webmcp`) is a real, in-progress web platform
feature: a page registers callable tools via
`document.modelContext.registerTool(...)`, and the browser (natively,
eventually) or an extension bridges those to an MCP client — the page
never runs a server, it just declares what it can do. Angular 22
(already this project's installed version) ships this as
`declareExperimentalWebMcpTool`/`provideExperimentalWebMcpTools`
(`@angular/core`). `App.registerWebMcpTools()` (`app.ts`) calls the
former six times, once per tool, each a fresh generic instantiation
rather than looped over an array (a mixed-shape array collapses
TypeScript's per-tool `inputSchema` inference to one shape — a real
compile error hit and fixed during M9, not a hypothetical). One write
(`type`, pushing into `remoteChannel`) and five reads (`read_screen`,
`read_stack`, `read_return_stack`, `read_dictionary`, `read_banks`),
every read closing directly over the live `Machine` and reusing
exactly the introspection surface the M8 inspector panel already
exposes — no new engine-level read methods needed for M9 at all.
Registration is wrapped defensively against both a synchronous throw
and an async `Promise` rejection, since WebMCP is gated behind
`chrome://flags/#enable-webmcp-testing` even on Chrome 150 and the app
must keep booting normally without it (verified: `document.modelContext`
absent → zero console errors, same degrade-gracefully contract already
established for storage HAL support).

Verified fully end-to-end via the Chrome DevTools MCP server against
the deployed GitHub Pages build: with the flag enabled,
`list_webmcp_tools` returns all six registered tools, and calling
`type` through the real tool path (not a direct `RemoteChannel.push()`
bypass) drives the REPL and shows up via `read_screen` exactly as
expected. Also confirmed the shared-session merge works in the
human→agent direction, not just agent→human: text typed at the
physical keyboard and text sent via the `type` tool both land in the
same console output, interleaved, with neither displacing the other —
`CompositeChannel` behaving exactly as designed (§ above).

*Implementation:* `channel.ts` (`RemoteChannel`, `CompositeChannel`),
`repl.ts` (`MachineOptions.remoteChannel`), `app.ts`
(`registerWebMcpTools`, `safeRegisterWebMcpTool`).

---

### 1.31 Word-level breakpoints (M10, `DEBUGGING.md`)

A third `StepSignal` value, `'breakpoint'`, added alongside M7's
`'progress'`/`'blocked'` — the exact same suspend/resume shape blocking
`KEY` already uses, reused rather than parallel-built. `Inner` holds a
`breakpoints: Set<number>` of `cfa` addresses (constructor-injected,
owned and mutated by `Machine`, `Inner` only ever reads it) and a
private `checkBreakpoint(xt)` generator: `if (this.breakpoints.has(xt))
yield 'breakpoint';` — deliberately not an if/else wrapping the rest of
the call. Resuming (another `.next()`) continues right past the yield
into the normal entry logic, so no "already broke here" flag is
needed, and a recursive or looped call to the same word correctly
re-breaks on every entry, not just the first.

Checked at four sites, all "about to thread into a compiled word's
body": `executeXT`'s top-level `DOCOL` and `DODOES_TOKEN` branches
(covers a breakpointed word being the very first one typed on a line,
or a `CREATE...DOES>` word invoked directly — not reached via
`threadFrom` at all), and `threadFrom`'s own `DOCOL`/`DODOES_TOKEN`
branches (every nested call). Deliberately *not* checked for
primitive-coded words (`dispatch()`'s path) — DEBUGGING.md's explicit
scope cut, since a primitive has no interesting paused-mid-execution
state to inspect that reading the stack before/after doesn't already
show.

Breakpoints are a session-local `Set` on `Machine`
(`setBreakpoint`/`clearBreakpoint`/`listBreakpoints`, thin wrappers
over the existing `findWord`/`listDictionaryEntries`), not a
dictionary header flag — that byte is already fully packed
(`FLAG_IMMEDIATE`/`FLAG_HIDDEN`/`FLAG_COMPILE_ONLY` + 5-bit name length
leaves zero spare bits), and the header layout is a fixed cross-target
contract not worth growing for a debug-only, unpersisted concern.
"Which word is currently paused at" is `Inner.pausedAtXt` — set right
before the `'breakpoint'` yield fires, read by `Machine.pausedAtWord()`
— a small refinement over `DEBUGGING.md`'s original sketch (which
proposed reading it off the return stack's current top frame; that
turned out to be the *caller's* resume address, not the paused word's
identity, once actually implemented).

**The one required app-side change, easy to miss:** `App.startPump`'s
`tick()` previously ignored `step()`'s return value entirely — a
`'breakpoint'` would otherwise resume on the very next animation frame
(~16ms later), never actually holding. `App` gained a
`pausedAtBreakpoint` boolean: `tick()` skips its `machine.step()` call
while set, and sets it when `step()` returns `'breakpoint'`. Five new
WebMCP tools registered alongside M9's six —
`debug_set_breakpoint`/`debug_clear_breakpoint`/`debug_list_breakpoints`/
`debug_status`/`debug_continue` — with `debug_continue` only clearing
the flag `tick()` already polls, never driving `step()` itself, keeping
"one place drives `step()`" true. `setBreakpoint`/`clearBreakpoint` on
an unknown word and `debug_continue` while not paused all throw real
errors out of `execute()` rather than returning an error string — a
genuine tool-error state for the calling agent, not a string it has to
parse.

Verified live via the same Chrome DevTools MCP path M9 used, against
the local dev server: defined `SQUARE`, armed a breakpoint, typed
`5 SQUARE .`, confirmed `debug_status` reported `"paused at SQUARE"`
with `read_stack` showing only `5` (not `25`), `debug_continue`'d,
confirmed `25` printed and status returned to `"running"` — and that
`debug_continue` correctly errors when called with nothing paused.

*Implementation:* `inner.ts` (`StepSignal`, `Inner.breakpoints`/
`pausedAtXt`/`checkBreakpoint`), `repl.ts` (`StepStatus`,
`Machine.setBreakpoint`/`clearBreakpoint`/`listBreakpoints`/
`pausedAtWord`), `app.ts` (`pausedWord` signal, five `debug_*` tools).

**Inspector panel UI, added right after** (`DEBUGGING.md` §9): a
"breakpoints" section, clickable dictionary words, and a "paused at
WORD — Continue" banner — driven by `Machine.listBreakpoints()`
diffed in `tick()` exactly like `dictionaryWords`/`bankTable` already
were, so it stays correct whether a breakpoint was armed from the UI
or from a WebMCP call. Required one real engine addition:
`DictionaryEntry.breakable` (`dictionary.ts`) — computed from the
entry's *current* Code Field (not cached at definition time, since
`DOES>` rewrites it after the fact) — which also let
`Machine.setBreakpoint` reject a non-breakable word outright instead
of silently accepting a breakpoint `Inner.checkBreakpoint` could never
fire for.

---

### 1.32 Comments as compiled data (M11, `DEVELOPING.md` §2)

Comments didn't exist at all before this — not "discarded," genuinely
absent; `Machine.tokenizeAndRun` was (and still is) plain whitespace
tokenization with no comment-awareness of its own. `(` is a new
`IMMEDIATE` primitive (token 93) rather than special compiler syntax
like `:`/`;` — it needs nothing `PrimitiveContext` doesn't already
expose (`nextInputToken()`, `sysvars`, `arena`), so it's dispatched
exactly like `IF`/`S"` already are: found via the ordinary dictionary
lookup, and — because it's `immediate` — run immediately even while
compiling (`repl.ts`'s `interpretCompiling`: `if (found.immediate) {
yield* this.inner.executeXT(found.cfa); }`), the same mechanism every
other compile-time word already relies on. Zero `inner.ts`/
`dictionary.ts`/`repl.ts` changes as a result — this only grows the
primitive table by one entry, it doesn't touch the threading model.

`primitives.ts`'s old `compileInlineString` (`S"`/`."`'s helper) was
split into `consumeQuotedText(ctx, closingChar)` — a real loop over
`nextInputToken()` rather than the old single-token grab, rejoining
with single spaces until a token ends with the closing delimiter — and
`compileSlit(ctx, text)`, the unchanged `(SLIT)`-compiling step.
`S"`/`."`'s call sites didn't change; multi-word string support
(`S" hello world"`, previously broken) fell out for free. `(`'s new
case: consume the text, and only if compiling (`STATE === -1`) compile
`(SLIT)` + the text followed by a compiled `2DROP` call — a genuine
runtime no-op (push, immediately drop) rather than a special
"comment" instruction; while interpreting at the top level, the text
is just consumed and discarded (nothing to compile into). Chosen over
a dedicated `(COMMENT)` token specifically to avoid a new Code Field
sentinel (`FORTH-ARCHITECTURE.md` §9 item 13) — reversible if `SEE`
(§1.31's future companion, not yet built) ever finds the `(SLIT)`+
`2DROP` pattern genuinely ambiguous against a real string a program
discards on purpose.

One real bug the tests caught: `( a note )`'s conventional spacing
(unlike `S" ..."`'s glued closing quote) puts `)` as its own standalone
token — the first cut of `consumeQuotedText` always added a separator
space before appending that token's (now-empty) stripped remainder,
producing a spurious trailing space. Caught by a test reading the
compiled `(SLIT)` length cell directly rather than only checking the
word still ran; fixed by skipping the separator when the remainder is
empty.

*Implementation:* `rebel-opcodes.json` (token 93, `(`), `primitives.ts`
(`consumeQuotedText`, `compileSlit`, case 93).

---

### 1.33 System vocabulary: `WORDS`/`SEE` from `system.fth` (M12, `DEVELOPING.md` §6)

The next phase past core (native primitives): words genuinely worth
writing *in* Forth, kept in a plain host text file
(`packages/app/public/system.fth`) loaded once at boot — an interim
step before real portable screens/carts exist (`DEVELOPING.md` §4/§5).
Loading is App-layer (`App.loadSystemVocabulary()`, `app.ts`), not
engine-layer, per the framework-agnostic-engine rule — `fetch()`es the
file relative to `<base href>` (same mechanism already serving the PWA
manifest/icons, so it's offline-precached for free) and feeds it
through `machine.interpret()` once per line before `startRepl()`. A
colon-definition spanning multiple lines works with no special
handling — `STATE` is a persistent sysvar, so a `:` left open at one
`interpret()` call's end is picked up correctly by the next. Errors
are deliberately not caught the way `registerWebMcpTools()` degrades
gracefully — a broken system vocabulary is a bug in this repo's own
source, not a missing browser feature.

One new primitive, `'` (tick, token 94): `( -- xt )`, not `IMMEDIATE`
— runs at *execution* time like `CREATE`, so `: SEE ' ... ;` correctly
consumes *its caller's* next input word (`SEE FOO`) rather than its
own compile-time input. Added because nothing in the existing
vocabulary let Forth-level source resolve a typed name to an `xt` at
runtime.

`system.fth` itself: `WORDS` (`CORE-VOCABULARY.md` §12's own worked
example, fixed — `1F AND` is a hex literal but `BASE` defaults to
decimal, so `31` is used instead, a bug that had apparently never
actually been run before now); `>CFA`/`XT-NAME` (the reverse of
`WORDS`' own chain-walk — given an entry address, compute its Code
Field address, or given a Code Field address, find the entry whose
own `>CFA` matches it — one uniform walk covers primitives and
user-defined words alike, since primitives are boot-installed
dictionary entries too); five named constants for `LIT`/`EXIT`/
`BRANCH`/`0BRANCH`/`(SLIT)`'s own `xt`s, captured once via `'` at load
time; and `SEE` itself — a real decompiler walking a word's Parameter
Field, printing each call by name or special-casing `LIT`/`(SLIT)`/
`BRANCH`/`0BRANCH`, stopping at `EXIT`. Only `DOCOL`-coded words are
supported; `CONSTANT`/`VARIABLE`/`DOES>`'d words print
`(not supported)` rather than guessing wrong, and `BRANCH`/`0BRANCH`
print a bare `<branch>` placeholder rather than reconstructing
`IF`/`THEN` structure.

**Two real bugs, found by running the code and checking `read_stack`,
not by reading it:** `XT-NAME`'s first cut left the matched entry's
own `entry-addr` on the stack before `EXIT` (a missing `DROP`) —
silently corrupting every subsequent call, manifesting as an apparent
infinite loop in `SEE` rather than an obvious stack error, diagnosed
by isolating `XT-NAME` against an independent reference (`'`'s own
`cfa` computation) rather than debugging the composed failure
directly. And `." : "`/`." <branch> "` both silently lost their
leading/trailing spaces entirely — a bare delimiter token carries no
content for the string-rejoin logic (§1.32) to preserve — fixed by
moving those spaces to explicit `32 EMIT` calls instead.

**Confirms, live, a tradeoff `FORTH-ARCHITECTURE.md` §9 item 13 only
predicted:** `SEE` on a word containing a `( comment )` shows
`"this is a comment" 2DROP`, not clean `( ... )` syntax — the
`(SLIT)`+`2DROP` comment encoding really is ambiguous against a
genuine discarded string, exactly as anticipated when that encoding
was chosen. Not fixed — first real evidence for a previously-only-
theoretical tradeoff.

*Implementation:* `packages/app/public/system.fth` (`WORDS`, `>CFA`,
`XT-NAME`, `SEE`), `app.ts` (`loadSystemVocabulary`),
`primitives.ts`/`rebel-opcodes.json` (token 94, `'`).

---

### 1.34 `VOCABULARY`/`USE`: branching dictionary chains (M13, `DEVELOPING.md` §8)

One new primitive, `LATEST-ADDR ( -- addr )` (token 95) — pushes the
`LATEST` sysvar's own cell address (not its value; `LATEST` already
gives that), via `Sysvars.fieldOffset` made public (it already
computed exactly this, just had no external caller before). Fixes the
same gap the dropped `FORGET` exploration hit — `HERE`/`LATEST` are
read-only from Forth in this engine, unlike most real Forth systems,
which usually expose them as ordinary variables — generally, via one
address-exposing primitive, rather than a bespoke setter.

`VOCABULARY`/`USE` themselves are pure Forth source in `system.fth`,
no further engine changes. Mechanism: **branching chains, not
independent chains with a search order.** A vocabulary is a `CREATE`d
cell holding its own remembered `LATEST` position — `VOCABULARY name`
is `LATEST CREATE ,` (note the order: `LATEST` must run *before*
`CREATE`, since `CREATE` becomes the new `LATEST` itself the instant
it links in, so the old value has to be captured first, or a
vocabulary would capture itself). Critically, that captured value is
whatever `LATEST` *was*, not zero — a vocabulary starts as a
*continuation* of the chain that was current when it was created, not
an empty one. `USE name` saves the outgoing chain's current position
back into its own cell, then loads the target's remembered position
into the live `LATEST` sysvar (via `LATEST-ADDR`), addressing the
target's own cell with `' name 8 +` — the same `+8` past a `CREATE`d
word's Code Field and reserved does-pointer cell that `executeXT`'s
own `DOVAR` dispatch already uses.

Because it's branching, not independent, switching into a vocabulary
never loses access to words that already existed before the branch —
`USE SYSTEM` doesn't lose `DUP`/`DROP`. And because `WORDS`/`findWord`
were never touched — they already just walk from `LATEST`, unchanged
since M8 — a vocabulary switch changes what they see *for free*: no
`dictionary.ts` changes at all. **A fully independent-chains-with-
search-order model (closer to ANS Forth) was considered and rejected**
specifically because it would need `findWord` to walk a list of
chains instead of one, real engine surface the simpler, requested
model avoids entirely.

Verified live from a genuinely clean, file-only boot: `VOCABULARY
PROJECT`, `USE PROJECT`, define a word — visible via `read_dictionary`
alongside everything that existed at the branch point, not anything
from a sibling vocabulary; `USE FORTH` — the new word disappears from
both listing *and* lookup (`? unrecognized word`), while `PROJECT`
itself (defined before the branch) stays visible; switching back
round-trips exactly.

*Implementation:* `sysvars.ts` (`fieldOffset` made public),
`primitives.ts`/`rebel-opcodes.json` (token 95, `LATEST-ADDR`),
`packages/app/public/system.fth` (`CURRENT-VOCAB`, `VOCABULARY`,
`FORTH`, `USE`).

---

### 1.35 `HIDE`: decluttering `SEE`'s own support words (M14, `DEVELOPING.md` §8.5)

The `VOCABULARY`-based re-filing §8.5 originally sketched doesn't
work: branching chains (§1.34) only let a *later* vocabulary see an
*earlier* one, never the reverse, and "found by lookup" and "listed
by `WORDS`" are the same chain-walk — no way to get one without the
other under that mechanism. `HIDE` fits instead, reusing
`FLAG_HIDDEN` — the exact bit `findWord`/`listDictionaryEntries`
already skip for a colon-definition mid-compilation, applied here
permanently. An already-compiled caller is unaffected by hiding a
word it calls, since compiled calls are raw addresses, not names
re-resolved at call time. Zero engine changes — pure Forth, reusing
`>CFA`/`XT-NAME`'s own reverse chain-walk shape (given an `xt`, find
the entry whose own `>CFA` matches it) to set a flag instead of
printing a name.

**A real sequencing constraint:** every `HIDE` call has to happen
after *everything* that still needs to find the target by name during
its own compilation has already been compiled — for `>CFA`/`XT-NAME`/
the `-XT` constants, that means after `SEE` itself, not immediately
after each individual helper, since `findWord` skips hidden entries
during compilation too and `SEE`'s own body needs to find all of them
by name right up until its closing `;`.

*Implementation:* `packages/app/public/system.fth` (`HIDE`, and the
seven `HIDE <name>` calls after `SEE`). No engine changes.

### 1.36 `EXECUTE` (M15)

`EXECUTE ( xt -- )` runs the word whose Code Field address is on the
stack, exactly as if it had been called directly — the gap M13/M14
both flagged and deferred (`USE`'s own `' <name> 8 +` addressing had
to work around not having it; nothing else in scope needed it until
now). A new primitive token, 96, no `immediate`/`compileOnly` flags —
an ordinary runtime word, auto-registered into the dictionary by
`Machine`'s constructor loop over `opcodes.primitives` with zero
`repl.ts`/`dictionary.ts` changes.

**Why `inner.ts`, not a `primitives.ts` case:** the same reason
`ACCEPT` lives there — `executePrimitive`'s switch runs to completion
in one synchronous call and has no way to reach `executeXT`.
`Inner.dispatch()` special-cases `EXECUTE_TOKEN` right alongside
`ACCEPT_TOKEN`/`KEY_TOKEN`: pop the `xt`, then `yield*
this.executeXT(xt)`. Because `executeXT`/`threadFrom` already
push/pop their own return-stack sentinel on *every* call — compiled
(a `DOCOL` slot inside another word's body) or not — recursing into
`executeXT` from `dispatch()` is exactly the same shape as a nested
call, just reached from a dynamic runtime value instead of a
compile-time slot address. This is what makes `EXECUTE` correctly
inherit, for free: `DOCOL`/`DOVAR`/`DOCON`/`DODOES` dispatch,
word-level breakpoints (`checkBreakpoint` fires identically whether
the `xt` was reached via a compiled call or `EXECUTE`), and nested
blocking (`KEY`/`ACCEPT` inside the executed word suspend the whole
generator chain exactly as they would from a direct call).

*Implementation:* `rebel-opcodes.json` (token 96), `inner.ts`
(`EXECUTE_TOKEN` in `dispatch()`). No `primitives.ts` case — it never
reaches the switch.

### 1.37 `S"`/`."` real interpret-time behavior, and the `PAD` bank (M16, `DEVELOPING.md` §7)

`S"`/`."` were `compileOnly` since M8 — an engine limitation (no
interpret-time behavior had been built), not a real Forth semantic.
Both are now dual-mode: `compileOnly` dropped from `rebel-opcodes.json`
(`immediate` stays — both still need to run at "compile" time to parse
the quoted text either way), and `primitives.ts`'s case 68 (`S"`)/case
70 (`."`) each branch on `ctx.sysvars.getState()`. Compiling is
unchanged: inline `(SLIT)`+length+bytes for `S"`; the same plus a
compiled `TYPE` call for `."`. Interpreting is new, and deliberately
*not* unified into one shared helper — `S" ( -- addr len )` must
persist bytes for the caller to consume afterward; `." ( -- )` only
needs to print immediately, no persistence at all.

**The `PAD` bank:** a new 128-byte bank (tag `PAD`, sized like `TIB`),
created in `repl.ts` right alongside `tibBank`, exposed to
`primitives.ts` as two new `PrimitiveContext` fields — `padBase`/
`padSize`. Interpreted `S"` copies its text into `PAD` and pushes
`padBase`, then the length; interpreted `."` never touches `PAD` at
all, it emits directly through `screen.emit()`. `PAD` is a single
shared, overwritten-on-every-call region — no reentrancy/nesting
support, the same footgun real Forth's own `PAD` has, documented not
hidden. An oversized interpreted string (longer than `padSize`) throws
rather than silently corrupting adjacent arena memory.

**Rejected alternative:** reusing the already-idle `TIB` bank instead
of adding a new one. Technically safe today — `TIB`'s bytes are copied
out into a JS token array before the outer interpreter ever dispatches
a word, so `S"` writing into `TIB` mid-line couldn't actually collide
with anything live — but rejected as an *implicit* "doesn't overlap
today" coupling between `ACCEPT` and `S"` rather than a named contract,
the same mistake class as the `VOCABULARY`-based re-filing idea §1.35
rejected in favor of `HIDE`. A dedicated `PAD` bank is the minimum real
mechanism for what `S"` actually needs, not a clever reuse that would
quietly couple two otherwise-unrelated subsystems.

**A free addition:** `PAD ( -- addr )`, primitive 97 — the bank already
has to exist for `S"` to work, so exposing its address to Forth costs
nothing extra, mirroring the `HERE`/`LATEST` precedent.

*Implementation:* `rebel-opcodes.json` (drop `compileOnly` from 68/70,
add the `PAD` bank tag, add primitive 97), `repl.ts` (new `padBank`,
`padBase`/`padSize` fields), `primitives.ts` (dual-mode cases 68/70, a
one-line case 97). `inner.ts`: no changes — `(SLIT)`'s guard concerns
the compiled-mode runtime helper token, an unrelated code path.

### 1.38 `ABORT`, and a fixed return-stack leak (M17, `DEVELOPING.md` §9)

Originally scoped as a full `THROW`/`CATCH`/`ABORT` exception model,
then deliberately trimmed to just `ABORT` before implementing — see
`DEVELOPING.md` §9 for the full reasoning (`THROW`/`CATCH` and
everything that existed only to serve them are tabled, not built ahead
of an actual need).

`ABORT ( -- )`, primitive 98, an ordinary `primitives.ts` case: empty
the data stack, then `throw new Error('ABORT')`. `DataStack` gains a
new `clear()` method (`this.sp = bank.base + bank.size`) — `ABORT`'s
only real new piece of shared mechanism. No dedicated error class:
without `CATCH`, nothing needs to distinguish `ABORT` from any other
error, so it surfaces uncaught through the exact same `? <message>`
path every error already used (`? ABORT`).

**A real bug, found while scoping and fixed here:** `threadFrom()`'s
rstack sentinel push (`inner.ts`) has no `try`/`finally`, so any
exception thrown from inside a compiled call leaves that push on
`rstack` permanently — confirmed empirically (repeatedly interpreting
a throwing word grows `rstack.depth` by exactly one *per error*,
unbounded). `replLoop`'s catch block now clears both `stack` and
`rstack` on any uncaught error, not just explicit `ABORT` — otherwise
`ABORT` would clear the data stack while leaving the return stack
silently corrupted. Deliberately **not** applied to `interpret()`/
`runLine()` — that programmatic contract (used by every engine test)
is unchanged; only the interactive `replLoop` gets the new recovery
behavior.

*Implementation:* `stack.ts` (`DataStack.clear()`), `rebel-opcodes.json`
(token 98), `primitives.ts` (case 98), `repl.ts` (`replLoop`'s catch
block clears both stacks).

### 1.39 `BANK@` (M18, `DEVELOPING.md` §10)

Scoped since `DEVELOPING.md` §10 but deliberately not built ahead of
an actual need. The need: reaching sysvars purely from Forth source.
Considered generalizing `LATEST-ADDR` into a named lookup (`SYSV@
( "group" "field" -- addr )`, mirroring `BANK@`'s own tag lookup) —
declined in favor of something simpler: `BANK@` alone, plus a
**hardcoded** group/field offset (`rebel-opcodes.json`'s
`sysvarGroups` table already has these) added to the bank's base
address, avoiding a second named-lookup primitive for one layer of
redirection that wasn't needed.

`BANK@ ( "tag" -- addr )`, primitive 99: parses the next input token
via the same `nextInputToken()` mechanism `'`/`CREATE`/`VARIABLE`/
`CONSTANT`/`S"`/`VOCABULARY`/`USE` already use (not a stack-based
string), uppercases it (`findWord`'s own case-insensitivity
convention), looks up the first bank of that tag via
`ctx.banks.findBank()` (pre-existing, unchanged), pushes `addr`, or
throws `? unknown bank: <TAG>` — same convention as `'` on an
unrecognized word. `PrimitiveContext` gains a `banks: BankTable`
field; `Machine` already satisfied it structurally, same precedent as
`padBase`/`padSize` (M16). No `inner.ts` change — a plain synchronous
case.

**Addr only, not `addr size`:** matches every other `SOMETHING@`
word's one-value convention. `Bank.size` (and `flags`) isn't returned —
`BANK-SIZE` (§1.62) fills the size half later, once a real need for it
showed up.

**Update, M50 (found by Oliver while adding `BANK-SIZE`): resolves by
`name` now, not `tag`.** The paragraphs above describe M18 as shipped
— genuinely accurate at the time, when `name` uniqueness didn't exist
yet and no tag had more than one bank. Once both became real (M5's
identity retrofit; project `DATA` assets), tag-keyed lookup became a
real, demonstrated ambiguity: two banks sharing a tag, and `BANK@`
could only ever reach whichever was created first — the second was
permanently unreachable through it, silently. `name` is the real,
uniqueness-backed identity (`banks.ts`, `spec/02-MEMORY-MODEL.md`
§4.7); every boot-created system bank now has an explicit `name`
matching its `tag` (`repl.ts`), so `BANK@ SYSV`-style lookups are
unaffected — only banks that genuinely share a tag (`BLKS` → `EDITOR`,
project `DATA` assets) need their real name instead. Same parsing/
uppercasing/error-message shape throughout, just `findBankByName()`
instead of a tag-keyed lookup. `BANK-SIZE` (§1.62) was built name-based
from the start; this made `BANK@` consistent with it, not the reverse.

API-mediated rather than an arena-resident table, purely on
implementation economics: `BankTable` (`banks.ts`) is plain host-side
TS, not arena-backed data, so a primitive avoids inventing a wire
format with no other consumer. Reaches shared and per-arena banks
identically — multi-arena memory-access isolation is a confirmed
non-goal (`DEVELOPING.md` §10), not something `BANK@` needs to
enforce.

**Not immediate**, matching `'`: consumes its input-cursor token at
*runtime*. This means it can be called from inside a compiled
definition to consume whatever the *caller* typed next, but a literal
tag written directly after `BANK@` inside a `: ... ;` body doesn't
work — the compiler tries to compile a call to that name instead.
Confirmed live during verification, not a regression — the same known
limitation `'` already has without a `[']`-style compile-time-literal
word (not built in this project either).

*Implementation:* `rebel-opcodes.json` (token 99), `primitives.ts`
(`PrimitiveContext` gains `banks: BankTable`, case 99), no `repl.ts`
change.

### 1.40 `MMAP` — the arena-resident bank table, and `CORE.ARENA-SIZE` (M19, `DEVELOPING.md` §11)

Full motivation in `DEVELOPING.md` §11: a persistence/snapshot
discussion flagged `BankTable` as host-side (can't reconstruct bank
layout from a raw arena-byte dump alone); a separate finding confirmed
`DIRTY` is genuinely inert on both this project and `rebel-rom`; and
`rebel-rom/docs/MEMORY-MODEL.md` §3.2 itself confirms arena-resident
bank data was the *original* Phase 3 design, deliberately deferred
until Forth needed raw address access — exactly what's arriving here.

New module `mmap.ts`: `MemoryMap` (arena-byte accessor — header
init, next-free/slot-count tracking, per-slot read/write) plus wire
constants `MMAP_TAG`, `MMAP_MAX_SLOTS = 64` (matches `rebel-rom`'s real
`BANK_TABLE_MAX_BANKS`), `MMAP_SIZE` (12-byte header + 64 24-byte
slots = 1548 bytes). Slot layout: `tag`(4) + `name`(8) + `base`(4-cell)
+ `size`(4-cell) + `flags`(4-cell) — proposed, not a finalized
cross-target contract (mirrored into `rebel-rom/CHANGES.md`).

`BankTable`'s constructor (`banks.ts`) reserves `MMAP`'s space first,
writes its header, and registers + mirrors itself into its own slot 0
— resolving the self-referential bootstrap by having `MMAP` describe
itself, not treating itself as a special case. Every `createBank()`
call after that mirrors its result into the next free `MMAP` slot and
advances `MMAP`'s own next-free cell, **in addition to** the existing
host-side `banks` array — `findBank()`/`getAllBanks()` are completely
unchanged. This is a **mirror, not yet the source of truth**: Forth
can't create banks yet, and `BANK@`/`Machine.banks` still read the
host array, not `MMAP` — both real, explicit follow-on work.

`Bank` gained a real `flags` field for the first time: `BankFlagResident`/
`BankFlagExternal`/`BankFlagSwappable`/`BankFlagDirty` match
`rebel-rom`'s real `TBankFlags` bit-for-bit; `BankFlagActive` (bit 4) is
a new Rebel-Sim-first addition, default-on — pure per-slot occupancy for
`mmap.ts`'s own bump allocator (a slot with it set is a real,
currently-allocated bank; without it, free for `allocate()` to reuse),
not the "atomic exclusion during an async flush" guard this section
originally described (a real, since-corrected mismatch between the
flag's originally-discussed motivation and what actually shipped, made
doubly moot at M33 anyway — `saveAsset()` is fully synchronous now, so
there's no longer an await point for anything to interleave with)
instead of finally wiring up `DIRTY`, which needs a write-interception
point neither side's `@`/`!` gives it.

**A real bug, found and fixed:** the first pass had `mmap.ts` importing
`BANK_NAME_LEN` from `banks.ts` while `banks.ts` imports `MemoryMap`
from `mmap.ts` — a circular ES module dependency that left
`BANK_NAME_LEN` `undefined` at `mmap.ts`'s module-init time, corrupting
every slot-offset computation. Surfaced as "MMAP is full (64 slots)" on
the *ninth* bank ever created, not an obvious `undefined` crash —
root-caused by building to `dist/` and running a throwaway `node -e`
script directly against it. Fixed by hardcoding the one needed value
(`8`) in `mmap.ts` instead of importing it.

Separately, `CORE.ARENA-SIZE` (`rebel-opcodes.json`'s `sysvarGroups`):
total arena size in bytes, written once at `Machine` construction via
`setUnsigned` (can exceed the signed 32-bit range at the theoretical 4
GiB max), readable from Forth like any sysvar. `rebel-rom`'s real
`TCoreSysVars` doesn't have this field either (checked directly) — a
genuine new cross-target candidate, not something already there to
match.

*Implementation:* `mmap.ts` (new), `banks.ts` (`Bank` gains `flags`,
flag constants, `BankTable` constructor + `createBank()` wire into
`MemoryMap`), `index.ts` (new exports), `rebel-opcodes.json`
(`CORE.ARENA-SIZE` field), `repl.ts` (one line setting `ARENA-SIZE`).

### 1.41 `BANK@` reads `MMAP` directly (M20, `DEVELOPING.md` §12)

**Superseded, M50 (§1.62):** `findBankAddr()` is deleted outright —
`BANK@` resolves by `name` now, not `tag`, so this tag-keyed read path
has no caller left. Kept below as the historical record of what M20
actually shipped.

The smaller, more contained half of M19's own "Follow-on, not
resolved" note — a pure read-path swap made possible because M19
already proved `MMAP` is a correct mirror of the host bank table, in
the same creation order.

`MemoryMap` (`mmap.ts`) gained `findBankAddr(tag: string): number |
undefined` — walks every slot in use, returns the first match's
`base`, matching `findBank(tag)`'s own "first bank of this type, in
creation order" semantics exactly. `BANK@` (`primitives.ts` case 99)
changed its one lookup line from `ctx.banks.findBank(tag)` to
`ctx.banks.mmap.findBankAddr(tag)` — parsing, uppercasing, the
`? unknown bank: <TAG>` error, and not being `IMMEDIATE` are all
byte-for-byte unchanged. `PrimitiveContext`'s shape didn't change —
`banks: BankTable` (M18) already covered this.

Verified by the *unmodified* `bank-access.test.ts` suite (7 tests)
passing exactly as before — the actual proof this didn't change
`BANK@`'s observable behavior, not just an argument for it.

*Implementation:* `mmap.ts` (`findBankAddr()`), `primitives.ts` (case
99's one lookup line), `rebel-opcodes.json` (note update). No
`PrimitiveContext`/`repl.ts` change.

### 1.42 `CREATE-BANK` — Forth-side bank creation (M21, `DEVELOPING.md` §13)

The larger, harder-to-walk-back half of M19's own follow-on —
`DEVELOPING.md` §11 had already committed to "no host round-trip
needed" for creation, not just lookup.

`CREATE-BANK ( size "tag" -- addr )`, primitive 100: pops `size`,
parses the next input token like `BANK@` does, uppercases it, and (as
of M22, see §1.43 — originally called `MemoryMap.addBank()` with a
`getNextFree()`-read `base`, both since removed) calls
`ctx.banks.mmap.allocate(tag, tag, size, RESIDENT | ACTIVE)` directly.
Name always equals the (truncated) tag: no auto-serial naming (a
primitive bypassing `BankTable` has no business reaching its private
serial counter — a second, independent counter would let two counters
collide by construction), no out-of-space check beyond `MMAP`'s own
64-slot cap (relies on `DataView`'s own bounds-checking at first real
access).

**Real, named consequence at the time — since closed by M22 (§1.43):**
a bank created this way was invisible to `BankTable.getAllBanks()`/
`findBank()` (and `storage.ts`/`read_banks`/the inspector panel) when
this milestone shipped, since `CREATE-BANK` never touched `BankTable`'s
own array, only `MMAP`. `getAllBanks()`/`findBank()` read `MMAP`
directly as of M22, so this gap no longer exists — kept here as the
historical record of what M21 actually shipped.

**A real gotcha, found while testing, still true today (though its
field changed under it — see §1.62):** a tag over 4 characters
truncates on write (the fixed field width every real tag already
respects by convention). Originally about `BANK@`'s own tag-keyed
search string; now that `BANK@`/`BANK-SIZE` resolve by `name` (M50),
the live version of this gotcha is `name`'s own 8-character field
(`BANK_NAME_LEN`, `banks.ts`) — a `CREATE-BANK` call's auto-generated
serial name is always exactly 8 digits so this never bites there, but
an explicit `name` passed host-side (`repl.ts`'s boot banks, `storage.ts`
asset restoration) truncates the same way a >4-char tag always did.

*Implementation:* `rebel-opcodes.json` (token 100), `primitives.ts`
(case 100, imports `BankFlagResident`/`BankFlagActive`). No
`PrimitiveContext`/`repl.ts` change.

### 1.43 `MMAP` becomes the real source of truth, no cached state anywhere (M22, `DEVELOPING.md` §14)

Scoped after a real design pivot: first as "consolidate two drifting
`nextFree` cursors into one," then corrected directly — `ACTIVE` is
per-slot occupancy, not a flush-safety detail (flush-safety stayed
explicitly out of scope) — and taken to its conclusion: no cursor cell
at all, everything derived by scanning `MMAP`'s 64 fixed slots.

**The bug that motivated this:** `CREATE-BANK` (M21) advanced `MMAP`'s
own next-free cell independently of `BankTable`'s private `nextFree`
counter, so a host-created bank made *after* a Forth-created one could
land at the exact same address — a real overlap, reproduced directly
(`64 CREATE-BANK FTAG` then `createBank('DATA', 64, 'HOSTBANK')` both
landed at `84924` before this fix).

`mmap.ts` gained `allocate(tag, name, size, flags): MMapSlot`,
replacing `addBank()`/`getNextFree()`/`getSlotCount()` outright (not
deprecated — deleted). One pass over all 64 slots: the first with
`ACTIVE` off becomes the target, `max(base + size)` over every
currently-`ACTIVE` slot becomes the new `base`; writes the descriptor,
sets `ACTIVE` last ("prepare it, then switch it on" — the slot is
already inactive, so occupancy only becomes true once the descriptor
is fully written). `MMAP`'s header shrank from 12 bytes
(magic+version+reserved+nextFree+slotCount) to 4
(magic+version+reserved) — `MMAP_SIZE` is now 1540, not 1548; every
other bank's base shifts down by exactly 8 bytes as a direct,
confirmed-live consequence.

The `BankFlag*` constants moved from `banks.ts` into `mmap.ts`
(re-exported from `banks.ts` for the existing public surface) — `mmap.ts`
needs `ACTIVE` natively now, as part of its own occupancy model, not
as an opaque caller-supplied bit. Doing it this direction (rather than
importing `BankFlagActive` from `banks.ts` into `mmap.ts`) deliberately
avoids recreating M19's own circular-import bug the other way around.

`BankTable.createBank()`/`getAllBanks()`/`findBank()`/`findBankByName()`
all delegate to `mmap` now. The private `banks: Bank[]` array,
`nextFree` counter, and the `arena.sizeBytes` out-of-space check in
`createBank()` are all gone — the last one deliberately: unifying
host-side creation with `CREATE-BANK`'s own "`DataView` catches it at
first real access" precedent, rather than leaving host-only validation
as a new asymmetry between the two creators. `nextSerial` (auto-serial
naming) is untouched — `CREATE-BANK` never generates one, so it was
never exposed to this bug class.

**Real, closing consequence:** `CREATE-BANK`'s M21 visibility gap is
closed — `getAllBanks()`/`findBank()`/`read_banks`/the inspector panel
all see a Forth-created bank now, confirmed live (`DAT1 DAT1 84916
4096` shows up in `read_banks` and the inspector screenshot right
alongside every host-created bank).

**A second real bug, found while implementing, not scoping:**
`allocate()` unconditionally forces `ACTIVE` into what it *writes*, but
an early version of `createBank()` built its returned `Bank` from the
caller's raw `flags` parameter, not from what actually got persisted.
Any caller supplying `flags` without `ACTIVE` already set — exactly the
pre-existing "respects a caller-supplied flags value" test
(`BankFlagExternal` alone) — silently disagreed: `bank.flags` (2) vs.
the real stored `18` (`EXTERNAL | ACTIVE`). Caught immediately by that
existing test. Fixed by having `allocate()` return the actual stored
`MMapSlot` (structurally identical to `Bank`, so a direct return, no
transform) instead of just a `base: number`.

**Real behavioral change:** object identity is no longer stable —
`getAllBanks()`/`findBank()`/`findBankByName()` now decode fresh
objects from arena bytes on every call, rather than returning cached
references. Three `.toBe()` assertions in `banks.test.ts` became
`.toEqual()`.

*Implementation:* `mmap.ts` (`BankFlag*` moved in, `allocate()` new,
`getNextFree()`/`getSlotCount()`/`addBank()` removed, header/`MMAP_SIZE`
shrunk), `banks.ts` (re-exports `BankFlag*`, `createBank()`/reads
delegate to `mmap`, `banks`/`nextFree` fields removed), `primitives.ts`
(case 100 calls `allocate()` directly). No `PrimitiveContext`/`repl.ts`
change.

### 1.44 A batch of 13 low-level primitives (M23, `DEVELOPING.md` §15)

Thirteen new primitives, tokens 101-113, filling real gaps a review of
the token table against M8's own §9 ("STANDARD-for-now, native for
now") turned up: `XOR` (the bitwise op `AND`/`OR`/`INVERT` never got a
companion for), `.S` (non-destructive stack print — reuses `.`'s own
digit-formatting loop, applied to `[...stack.toArray()].reverse()`
since `toArray()` is top-to-bottom and classic `.S` prints
deepest-first), `2SWAP`/`2OVER` (generalizing `SWAP`/`OVER` the way
`2DUP`/`2DROP` already generalized `DUP`/`DROP`), `CELLS`/`CELL+`
(cell-unit address arithmetic — removes the manual `4 *`/`4 +` every
site did by hand), `FILL`/`CMOVE` (block memory ops — first real use
is initializing a freshly `CREATE-BANK`'d region without a hand-rolled
loop), `BL`/`SPACE` (named as candidates back in `CORE-VOCABULARY.md`
§12, not added until now), `WITHIN` (deliberately plain-signed,
non-wraparound — not full ANS `WITHIN`'s modular-arithmetic
definition, since `U<` already covers the one place unsigned
comparison was actually needed), and `PICK`/`ROLL` (generalizing
`OVER`/`ROT` to arbitrary depth — `ROLL` is the one word here that
isn't a handful of lines, needing an explicit pop-into-array/
reorder/push-back loop since `DataStack` has no splice-at-depth
primitive).

Every one is a plain stack-effect primitive — none needed
`IMMEDIATE`/`COMPILE_ONLY` or inner-interpreter special-casing, so
`repl.ts`'s boot-registration loop (already walking `opcodes.primitives`
generically) picked all 13 up with zero changes of its own, exactly as
`dictionary.ts`/`inner.ts` predicted going in.

*Implementation:* `rebel-opcodes.json` (13 new entries), `primitives.ts`
(13 new `case` arms after 100, `CELL_SIZE` added to the existing
`arena.js` import). New `low-level-batch.test.ts` (13 cases + edge
cases). No `repl.ts`/`dictionary.ts`/`inner.ts`/`system.fth` change.

### 1.45 `BASE`/`HEX`/`DECIMAL` — radix control from Forth source (M24, `DEVELOPING.md` §16)

`FORTH.BASE` already drove both numeric parsing (`parseNumber` in
`repl.ts`) and output formatting (`.`/`.S`) — nothing let Forth source
itself read or change it. `BASE` (token 114) closes that the same way
`LATEST-ADDR` (M13) closed it for `LATEST`: `ctx.sysvars.fieldOffset(
'FORTH', 'BASE')` pushed as an address, so `BASE @`/`n BASE !` work
exactly like a real Forth variable — not a read-only value word the
way `HERE`/`LATEST` are. `HEX`/`DECIMAL` (115/116) are two-line
`setBase(16)`/`setBase(10)` calls onto the `Sysvars` method `repl.ts`'s
own boot code already used.

**A real gotcha, documented before it bit anything in production, then
actually encountered while writing the test for it:** `parseNumber`
re-reads `BASE` per token, not per line — so `HEX` doesn't just affect
non-numeric-looking input, it affects *every* subsequent numeric
token, including ones that look like decimal numbers (`10` under
`BASE 16` is decimal sixteen). A first-draft test, `HEX 255 .`,
intended to demonstrate hex output, instead got bitten by exactly
this: `255`'s own digits are all valid hex digits, so it parsed as hex
under the just-switched base before `.` ever ran. Fixed by reordering
(`255 HEX .` — the literal parses while still decimal, only the print
happens under the new base); the gotcha itself became its own
explicit assertion (`HEX 10 DECIMAL` leaves `16` on the stack).

*Implementation:* `rebel-opcodes.json` (3 new entries), `primitives.ts`
(3 new `case` arms after 113, no new imports — `ctx.sysvars` was
already accessible). Tests appended to `low-level-batch.test.ts`. No
`repl.ts`/`dictionary.ts`/`inner.ts`/`system.fth` change.

### 1.46 A visible, inverse-video text cursor: `CURSEN`/`CURSDIS` (M25, `DEVELOPING.md` §17)

Checked directly against both targets before designing anything:
neither `screenmodule.cpp` nor `screen.ts` has ever rendered a visible
cursor — `CURSOR-X`/`CURSOR-Y` are pure write-position trackers. New
ground, not a HAL gap.

**Layer, reasoned through by tracing `EMIT`'s real call sequence, not
guessed:** `Screen`-level (`screen.ts`), not HAL, not Forth.
`writeChar()` never auto-inverts — `EMIT` calls it while the cursor
sysvars still point at the cell being typed into, so an auto-invert
there would highlight the character being actively typed, not the
cursor's actual resting place. Instead, `setCursor()` itself gained
the redraw hook: capture the old `(col, row)` before overwriting the
sysvars, and if `SCREEN.CURSOR-VISIBLE` is set, redraw the old cell
plain then the new cell inverted. Because `advanceCursor()`, `EMIT`'s
`CR`/`LF` handling, and the `AT-XY` primitive all already route
through `setCursor()`, every cursor-movement path gets correct
behavior for free — zero changes needed at any of those call sites.

Restoring the cell the cursor leaves costs nothing new: `CHAR` only
ever stores the character code, never per-cell color, so
`redrawCursorAt()` just re-blits `readChar(col, row)` with the
*current* global `INK`/`PAPER` — nothing to remember. `rebel-rom`
itself leans on the identical fact already: `CScreenModule::Redraw()`
(`screenmodule.h`) repaints every cell purely from `m_pCharBank`'s
stored bytes, real precedent for "`CHAR` content is always enough to
redraw correctly," not a new assumption.

**A real ordering bug, found while tracing `cls()`, not assumed, fixed
as part of this change:** `cls()` used to call `setCursor(0, 0)`
*before* `hal.clearScreen()` — under the new redraw hook, that would
draw the inverted cursor at `(0,0)` and then immediately paint over it
with the full-framebuffer clear. Fixed by reordering: clear first,
then reset the cursor, so any redraw happens after the screen is
actually clear.

New sysvar `SCREEN.CURSOR-VISIBLE` (offset 32, `HAL` boolean
convention, defaults `FALSE`) — the reverse of this group's usual
direction, same situation `CORE.ARENA-SIZE` (M19) was in:
`rebel-rom/src/sysvars.h`'s real `TScreenSysVars` has no such field
either, since no target renders a cursor yet, so this is a genuine
cross-target candidate proposed from the Rebel-Sim side.

**A first-draft test caught its own wrong assumption, not shipped
wrong:** "typing a character draws it normally, not inverted" assumed
exactly two `blitGlyph` calls. Actual is three — `EMIT`'s content
write, then `setCursor`'s "restore the old cell" redraw (which now
reads back the *just-typed* character, not a space, and redraws it
normally — a harmless duplicate blit, exactly the "wasted-but-harmless
double-blit" the scoping doc predicted before any code was written),
then the real inverted redraw at the new position. Confirmed against
the built `dist/` via a throwaway script before fixing the test.

*Implementation:* `screen.ts` (`redrawCursorAt()`, `isCursorVisible()`,
`showCursor()`/`hideCursor()`, `setCursor()`'s redraw hook, `cls()`
reordered), `rebel-opcodes.json` (`SCREEN.CURSOR-VISIBLE` field, 2 new
primitive entries), `primitives.ts` (2 new `case` arms). Tests in a
new `describe` block in `screen.test.ts`. No `dictionary.ts`/
`inner.ts`/`repl.ts` change.

### 1.47 Wiring the cursor into the interactive REPL (M26, `DEVELOPING.md` §18)

§1.46 shipped the mechanism but left it unwired — the on-screen REPL
booted with no visible cursor until a human typed `CURSEN` first.
**Not simply "default the sysvar to `TRUE`"**: the redraw only ever
fires from inside `setCursor()`/`showCursor()`/`hideCursor()`, never
from the sysvar write itself, so a bare default would stay invisible
until the first keystroke moved the cursor — not "visible from the
first prompt." And doing it in `Machine`'s constructor (the only
natural place for a default) would affect every `interpret()`/
`beginLine()` caller across the whole engine test suite, not just the
interactive REPL, breaking §1.46's own opt-in contract.

`repl.ts`'s own header comment already names the right boundary:
`startRepl()` is "a self-contained, never-completing on-screen REPL,"
distinct from `beginLine()`/`interpret()` ("feeding a line
programmatically (tests, mainly)"). One line —
`this.screen.showCursor();` — at the top of `startRepl()`, before the
prompt-loop generator is even created, shows the cursor at `(0,0)`
immediately; the first `emitString('> ')` then naturally moves and
redraws it via the same hook §1.46 already built.

*Implementation:* `repl.ts` only, one line in `startRepl()`. Two new
tests in `screen.test.ts`'s cursor `describe` block (shows
immediately; a plain `interpret()` session never shows one). Full
engine suite: 246 passed (244+2), zero pre-existing tests changed —
direct confirmation every programmatic caller stayed untouched.
Live-verified: a fresh page load now shows the cursor at the very
first prompt, no keystroke needed.

### 1.48 A real bank-naming collision, and `MMAP`'s header grows (M27, `DEVELOPING.md` §20)

Found while reviewing whether `CREATE-BANK` (M21) gets the same
storage treatment as host-created banks: it bypasses the
name-uniqueness check `BankTable.createBank()` enforces everywhere
else, and names a bank after its own tag — so two Forth-created banks
sharing a tag always collided on name. Reproduced directly
(`64 CREATE-BANK DATA` twice → both `"DATA"`), then traced through to
two real storage failures: `saveAsset()` silently overwrites the
first bank's file (same `${name}.${ext}` path); `openProject()`
throws on the collision and aborts the *entire* project load, unlike
every other malformed-asset case (short read, bad extension,
oversized payload), which is skipped gracefully.

**Two rejected designs, in order.** Failing loudly on the collision
instead was rejected — better to just make the name unique, the way
host-side `createBank()` already does via its own private
`nextSerial` counter when no name is given. Making that counter
public so `CREATE-BANK`'s primitive could call it was rejected too —
doesn't make it *shared*, just gives one more caller private access,
and still means reaching back into `BankTable`, undoing M21's "zero
host round-trip" property. A sysvar-backed counter (`FORTH.NEXT-BANK`)
solved the sharing problem but needed an `attachSysvars()` bridge
method on `BankTable` to solve a real chicken-and-egg problem —
`Sysvars` doesn't exist until *after* `BankTable` has already created
the `SYSV` bank itself, confirmed by reading `repl.ts`'s actual
constructor order. Correctly called out as too convoluted.

**What shipped**: the counter lives in `MMAP`'s own header instead.
`MemoryMap` is constructed and fully usable from the very first line
of `BankTable`'s constructor, before `Sysvars` exists at all — no
bootstrap-ordering problem, no attach step, no dual-mode counter.
`BankTable`'s own fallback and `CREATE-BANK`'s primitive both call
`MemoryMap.nextBankSerial()` directly.

`MMAP`'s header grows 4→16 bytes: `NEXT-BANK` (the shared counter —
genuinely necessary persistent state, unlike M22's removed cursor
cells, which were *derivable* by scanning and so didn't need to
exist), `ARENA-SIZE` (moved out of `CORE.ARENA-SIZE` — arena
bookkeeping, not Forth-interpreter state; checked low-risk to move,
only one test and no app code depended on the sysvar), `ARENA-ID`
(reserved, `0`, explicitly for future multi-arena bookkeeping per
direct instruction — no consumer today, same precedent as the
reserved `SWAPPABLE`/`DIRTY` bank flags).

*Implementation:* `mmap.ts` (`HEADER_SIZE` 4→16, `initHeader()`
writes the three new cells, new `nextBankSerial()`), `banks.ts`
(`nextSerial` private field removed, `generateSerialName()` now one
line calling `mmap.nextBankSerial()`), `primitives.ts` (`CREATE-BANK`
builds its name the same way), `repl.ts` (the old `CORE.ARENA-SIZE`
write deleted — `MMAP.initHeader()` already covers it), `rebel-opcodes.json`
(`CORE.ARENA-SIZE` field removed). Five pre-existing tests updated
(a hardcoded old header-size offset, three "name equals tag"
assumptions inverted), two new ones added — genuine host/Forth
interleaved-serial sharing, and an end-to-end `storage.test.ts` case
reproducing the original bug fully fixed, not just a `MemoryMap`-level
unit assertion. Full engine suite: 248 passed (246+2). Live-verified:
`MMAP` now `1552` bytes, every existing bank's serial name
byte-identical to before this change, `CREATE-BANK`'s serials now
genuinely sequential with no collision.

### 1.49 The stack pointer becomes a real sysvar: `SP@`/`SP!`/`SP0`, `RP@`/`RP!`/`RP0` (M28, `DEVELOPING.md` §21)

Prompted by a Forth-tutorial question — why no `SP0`/`SP@`? Checking
turned up the same shape of problem M27 (§1.48) fixed for the
bank-naming counter: `FORTH.SP0`/`RP0` were already reserved in
`rebel-opcodes.json` but never written, while the *real* live pointer
was `DataStack`'s own private `sp` field, with no arena address at
all. Corrected per direct instruction: sysvars should be the *only*
place this state lives — the engine keeps no copy of its own,
matching how `HERE`/`LATEST`/`BASE`/`STATE` already work, and how
`Screen`/`Keyboard` already take a `Sysvars` reference rather than
mirror sysvar-owned state locally.

**Two sysvar fields per stack.** `SP0`/`RP0` (already reserved, `FORTH`
group offsets 0/4) hold the constant address the pointer equals when
empty — written once at construction, never touched again. Two new
fields, `SP`/`RP` (offsets 24/28), hold the *live* pointer, read and
written on every `push`/`pop`/`peek`/`clear`.

`DataStack`'s constructor now takes `(arena, bank, sysvars, baseField,
liveField)` instead of just `(arena, bank)`. Its private `sp: number`
field is gone entirely, replaced by a private getter/setter pair over
`sysvars.getUnsigned`/`setUnsigned('FORTH', this.liveField)` — every
call site inside `push`/`pop`/`peek`/`depth`/`clear` still reads
`this.sp`, textually unchanged; only where the four bytes physically
live moved. A new public `getPointer()`/`setPointer(addr)` pair is the
only way outside code (the new primitives) reaches the value — `sp`
itself stays private. `repl.ts` constructs the two stacks as
`new DataStack(arena, dstkBank, sysvars, 'SP0', 'SP')` and
`new DataStack(arena, rstkBank, sysvars, 'RP0', 'RP')` — no
construction-order problem, since `Sysvars` already exists well before
either stack is built.

Six new primitives, symmetric across both stacks: `SP0`/`RP0` push the
constant base; `SP@`/`RP@` push the live pointer; `SP!`/`RP!` pop an
address and become the new live pointer — the standard `SP0 SP!`
stack-reset idiom, and the mechanism a future `THROW`/`CATCH` would
build on. `RP!` carries a real risk worth naming: the return stack
holds live return addresses for every word currently executing, so a
wrong `RP!` mid-execution corrupts the call chain — standard Forth
semantics, no host-side validation added, same "authentic risk" stance
`MMAP` already takes for raw writes.

*Implementation:* `stack.ts` (constructor signature, private
getter/setter, `getPointer()`/`setPointer()`), `rebel-opcodes.json`
(`SP`/`RP` fields added to the `FORTH` group; 6 new primitive entries),
`primitives.ts` (6 new cases), `repl.ts` (both `DataStack`
constructions updated). 11 new tests: `stack.test.ts` covers the
pointer mechanics directly (base vs. live, `getPointer()`/
`setPointer()` round-tripping depth, two `DataStack` instances sharing
one `Sysvars` staying independent via distinct field names);
`low-level-batch.test.ts` covers the primitives, including `RP@ RP0 -`
run from inside a defined word's own body — proof the return stack's
live pointer is real and observable mid-call, not simulated. Full
engine suite: 259 passed (248+11). Live-verified via WebMCP, including
a real, documented gotcha of the same shape as M24's `HEX 255 .` one:
`SP0 SP@ =` on a single line reads `SP@` *after* `SP0`'s own push has
already moved the live pointer — two stack-pointer words in sequence
genuinely see different moments, not a bug.

### 1.50 `WARM` and `COLD` (M35, `DEVELOPING.md` §27)

Note: this jumps from M28 straight to M35 — M29-M34 shipped and are
documented in `PLAN.md`/`DEVELOPING.md` but were never backfilled into
this file's own numbered subsections; flagged here the same way M35's
own note in `PLAN.md` flags an earlier gap, so this isn't mistaken for
an oversight specific to this entry.

Split by how much state each word actually touches, rather than trying
to make `Machine` rebuildable in place (the "focused pass" an earlier
milestone assumed would eventually be needed, per `DEVELOPING.md` §22's
own deferral note).

`WARM ( -- )` (token 131) only touches bytes already inside existing
banks — the data/return stacks and `STATE` — so it's an ordinary
`primitives.ts` case: `ctx.stack.clear(); ctx.rstack.clear();`.
`DICT`/`MMAP` survive untouched. No mid-definition guard, unlike
`replLoop`'s own catch block (§1.38): `WARM` isn't `IMMEDIATE`, so it
compiles rather than executes while `STATE` is `-1` — `executePrimitive`
can never dispatch it with a half-finished definition still open.

`COLD ( -- )` (token 132) means a full reset — `DICT`/`MMAP` included,
equivalent to a fresh boot. Genuinely impossible in place: `Machine`'s
memory-holding fields (`arena`, `banks`, `stack`, `rstack`, `sysvars`,
`dictBank`, ...) are `readonly`, built once in the constructor. Rather
than refactor that, `COLD` is a pure Forth-to-host signal riding the
same generator-based `StepSignal`/`StepStatus` path §1.31's breakpoints
established: `inner.ts`'s `dispatch()` special-cases the `COLD` token
*before* it ever reaches `executePrimitive` (the same shape
`ACCEPT`/`EXECUTE` already get, §1.36) and yields a new `StepSignal`,
`'cold'`, doing nothing else — `COLD` has no case in `primitives.ts`'s
switch at all. `Machine.step()` surfaces this as a matching new
`StepStatus` value, same as it already does for `'breakpoint'`.

The host (`packages/app/src/app/app.ts`) is the only thing that reacts.
`tick()` checks `status === 'cold'` right after its existing
`'breakpoint'` check: resets every polled UI snapshot
(`lastStackSnapshot`/`lastRStackSnapshot`/`lastLatestAddr`/
`lastBankCount`/`lastBreakpointWords`/`lastProjectNames`, so the fresh
machine's state is picked up on its own first tick rather than being
masked by a stale comparison), clears `pausedWord`, and calls
`performBoot()`. `ngAfterViewInit`'s original boot sequence — construct
`Machine`, load `system.fth`, `startRepl()`/`startPump()` — is now
split into `constructMachine()` (synchronous) and
`loadVocabularyAndStartRepl()` (async), with `performBoot()` simply
running both back to back; `tick()`'s `'cold'` branch calls
`performBoot()` directly. Deliberately skips the storage self-test and
`navigator.storage.persist()` — page-load-only hardware checks, not
part of a Forth-level reset. The old `Machine`/session is just dropped;
it holds no listeners or timers of its own, so nothing needs explicit
teardown.

**A real bug, found by a flaky test, not assumed:** the first version
of this ran `await this.performBoot()` as `ngAfterViewInit`'s very
first statement, before keyboard-listener registration. `app.spec.ts`'s
*existing* keyboard-input test started failing intermittently.
Instrumented `handleKeyEvent`/`onKeyDown` directly rather than
guessing: `whenStable()` is a zone-stability signal, and
`performBoot()`'s tail (`startRepl()`/`startPump()`) runs inside
`zone.runOutsideAngular()` — invisible to that tracking by design. With
listener registration moved after the `await`, `whenStable()` could
resolve before the listeners were actually attached. The original code
never hit this because every synchronous step through listener
registration ran before `ngAfterViewInit`'s *first* `await` — an
implicit ordering invariant the reorder broke without touching a line
that looked responsible. Fixed by the `constructMachine()`/
`loadVocabularyAndStartRepl()` split above: `ngAfterViewInit` runs
`constructMachine()`, focus, WebMCP registration, the storage
self-test, and keyboard listeners all synchronously — the original
order — before awaiting the vocabulary/REPL-start half.

**A second bug, same root cause:** `registerWebMcpTools()` (§1.30)
captured `const machine = this.machine` once, at registration time —
harmless while `this.machine` was assigned exactly once, ever, but a
real staleness bug once `COLD` can replace it later. Seven tool
closures would otherwise have kept operating on the abandoned
`Machine`. Fixed by reading `this.machine` fresh inside each closure
instead of closing over a local; `remoteChannel` stays captured, since
it's host-level and genuinely outlives any one `Machine`.

*Implementation:* `rebel-opcodes.json` (tokens 131-132), `primitives.ts`
(case 131), `inner.ts` (`StepSignal` gains `'cold'`, `dispatch()`'s
`COLD_TOKEN` special case), `repl.ts` (`StepStatus` gains `'cold'`,
`Machine.step()`'s handling), `app.ts` (`constructMachine()`/
`loadVocabularyAndStartRepl()`/`performBoot()`, `tick()`'s `'cold'`
branch, `registerWebMcpTools()`'s closures). New tests: `warm.test.ts`,
`cold.test.ts`, two `app.spec.ts` tests. Full engine suite: 305 passed
(300 before this milestone, 5 new). App suite: 18 passed (16 before, 2
new).

### 1.51 Dictionary hover tooltip shows a primitive's note (M36, `DEVELOPING.md` §28)

Web-only monitor-panel sugar, requested directly — not a cross-target
concern, no `FORTH-ARCHITECTURE.md`/`PORTING-WEB.md` change. The
dictionary list's hover tooltip previously only ever showed
breakpoint-click info; for a primitive (always `breakable: false`,
§1.31) that was dead weight, while `rebel-opcodes.json`'s `note` field
already carries real documentation for many of them.

`dictionary.ts` gains `getPrimitiveNote(name): string | undefined` — a
name→note lookup built once from `opcodes.primitives`, exported via
`index.ts`. Deliberately not a `DictionaryEntry` field: a note is
Rebel-Sim-authored documentation, not runtime dictionary state every
target's chain-walk would otherwise carry. `app.ts`'s `wordTooltip()`
returns the note when `getPrimitiveNote` finds one, otherwise the
original breakpoint-hint text; `app.html`'s dictionary-list `[title]`
binding calls it instead of inlining the ternary. Click-to-toggle-
breakpoint itself (§1.31) is unchanged — only the tooltip text
changed.

*Implementation:* `dictionary.ts` (`getPrimitiveNote`), `index.ts`
(export), `app.ts` (`wordTooltip`), `app.html` (`[title]` binding). New
tests: five `dictionary.test.ts` cases, one `app.spec.ts` case. Full
engine suite: 310 passed (305 before, 5 new). App suite: 19 passed (18
before, 1 new).

### 1.52 `REDRAW` (M37, `DEVELOPING.md` §29)

Poking `CHAR` directly (`BANK@ CHAR ... C!`) writes the byte but never
blits it — only `writeChar()` (`EMIT`/`CHAR!`/...) goes through
`screen.hal.blitGlyph()`. `REDRAW ( -- )`, token 133, one-line
`primitives.ts` case exposing the already-existing `Screen.redrawAll()`
(§1.25-adjacent, M29) — the same call `RESTORE`/`BLOAD` already make
internally for the identical reason. Unlike §1.51's tooltip, this is a
real cross-target primitive, not web-only: `rebel-rom`'s
`CScreenModule::Redraw()` (`src/screenmodule.h`/`.cpp`) is the
identical concept on real hardware, checked directly rather than
assumed. Deliberately whole-buffer only for now (no single-cell/
rectangle variant) — the point is finding out empirically how
expensive a full sweep is in a real use case before adding anything
more targeted.

*Implementation:* `rebel-opcodes.json` (token 133), `primitives.ts`
(case 133). One new `screen.test.ts` case (poke leaves `blitGlyph`
uncalled, `REDRAW` then repaints every cell). Full engine suite: 311
passed (310 before, 1 new). App suite unaffected.

### 1.53 Sysvars section in the left-side monitor overlay (M38, `DEVELOPING.md` §30)

Web-only UI, same scope as §1.51's tooltip. New engine export
`listSysvars(sysvars: Sysvars): SysvarEntry[]` (`sysvars.ts`) walks
`opcodes.sysvarGroups`, skips groups with no fields defined yet
(`FONT`/`SPRITE`, both reserved), and reads each real field's live
value via `sysvars.get()`, carrying its JSON `note` through — the same
"read `rebel-opcodes.json` metadata through a dedicated accessor"
pattern `getPrimitiveNote` established for §1.51, applied to sysvars
instead of dictionary entries.

`.storage-panel` (`app.html`) gained a `sysvars:` section: a
`<table class="bank-table sysvar-table">` with one row per
`SysvarEntry` (group, field with the note as its hover title, value).
`app.ts` gained a `sysvarsTable` signal, set once in
`constructMachine()` and polled/diffed every `tick()` frame — unlike
`bankTable`/`dictionaryWords`, which gate their re-read behind a cheap
proxy (bank count, `LATEST`'s address), sysvars change on nearly every
executed word so `tick()` just re-reads all ~15 fields every frame and
diffs the flat value list directly; `lastSysvarsSnapshot` resets to
`[]` in the `'cold'` branch like every other polled "last*" field.

*Implementation:* `sysvars.ts` (`SysvarEntry`, `listSysvars`),
`index.ts` (both re-exported), `app.ts` (`sysvarsTable` signal, its
`constructMachine()`/`tick()`/`'cold'`-branch wiring), `app.html`
(the new section). Three new `sysvars.test.ts` cases (reserved groups
skipped, live-not-cached value, note carried through) and one new
`app.spec.ts` case (`.sysvar-table` lists `STATE`/`BASE`, `16 BASE !`
updates the rendered row). Live-verified in a real browser. Full
engine suite: 314 passed (311 before, 3 new). App suite: 20 passed
(19 before, 1 new).

### 1.54 Self-hosting the outer interpreter (M43, `spec/04-FORTH-CORE.md` §5.2/§6.13)

M42 moved 59 words from native primitives into `system.fth` (the
control-flow compiler, stack shufflers, `VARIABLE`/`CONSTANT`, ...),
but deliberately left the outer interpreter itself — the mechanism
§1.10/§1.11 describe — as engine-internal TypeScript, since making it
genuinely self-hosted meant a real architectural change: `WORD` has to
return `(addr, len)` pointing into actual arena memory, and the engine's
tokenizer used to pre-split each line into a plain JS `string[]`, which
has no arena address to hand back at all.

**A unified, arena-backed cursor.** `Machine`'s old `currentTokens`/
`currentTokenIndex` fields are gone, replaced by two absolute arena
addresses, `inputPos`/`inputEnd`, bounding the current line within the
`TIB` (bumped from 128 to 256 bytes — the longest `system.fth` line is
144 characters, already over the old limit once every line has to
physically fit rather than live in a JS string). One method,
`wordScan(delimiterCode)`, is the single real implementation three
things build on:
- `nextInputToken()` — the existing `PrimitiveContext` method every
  native raw-token-consuming primitive (`CREATE`, `BANK@`, `'`, `S"`,
  ...) already called — becomes a thin decode wrapper over it. External
  contract unchanged: none of those primitives needed to change at all.
- The new `WORD` primitive (token 134, `( char -- addr len )`) — pops a
  delimiter, calls `wordScan`, pushes the result. `len = 0` means the
  line is exhausted; `WORD` itself never throws.
- The native fallback tokenizer (below) — reads via `wordScan(BL)`
  instead of the old array walk, so it shares the exact cursor `WORD`
  does (required: a native primitive invoked *from* a compiled call
  still has to consume from the same live position `WORD`/`INTERPRET`
  would otherwise be walking).

**`:`/`;`/`IMMEDIATE`/`COMPILE-ONLY` become real primitives** (tokens
136-139) — see §1.11's rewrite above. `COMPILE-ONLY` itself predates
M43 (a special-cased keyword M42 added, the only way to reach
`FLAG_COMPILE_ONLY` from Forth at the time) but gets the same
promotion here, for the same "never special-cased by spelling" reason.

**The self-hosted layer itself, all in `system.fth`, appended after
everything else (`INTERPRET` load-order-last per §6.13):**
- `FIND ( addr len -- entry-addr flag )` — chain-walks `LATEST` toward
  `0`, skipping `HIDDEN`, comparing each candidate's already-uppercase
  stored name against `addr len` case-insensitively (folding the
  *input* bytes to uppercase, since stored names are already
  uppercase). Uses two scratch `VARIABLE`s (`FIND-ADDR`/`FIND-LEN`,
  `HIDE`-ed once `FIND` no longer needs to find them by name) rather
  than juggling `addr`/`len` across the whole walk on the data or
  return stack — simpler to get right than deep `PICK` arithmetic, and
  this isn't a hot path.
- `NUMBER ( addr len -- n )` — spec gives a reference definition with
  **no digit validation at all**: a token like `:`/`;` (ASCII
  immediately past `'9'`) would silently parse as digit values 3/4.
  Extended here with an explicit per-character range check (only
  `'0'-'9'`/`'A'-'Z'`, after the same uppercase fold `FIND` uses) and a
  digit-against-`BASE` check, both calling `ABORT` on failure — a
  genuinely unrecognized token (a typo) still errors instead of
  silently becoming a meaningless number, which the existing test
  suite's `unrecognized word` coverage already depended on. Also
  guards spec's own separately-documented lone-`-`-with-no-digits gap
  (would otherwise read one byte past the token's own bounds).
- `LIT-XT` (`' LIT CONSTANT LIT-XT`) — resolved once, the same pattern
  §1.26's control-flow block uses for `BRANCH-XT`/etc.
- `[`/`]` — `: [ 0 STATE ! ; IMMEDIATE` / `: ] -1 STATE ! ;`, the
  ordinary mode-switch words, using `03-SYSVARS.md`'s real `STATE`
  encoding.
- `INTERPRET ( -- )` — the whole §1.10 contract, implemented exactly:
  `WORD BL` until exhausted; `FIND`; if found, `EXECUTE` (interpreting,
  unless `COMPILE-ONLY` → `ABORT`) or, while compiling, `EXECUTE` if
  `IMMEDIATE` else compile a call via `,`; if not found, `NUMBER`, then
  push (interpreting) or compile `LIT-XT` plus the literal (compiling).

**The chicken-and-egg problem, and why the native fallback still
exists.** `system.fth`'s own source needs *something* native to
interpret it before the `INTERPRET` it defines exists — and
`Machine.dispatchLine()` resolves this by design, not just for
bootstrapping: it resolves and caches `INTERPRET`'s `cfa` the first
time `findWord` finds it, and dispatches through it (one call per line;
`INTERPRET`'s own body loops via `WORD` until exhausted) whenever it's
available, falling back to the native tokenizer otherwise. A bare
`new Machine()` that never loads `system.fth` keeps using the native
fallback forever — most engine-level tests deliberately construct one
this way, to test a primitive in isolation, and none of them needed to
change. Production (`app.ts`, any real REPL session) always boots
through `system.fth` first, so it always runs the genuine self-hosted
path — the fallback never leaks into what actually matters for spec
conformance. Error rollback (§1.11's mid-compilation-error paragraph)
needed no new mechanism: a thrown error inside `INTERPRET` propagates
up through the generator's `yield*` chain exactly like any error from
compiled Forth code already did, landing in the same `runLine`/
`replLoop` `catch` blocks that already call `abortDefinition`.

**A real bug, not just a spec-compliance question:** `I`/`J`'s first
draft ported the classic `RP@ @` idiom verbatim from real Forth
systems, and broke every `DO`-loop test — the same garbage value
repeated every iteration. Root cause: `I`/`J` used to be *primitives*,
dispatched with no return-stack frame of their own; once M42 made them
ordinary colon-definitions, *calling* them pushes their own return
address onto the exact same return stack they `RP@` into, one cell
above the loop-control cells `(DO)` pushed. Fixed by skipping that
frame explicitly (`RP@ CELL+ @` / `RP@ CELL+ CELL+ CELL+ @`) — caught
immediately by the existing DO-loop test coverage, not shipped silently
broken.

**A real, mostly-cosmetic performance shift worth knowing about:**
`FIND`'s chain-walk is O(dictionary size) — roughly 170 entries once
`system.fth` has loaded — so a single lookup can cost on the order of
10^4 primitive-level `'progress'` yields, versus the old native
tokenizer's roughly-one-step-per-token. Still microseconds of real
wall-clock time, but it meant `Machine.step()` budgets tuned for the
old cost model (tests using `step(1000)`, `app.ts`'s `STEP_BUDGET`)
needed bumping — `step()` returns the moment a line actually
finishes/blocks/breakpoints regardless of the budget ceiling, so a
generous budget costs nothing extra for a short line; what it buys is
a longer line finishing within one `requestAnimationFrame` round-trip
instead of several.

**A pre-existing app-test bug this surfaced, not caused:** `app.spec.ts`
tests that called `app.remoteChannel.push(text)` directly (reaching
into a private field, bypassing the WebMCP `type` tool's own handler)
never restarted the animation-frame pump the way the real handler does
(`remoteChannel.push(text); this.wake();`) — a frame that finds
`step()` blocked with nothing else changed lets the pump die rather
than polling forever at idle, so a *second* push after the pump had
already gone idle was silently never processed. Worked by accident
before (the pump was usually still alive from a previous push);
larger, less-frequent `tick()` calls under M43's own step-budget needs
made the gap between pushes wide enough to expose it reliably. Fixed
with a shared `typeIntoRepl()` test helper that calls both together.

*Implementation:* `repl.ts` (`wordScan`, `loadLineIntoTib`,
`dispatchLine`, the slimmed `tokenizeAndRun`), `primitives.ts` (`WORD`/
`STATE`/`:`/`;`/`IMMEDIATE`/`COMPILE-ONLY`, tokens 134-139),
`rebel-opcodes.json`, `system.fth` (`FIND`/`NUMBER`/`LIT-XT`/`[`/`]`/
`INTERPRET`), `app.ts` (`STEP_BUDGET`), `app.spec.ts`
(`typeIntoRepl`). New `word-state.test.ts` and
`self-hosted-interpreter.test.ts`. Full engine suite: 343 passed (315
before M43's first step, +28 new across the milestone). App suite: 20
passed, unchanged in count, one pre-existing bug fixed.

**M43 follow-up: `NUMBER` echoes its failing token before `ABORT`ing**
(`spec/04-FORTH-CORE.md` §6.13/§8, RECOMMENDED not required). Neither
fig-Forth nor Forth-79 (this spec's classic ancestors) had `THROW`/
`CATCH` — their entire error-reporting convention was `ABORT` plus
`TYPE`ing the offending token first, the familiar `TOKEN ?`. `system.fth`
now does exactly this: `NUMBER` stashes its original `addr len` into two
scratch variables (`NUM-ADDR`/`NUM-LEN`) before any in-place
manipulation (sign-stripping changes them), and a small helper,
`NUM-ABORT`, replaces all three of `NUMBER`'s bare `ABORT` calls —
`NUM-ADDR @ NUM-LEN @ TYPE SPACE ABORT`. This composes for free with
`reportError`'s own generic `? ABORT` tail (§1.10) at the top-level REPL:
typing a bad token like `FOOBAR` now shows `FOOBAR ? ABORT` rather than
just `? ABORT`. Both scratch variables and the helper are `HIDE`n
afterward, same as `FIND`'s own `FIND-ADDR`/`FIND-LEN` pattern just
above it. No new primitive, no general message-carrying mechanism — a
word other than `NUMBER` calling `ABORT` for its own reasons still gets
the plain, unlabeled behavior. Verified via two new
`self-hosted-interpreter.test.ts` cases asserting the actual screen text
(not just that an error was thrown); one existing "lone minus sign"
test was corrected alongside this — a bare `-` typed at the top level
never reaches this guard at all (`-` is itself a real dictionary word,
so `FIND` matches it before `NUMBER` runs; the actual error was always
a stack underflow from executing `-` with nothing on the stack), so
that test now calls `NUMBER` directly (`S" -" NUMBER`, bypassing `FIND`)
to genuinely exercise the guard.

---

### 1.55 Comment retention reverted (M44, `spec/04-FORTH-CORE.md`'s `(` row, `FORTH-ARCHITECTURE.md` §9 item 13)

M11 (§1.32) made `(` compile its comment text as `(SLIT)`+`2DROP` inline
data while compiling — a genuine runtime no-op, chosen specifically so a
future `SEE` could echo the comment back rather than silently losing it.
M12 (§1.33) built `SEE` and immediately confirmed the risk
`FORTH-ARCHITECTURE.md` §9 item 13 had flagged when that encoding was
chosen: `SEE` on a word containing `( a note )` printed `"a note" 2DROP`,
not `( a note )` — indistinguishable from a program that genuinely
builds and discards a string on purpose. That ambiguity was never
resolved (no dedicated `(COMMENT)` token was ever built as the
documented fallback), and revisiting it now: the entire reason for the
extra complexity — `SEE` showing something a reader would recognize as a
comment — never actually happened. Reverted to plain classic Forth
behavior: `(` (`primitives.ts` case 93) consumes its text via the same
`consumeQuotedText` loop as before, but no longer branches on `STATE` or
calls `compileSlit`/`compileCell` at all — it's just discarded, every
time. `compileSlit` itself is untouched and still used by `S"`/`."`, so
comment text and genuine string literals no longer share any code path
that treats them alike.

`comments.test.ts`'s byte-level test (previously verifying `(SLIT)` +
the comment length + the comment bytes were present at `FOO`'s Code
Field) now asserts the opposite shape: `: FOO ( a note ) 5 ;`'s compiled
body is exactly `LIT 5 EXIT`, with nothing between the Code Field and
the literal at all. `FORTH-ARCHITECTURE.md` §9 item 13 and
`spec/04-FORTH-CORE.md`'s `(` row (`**[Revised]**`, same convention as
§1.54's `NUMBER` follow-up) both updated to record the reversal rather
than leave the shipped-and-then-undone decision looking still-current.

*Implementation:* `primitives.ts` (case 93, simplified), `rebel-opcodes.json`
(token 93's note). *Tests:* `comments.test.ts` (one test rewritten, six
unchanged — comment consumption/discarding behavior itself, interpreting
or compiling, is identical either way; only what gets *compiled* changed).
Full engine suite: 345 passed, unchanged in count.

### 1.56 `BLKS`: generic block storage, and `(BLOCK-READ)`/`(BLOCK-WRITE)` (M45, `FORTH-ARCHITECTURE.md` §7)

Spec'd with Oliver ahead of the Screen Editor work
(`inspiration/Starting-FORTH.pdf` ch. 3,
`inspiration/figforth_editor_screens.txt`): a HAL surface at block
granularity only — move exactly 1024 bytes, no caching/eviction
semantics — so any target can back it however it wants (Rebel-Sim: an
ordinary resident bank; an embedded target: real flash/USB block I/O),
with everything else (the buffer pool, `BLOCK`/`BUFFER`/`UPDATE`/
`FLUSH`) built once as identical portable Forth source above it. Same
turn, the backing bank was renamed `SCRS` → `BLKS`: the bank itself
carries no screen/text assumption, only a fixed 1024-byte addressing
granularity — classic Forth source-editing screens are its first
consumer, not its definition, so the name shouldn't imply otherwise.

This milestone builds the HAL half only — the two primitives and their
backing bank — not the portable Forth buffer pool or any editor word
yet (`BLOCK`/`BUFFER`/`UPDATE`/`FLUSH` remain unbuilt, staged as the
next real step).

`BLKS` is boot-created in `repl.ts`'s constructor exactly like every
other fixed bank (`WORK`, `KMAP`, ...), sized `16 * BLOCK_SIZE`
(16 KiB) — 16 blocks rounds to exactly the `S` size class, no rounding
waste. **Update, found by Oliver while looking at the bank monitor:**
tag and name started out both `BLKS`, but `name` is real per-bank
identity — uniqueness is enforced on it, not on `tag`, and multiple
banks are expected to eventually share a tag — so it's free to say
what a *given* `BLKS`-tagged bank is actually for rather than
repeating the generic tag. Renamed to `EDITOR` (its only consumer
today): `BANK@`/`requireBank('BLKS')` still resolve by tag, unaffected;
the only real consequence is the persisted asset basename
(`storage.ts`'s `${bank.name}.${ext}`) — a project saved after this
change gets `EDITOR.BLK` instead of `BLKS.BLK`; an already-saved
project keeps restoring correctly regardless, since `RESTORE` replaces
the whole bank table from the save file's own recorded names.

`BLOCK_SIZE` (1024, the fixed classic-Forth
screen size no target gets to vary) lives in `banks.ts` rather than
`repl.ts`, specifically so `primitives.ts` can import it too without
creating a `repl.ts`↔`primitives.ts` circular dependency — the same
reason `CELL_SIZE` already lives in `arena.ts` rather than wherever it
was first needed.

`(BLOCK-READ)`/`(BLOCK-WRITE)` (tokens 140/141, `( addr n -- )`) are
the actual `hal_block_read`/`hal_block_write` primitives — paren-named
like `(DO)`/`(LOOP)`/`(+LOOP)` (tokens 53-55) since they're an internal
mechanism the not-yet-built Forth-level `BLOCK`/`BUFFER` will call, not
something meant to be typed directly at the prompt. Both resolve `BLKS`
by tag via `ctx.banks.requireBank('BLKS')` (the same lookup `BANK@`
uses) rather than caching its base — bounds-check `n` against the
bank's *actual* size (`blks.size / BLOCK_SIZE`, not a hardcoded `16`)
before touching memory, throwing `block ${n} out of range (0..15)` on
a miss, the same loud-failure convention `BANK@` uses for an unknown
tag. The copy itself is a plain byte-by-byte loop against
`ctx.arena.readByte`/`writeByte`, same shape `CMOVE`/`FILL` already
use — `BLKS` is fully arena-resident, so there's no real "device" on
the other end of either call, just another bank access.

Persistence is free: `BLKS` is an ordinary bank like any other, so
`SAVE`/`RESTORE`/`BSAVE`/`BLOAD` (M5/M33, already built) round-trip it
through the project-asset pipeline the moment `storage.ts`'s
`TAG_TO_EXTENSION` gets a `BLKS: 'BLK'` entry — no new storage code
needed. `(BLOCK-READ)`/`(BLOCK-WRITE)` never touch disk themselves;
`FLUSH`ing a dirty in-Forth buffer into the resident `BLKS` bank
(once it exists) will be a smaller, separate act from persisting the
whole bank at project-save time.

*Implementation:* `banks.ts` (`BLOCK_SIZE`), `repl.ts` (`BLKS` bank
creation), `primitives.ts` (tokens 140/141), `rebel-opcodes.json`
(both primitives' notes, `bankTags.BLKS`), `storage.ts`
(`TAG_TO_EXTENSION.BLKS`). *Tests:* `block-io.test.ts` (new — bank
shape, round-trip, block-boundary isolation, both-ends-of-range
coverage, out-of-range errors, and a full `SAVE`/`RESTORE` round-trip).
Full engine suite: 353 passed (345 before, +8 new).

### 1.57 `BLOCK`/`BUFFER`/`UPDATE`/`FLUSH`: the portable buffer pool (M46, `FORTH-ARCHITECTURE.md` §7)

The follow-up to §1.56, the next day: the portable half of the same
mechanism, built entirely in `system.fth` over `(BLOCK-READ)`/
`(BLOCK-WRITE)` (tokens 140/141) — no engine changes at all. Inserted
right after the `VOCABULARY`/`USE` section, before the self-hosted
outer interpreter (which must stay the file's last section, per its
own load-order comment).

A small, fixed 4-slot buffer pool, matching the size decided when this
was spec'd (§1.56): `CREATE ... ALLOT` reserves three parallel arrays
— `BUF-BLOCK#` (which block number, if any, each slot holds; `-1`
means empty), `BUF-DIRTY` (a HAL-convention flag per slot), and
`BUF-DATA` (the actual `BLOCK-SIZE`-byte backing RAM for all four
slots back to back). `NEXT-SLOT` is a round-robin eviction pointer;
`CURRENT-SLOT` remembers which slot `BLOCK`/`BUFFER` most recently
returned, for `UPDATE` to mark dirty. `REQ-BLOCK#`, `SCAN-RESULT`, and
`SLOT#` are scratch variables threading a value through a word instead
of deep stack juggling — the same convention `FIND-ADDR`/`FIND-LEN`
and `NUM-ADDR`/`NUM-LEN` already established, reused here rather than
invented fresh.

**Every array starts explicitly initialized, not left at its
zero-filled default.** A fresh `DICT` bank reads as all-zero, which
would make `BUF-BLOCK#`'s slots read as "already holds block 0" before
a single real block read ever ran — a genuine bug this file's own
comment calls out, not a hypothetical one. `INIT-BUFFERS`, a small
word called once immediately after its own definition, sets every
slot's block number to `-1` and dirty flag to `0`. It has to be a real
word, not bare top-level code, because `DO`/`LOOP` are compile-only
(spec/04-FORTH-CORE.md §6.5) — they only work inside a colon-definition
— the same reason every other multi-statement setup in this file
(`VOCABULARY FORTH`'s own block, `INTERPRET`'s definition) is either a
word or doesn't need a loop.

**No early exit from a counted loop, anywhere in this section — by
necessity, not style.** `LEAVE`/`UNLOOP` don't exist yet
(spec/04-FORTH-CORE.md §9's own explicitly-deferred list), and `EXIT`
from inside a `DO` loop would corrupt control flow: `(DO)`'s runtime
pushes the loop's index/limit onto the return stack, and `I`/`J`
(§1.26, the bootstrap control-flow block) already depend on that layout via a fixed
`CELL+` offset — `EXIT` blindly pops one cell expecting a return
address, which inside a `DO` loop is actually the limit cell. So
`FIND-BUFFER` (a full scan for a resident block number) and every
per-slot loop run unconditionally to completion, accumulating their
answer in a scratch variable instead of branching out early — the same
"no shortcuts `DO`/`LOOP` can't safely take" constraint, applied
uniformly rather than worked around per-word.

**The mechanism itself, classic fig-FORTH shape:** `FIND-BUFFER`
reports which slot (if any) already holds a given block number.
`EVICT-SLOT` makes a slot ready for reuse — writes it back via
`(BLOCK-WRITE)` first if dirty, otherwise a no-op. `LOAD-SLOT` (`BLOCK`'s
own miss path) evicts, claims the slot for the new block number, and
reads its real content in via `(BLOCK-READ)`. `CLAIM-SLOT` (`BUFFER`'s
own miss path) does the same except the read — the block is about to
be fully overwritten, so reading its old content first would be wasted
work, exactly matching classic fig-FORTH's own `BUFFER`/`BLOCK` split.
`PICK-SLOT` hands out the next eviction victim, round-robin. `BLOCK`
and `BUFFER` themselves are near-identical: check `FIND-BUFFER` first
(a hit returns the existing address, no I/O), and on a miss, pick a
victim and delegate to `LOAD-SLOT` or `CLAIM-SLOT` respectively — either
way remembering the slot in `CURRENT-SLOT`. `UPDATE` marks
`CURRENT-SLOT` dirty. `FLUSH` just calls `EVICT-SLOT` unconditionally
across all four slots — the exact write-back-if-dirty logic already
needed for normal eviction, reused rather than duplicated.

**A real bug found and fixed while writing this section's comments,
not this file's own — `system.fth`'s.** Every one of `(BLOCK-READ)`/
`(BLOCK-WRITE)`'s own comment mentions had to avoid writing the literal
parenthesized primitive names inside a `(` comment at all: a comment's
own closing scan is per-*token*, not per-character (`(` doesn't nest,
per this file's standing header warning), so a token like
`(BLOCK-READ)` — itself ending in `)` — closes the surrounding comment
the instant that token is read, silently turning the rest of that
comment line into live code and throwing `unrecognized word` on
whatever text followed. Caught immediately by `bootMachine()` failing
to load at all (the same class of bug M43's own write-up already
flagged, "hit five times") — every comment in this section refers to
the primitives as plain prose (`native block read`/`native block
write`) instead, and the actual code lines are unaffected since they
aren't inside a comment.

Everything above `BLOCK`/`BUFFER`/`UPDATE`/`FLUSH` themselves —
`INIT-BUFFERS`, the three backing arrays, all five scratch/pointer
variables, and `BUF-ADDR`/`FIND-BUFFER`/`EVICT-SLOT`/`LOAD-SLOT`/
`CLAIM-SLOT`/`PICK-SLOT` — is `HIDE`n right after `FLUSH`'s own
definition, the same declutter-`WORDS` convention `FIND-ADDR`/
`NUM-ADDR`/`XT-NAME` already established. Hiding doesn't affect
`BLOCK`/`BUFFER`/`UPDATE`/`FLUSH`'s own already-compiled calls into
them — only future name lookup and `WORDS` listings.

*Implementation:* `packages/app/public/system.fth` only — no engine
package changes. *Tests:* `block-words.test.ts` (new — cache-hit
address stability, distinct blocks get distinct buffers, an unflushed
write is visible to a later `BLOCK` call but not yet in `BLKS` itself,
`UPDATE`+`FLUSH` persists it, a real miss loads real `BLKS` content,
`BUFFER` round-trips without depending on prior `BLKS` content, an
untouched `FLUSH` is a safe no-op, round-robin eviction flushes the
displaced dirty slot automatically, an out-of-range block still throws
via the underlying native bounds check, and internal plumbing is
confirmed hidden while the four public words aren't). Full engine
suite: 364 passed (353 before, +11 new).

### 1.58 `EMPTY`: reset the dictionary to its post-boot state without a full `COLD` (M47, `FORTH-ARCHITECTURE.md` §7)

Spec'd ahead of the Screen Editor work, same session as §1.56/§1.57:
editing and reloading screen source repeatedly is expected to want a
clean vocabulary — no leftover user-defined words — far more often
than a genuinely fresh machine. `COLD` (§1.50) already resets the
dictionary, but by rebuilding the entire `Machine` (fresh arena,
cleared stacks, a brand-new REPL session) — real overkill for "forget
what I just typed while iterating on a screen." `EMPTY` does only the
dictionary half, in place, leaving everything else — stacks, sysvars,
`BLKS` and every other bank's content, the running REPL session —
untouched.

Pure Forth, no engine changes, same shape as §1.57: `EMPTY` reuses
`FORGET`'s own (`DEVELOPING.md` §8.6) `LATEST-ADDR`/`HERE-ADDR`
write-back mechanism, just against a fixed captured point instead of
a chain-walk to a named word.

**The real design problem, and how it's solved:** `EMPTY` needs to
reset the dictionary chain back to "everything `system.fth` itself
defines, nothing the user adds afterward" — which means the reset
point has to include `EMPTY`'s own dictionary entry, or calling
`EMPTY` would forget `EMPTY` and become uncallable after one use. A
naive `LATEST CONSTANT BOOT-LATEST` right before defining `EMPTY`
doesn't work: `LATEST`/`HERE` keep growing while `BOOT-LATEST` and
`EMPTY` are themselves still being defined, so a marker captured too
early excludes them from the very state it's supposed to preserve.
The fix: declare two ordinary `VARIABLE`s (`BOOT-LATEST`/`BOOT-HERE`)
first, define `EMPTY` to read from them (`BOOT-LATEST @ LATEST-ADDR !
BOOT-HERE @ HERE-ADDR !`), and only *after* `EMPTY`'s own closing `;`
capture the real `LATEST`/`HERE` values into those variables. At that
exact point, `LATEST` already *is* `EMPTY`'s own entry (it's the most
recently defined word) and `HERE` already points past `EMPTY`'s
compiled body — so the captured marker inherently includes `EMPTY`
itself, and calling it never forgets itself.

**Placement matters, and doesn't conflict with `INTERPRET`'s own
rule.** `EMPTY` is defined *after* `INTERPRET` (§1.54) — the literal
last thing in `system.fth` before this milestone — since "the state
`COLD` produces" means the *complete* post-boot vocabulary, and
`INTERPRET` was previously the last word defined. `INTERPRET`'s own
"must load last of all" comment is about nothing being able to *call*
`INTERPRET` before it exists, not about nothing being definable
afterward; from `INTERPRET`'s own definition onward, `dispatchLine()`
(`repl.ts`) already switches every subsequent line to the real
self-hosted `INTERPRET` rather than the native fallback tokenizer —
`EMPTY`'s own definition is therefore the first content in
`system.fth` to load through the genuine self-hosted path rather than
the native one, a small extra proof that path works correctly for
ordinary `VARIABLE`/`:`/`;` definitions, not just previously-tested
REPL lines.

One test-writing wrinkle worth recording: once `system.fth` has fully
loaded (any `bootMachine()`), an unfound word no longer throws the
native fallback's `unrecognized word: X` — self-hosted `INTERPRET`'s
own `NUMBER` fails digit validation and calls `ABORT` instead (after
`TYPE`ing the failing token to the screen first, `NUM-ABORT`, §1.54's
own follow-up). Tests assert `.toThrow()` plus a screen-content check,
the same pattern `self-hosted-interpreter.test.ts` already established
for exactly this case, not the pre-boot native-fallback message.

*Implementation:* `packages/app/public/system.fth` only — no engine
package changes. *Tests:* `empty.test.ts` (new — forgets a
user-defined word, `HERE` matches a freshly-booted machine exactly,
the full system vocabulary survives an `EMPTY` call, repeatable
across multiple defines, a no-op when nothing's been defined since
boot or the last `EMPTY`, leaves the data stack/sysvars/`BLKS` content
untouched, and new definitions work normally afterward with no
corruption). Full engine suite: 371 passed (364 before, +7 new).

### 1.59 The Screen Editor: `LOAD`, and the `EDITOR` vocabulary — `LIST`/`L`/`T`/`TOP`/`CLEAR` (M48, `FORTH-ARCHITECTURE.md` §7, `inspiration/Starting-FORTH.pdf` ch. 3, `inspiration/figforth_editor_screens.txt`)

The actual reason `BLKS`/`BLOCK`/`BUFFER`/`UPDATE`/`FLUSH`/`EMPTY`
were spec'd (§1.56-§1.58): a screen is now a genuinely live place to
write and run Forth source, not just a block of bytes with nowhere to
go. One screen is one `BLKS` block — sixteen lines of sixty-four
characters, matching classic Forth's fixed 1024-byte screen layout
exactly, and matching this project's own screen width (sixty-four
character columns) — not a coincidence.

**Scope, agreed with Oliver up front:** the core edit/run loop first —
`LIST`/`L` (display), `T` (replace a line), `LOAD` (run a screen as
source), `TOP`/`CLEAR` — not the full classic set (insert/delete
lines, text search-and-substitute, cross-screen `COPY`), which is
real functionality but a separate follow-up once this loop is
proven. Command naming follows classic fig-FORTH's own single-letter
mnemonics (`L`/`T`), matching `inspiration/figforth_editor_screens.txt`
and this project's demonstrated fig-FORTH fidelity elsewhere, rather
than inventing more readable names that would diverge from the
reference material this was explicitly spec'd against.

**A new native primitive was genuinely required, not just Forth
composition.** `LOAD` needs to feed a `BLOCK`-resident line through
the same `WORD`/`FIND`/`NUMBER`/`INTERPRET` machinery an ordinary
typed line uses — but nothing before this exposed a way to redirect
`repl.ts`'s own shared input cursor (`inputPos`/`inputEnd`) away from
the TIB. Every earlier consumer (`loadLineIntoTib`, `replLoop`'s own
post-`ACCEPT` step) only ever pointed it there, privately, in
TypeScript. `(SET-INPUT)` (token 142, `( addr len -- )`) is the new,
minimal, surgical fix — a direct field-set on `Machine`, exposed
through `PrimitiveContext` the same way `nextInputToken()`/`wordScan()`
already are. Paren-named like `(BLOCK-READ)`/`(BLOCK-WRITE)`
(140/141): internal plumbing `LOAD` calls, not something meant to be
typed directly.

**`LOAD` itself, plain Forth once `(SET-INPUT)` exists:**

```
: LOAD ( n -- )
  BLOCK
  L/SCR 0 DO
    DUP I C/L * + C/L (SET-INPUT)
    INTERPRET
  LOOP
  DROP
;
```

`BLOCK` resolves the screen's resident buffer once; each iteration
points the cursor at that line's own 64 bytes and calls `INTERPRET`
directly — the same self-hosted word every REPL line already runs
through, with zero awareness its source is a block instead of a
keystroke. `C/L` (64, classic name, characters per line) and `L/SCR`
(16, this project's own name, lines per screen) are fixed
architectural constants — their product is `BLOCK-SIZE`, already
fixed from the M46 section.

**Editor commands live in their own `EDITOR` vocabulary, not plain
`FORTH`'s — a real correctness reason, not just classic-fig-FORTH
flavor.** Single-letter names collide too easily with ordinary user
code, `I` most concretely: it would shadow the loop-index word every
`DO`/`LOOP` body depends on. `VOCABULARY`/`USE` (already built, M13)
were exactly the right existing tool: `EDITOR`'s own chain branches
from `FORTH`'s current position at creation time, so every word
defined before the branch — `LOAD` included, deliberately defined in
plain `FORTH` before `VOCABULARY EDITOR` runs — stays reachable from
inside `EDITOR`, but `EDITOR`'s own `L`/`T`/`TOP`/`CLEAR` stay
invisible once back in plain `FORTH`. This also fixed the ordering
inside `system.fth`: the new block had to land *before* `EMPTY`'s own
`LATEST`/`HERE` capture step (not after it, where it was first
drafted), or a later `EMPTY` call would silently un-define the entire
editor along with any real user code — "the state `COLD` produces"
has to include the editor now that it exists.

**Two real bugs found and fixed while building this, both classes
already seen before in this file — worth recording exactly why they
recurred.**

1. *The `(` comment-closing bug, a third time (M43's write-up already
   called this "hit five times").* Every early draft mentioning
   `(BLOCK-READ)`/`(BLOCK-WRITE)` or even a bare `#SCR)`-shaped token
   inside a `(` comment broke `bootMachine()` the same way §1.57's own
   write-up already describes: a comment's closing scan is per-token,
   not per-character, and a token ending in `)` — even by
   accident, mid-sentence, like `section 8)` — closes it early. Also
   caught a *new* variant this time: several draft comment lines used
   a trailing `--` to "continue" onto the next `( ... )` line,
   forgetting that every comment line has to open *and* close on its
   own — an unclosed `(` just runs to end-of-line and swallows
   whatever real code came next as more (silently discarded) comment
   text, a quieter failure than the premature-close case, caught by
   grepping for comment lines with no trailing `)` before ever loading
   the file. Every comment in this section was rewritten to avoid
   embedded parens entirely, and mechanically verified (`grep`) rather
   than eyeballed, once was clearly not enough.
2. *A real, measured performance regression: boot time roughly 2.5x'd
   (about 200ms to about 500ms), and a first draft spiked far worse.*
   `CLEAR` looping over all sixteen screens at boot, to blank-fill
   `BLKS`, first used a Forth-level `BLANKS`/`FILL` — a `DO`/`LOOP`
   writing one byte at a time through the token-threaded inner
   interpreter. Sixteen KiB of individual generator-driven dispatches
   added *over a second* to every single boot, on top of the compile-
   time cost below, and reliably timed out `control-flow.test.ts`
   under full-suite parallel load. Fixed structurally, not just
   worked around: `Arena` gained `fillBytes()`, a native `Uint8Array`
   bulk fill; `BLKS` is now space-filled once, natively, the moment
   `repl.ts` creates the bank, before `system.fth` ever runs — and the
   Forth-level boot-time blank-fill loop (`BLANK-ALL-SCREENS`) was
   deleted outright, not merely sped up, since it was no longer needed
   at all. The *remaining* ~300ms increase is compile-time cost, not
   execution — self-hosted `INTERPRET`'s own `FIND` is `O(dictionary
   size)` per token (§1.54's own known tradeoff, `test-support.ts`'s
   `AMPLE_STEP_BUDGET` comment already names it), and this milestone
   is simply the first to add enough new colon-definitions to make
   that cost clearly visible in wall-clock terms, not a regression
   specific to this code. Addressed as a test-infrastructure
   accommodation, not a product fix: `vitest.config.ts`'s
   `testTimeout` raised to 20s, since a test calling `bootMachine()`
   more than once was demonstrated (twice, on different runs,
   different specific tests each time — the failure moves, the root
   cause doesn't) tripping the 5s default under full-suite CPU
   contention.

**A smaller wrinkle in `LIST`'s own output:** `." SCR # "` doesn't
print a trailing space the way it looks like it should — `."`'s own
text is reconstructed from whitespace-tokenized words rejoined with
single spaces (`consumeQuotedText`'s documented behavior, §1's own
`."`/`S"` note), which silently drops space immediately before the
closing quote. `SEE`'s existing code already works around exactly
this (`." :" 32 EMIT` rather than trusting a trailing space) — `LIST`
now follows the same established pattern (`." SCR #" SPACE DUP . CR`)
rather than reinventing a second workaround.

*Implementation:* `arena.ts` (`fillBytes()`), `repl.ts` (`setInput()`,
`BLKS`'s native space-fill), `primitives.ts` (token 142), `rebel-opcodes.json`
(token 142's note), `system.fth` (`LOAD`, `EDITOR` vocabulary and its
five words, `BLANKS`, `C/L`/`L/SCR`), `vitest.config.ts` (`testTimeout`).
*Tests:* `screen-editor.test.ts` (new — `BLKS` starts space-filled,
`LOAD` runs real multi-line source including a later line calling an
earlier line's just-defined word, a blank screen loads as a no-op,
`EDITOR` vocabulary isolation both ways, `T`'s space-padding and
truncation, `CLEAR` re-blanking, `LIST`/`L`/`TOP` output content, and
per-screen write isolation); `block-io.test.ts`/`block-words.test.ts`
(existing "untouched byte" assertions updated from `0` to `32`, now
that `BLKS` starts space-filled rather than zero-filled). Full engine
suite: 385 passed (371 before, +14 new).

**M48 follow-up, found immediately by Oliver:** `EMPTY` (§1.58) only
ever reset the *global* `LATEST` sysvar — it had no idea what
`CURRENT-VOCAB` currently pointed at. Calling it while `EDITOR` was
still the active vocabulary left `CURRENT-VOCAB` aimed at `EDITOR`'s
own remembered-position cell; the next `USE FORTH` then saved the
freshly-reset `LATEST` value straight into that cell, permanently
overwriting `EDITOR`'s real chain tip — `L`/`T`/`TOP`/`CLEAR`/`SCR`
all became unreachable, though `EDITOR` the marker word itself
survived (found via `FORTH`'s own chain) and the underlying `DICT`
bytes were never actually touched. Fixed by having `EMPTY` also force
`CURRENT-VOCAB` back to `FORTH`'s own cell — resolved once, at the
top level, into a new `FORTH-VOCAB-CELL` constant, since `'` isn't
`IMMEDIATE` and writing `' FORTH 8 +` directly inside `EMPTY`'s body
would defer to runtime instead (the same live-argument shape `USE`'s
own body deliberately relies on, wrong here). `empty.test.ts` gained
two regression tests reproducing the exact reported scenario against
the real `EDITOR` vocabulary. Also caught the `(`-comment-closing bug
a third time while writing the fix's own comments — verified this
time with a precise per-token Python check matching
`consumeQuotedText`'s actual rule, not an approximation, which found
the rest of the file already clean. Full engine suite: 387 passed
(385 before, +2 new). **Resolved the next day, §1.60:** the real
`CONTEXT`/`CURRENT` split fixes this as a side effect, rather than
needing a `LOAD`-specific save/restore hack.

### 1.60 `CONTEXT`/`CURRENT-VOCAB`: the real classic vocabulary split, replacing single-pointer `USE` (M48 follow-up 2, `DEVELOPING.md` §8)

M13's original `USE` conflated two independent classic Forth
concepts into one combined switch: *browsing* a vocabulary (what
`FIND`/`WORDS` search) and *compiling into* one (what `:`/`CREATE`
extend). That conflation is exactly what let a `LOAD`ed screen's own
words land in the wrong vocabulary (§1.59's own follow-up) if the
caller merely browsed `EDITOR` — via `USE EDITOR`, to call `L`/`T`
interactively — without remembering to switch back to `FORTH` first.
Asked for directly: "what would it take to split our `USE` to follow
the `CONTEXT`/`CURRENT` split too?"

**The shape.** `CONTEXT` (new `VARIABLE`) is which vocabulary `FIND`/
`WORDS` search. `CURRENT-VOCAB` (existing) is which vocabulary new
definitions extend. `VOCABULARY` is redefined with `DOES>` —
`: VOCABULARY LATEST CREATE , DOES> CONTEXT ! ;` — giving every
vocabulary word a real runtime action for the first time: naming one
(`EDITOR`, typed or executed) sets `CONTEXT` directly, the actual
classic idiom, not just a bare `CREATE`d value push. `USE name`
survives as a thin, syntax-compatible synonym, `: USE ' EXECUTE ;` —
since `'` isn't `IMMEDIATE` (§1's own note on this), it defers to
runtime, reading its own target from whatever line calls `USE`,
exactly the same trick the original combined `USE` already relied
on; `EXECUTE`ing a vocabulary word now runs its `DOES>` action, so
`USE` becomes context-only automatically, with no call-site rewrite
needed anywhere `USE` was used purely for browsing. `DEFINITIONS`
(new) is the classic second step: `: DEFINITIONS CONTEXT @ LATEST
CURRENT-VOCAB @ ! DUP @ LATEST-ADDR ! CURRENT-VOCAB ! ;` — promotes
whatever `CONTEXT` currently names to also become `CURRENT-VOCAB`,
the exact same save-outgoing/load-incoming dance the original `USE`
always did in one step, just now a deliberate second action:
`EDITOR DEFINITIONS` means "look here, and start compiling here
too."

**A genuine dead end, found and reversed before landing on the
right design.** The obvious first cut — `FIND`/`WORDS` always walk
`CONTEXT @ @`, dereferencing a vocabulary's own remembered-position
cell — breaks immediately, and not on some edge case: `EMPTY` itself
failed to compile the moment this landed. That cell is a *snapshot*,
refreshed only when `DEFINITIONS` switches *away* from a vocabulary
— not continuously as new words compile into it. `FORTH`'s own cell
was frozen at whatever `LATEST` was the instant `VOCABULARY FORTH`
itself ran, at the very top of the file; every single word compiled
since — `DEFINITIONS`, `USE`, `FIND`, `INTERPRET`, `EMPTY` itself —
was invisible to `CONTEXT @ @`, because nothing had ever refreshed
`FORTH`'s own cell in the meantime. **The actual fix:** `FIND`/
`WORDS` compare `CONTEXT` against `CURRENT-VOCAB` first — equal
(browsing exactly what you're also compiling into, the common case)
walks `LATEST` directly, the only thing genuinely live; different
(browsing some other, dormant vocabulary) walks that vocabulary's
own stored position, which is trustworthy precisely because nothing
is compiling into it right now:

```
CONTEXT @ CURRENT-VOCAB @ = IF LATEST ELSE CONTEXT @ @ THEN
```

**A second instance of the identical gap, caught by an actual
failing test, not spotted by inspection.** `LOAD` itself needs the
same fix, for the same underlying reason: a screen whose second line
calls a word its first line just defined, `LOAD`ed while merely
browsing some *other* vocabulary the whole time (`CONTEXT` ≠
`CURRENT-VOCAB` throughout), failed to compile — `FIND`, called from
inside `LOAD`'s own second `INTERPRET` iteration, couldn't see what
`LOAD`'s own first iteration had just compiled a moment earlier,
since `CONTEXT` never agreed with `CURRENT-VOCAB` during the whole
call. Fixed by having `LOAD` align `CONTEXT` with `CURRENT-VOCAB` for
its own duration, restoring the caller's original `CONTEXT`
afterward:

```
: LOAD ( n -- )
  CONTEXT @
  CURRENT-VOCAB @ CONTEXT !
  SWAP
  BLOCK
  L/SCR 0 DO
    DUP I C/L * + C/L (SET-INPUT)
    INTERPRET
  LOOP
  DROP
  CONTEXT !
;
```

This is the general form of the save/restore idea §1.59's own
follow-up sketched but never built — now solving a real, demonstrated
compile failure rather than a hypothetical inconsistency.

**A forward-reference wrinkle, caught immediately by a failed
boot, not subtly.** `WORDS` is defined very early in the file,
alongside `SEE`, and needs to compile a call against `CONTEXT` — but
`CONTEXT`/`CURRENT-VOCAB` didn't exist as words until the real
`VOCABULARY` section, far later. Both are now declared early, right
before `WORDS`, purely as forward references: genuinely unused,
holding nothing meaningful, until the real `VOCABULARY`/
`DEFINITIONS` section initializes them for real — nothing executes
`WORDS` or self-hosted `FIND` for real in between (the native
fallback tokenizer still handles every line until `INTERPRET` itself
is defined, much later still), so the gap is inert.

**The `(`-comment-closing bug, a fourth time**, this time in the new
`FIND` write-up itself (`(INTERPRET, below)` closed early). Caught by
re-running the precise per-token Python checker §1.59's own follow-up
introduced over the whole file, not by re-reading it — the exact
value of keeping that check around rather than trusting a careful
read, restated once more.

**A deliberate scope boundary: the native `'` (tick) primitive and
`findWord`/`listDictionaryEntries` (`dictionary.ts`) are completely
untouched — zero engine changes for this entire feature.** `'` is
used pervasively at bootstrap, resolving `BRANCH`/`LIT`/`EXIT`/etc.
before any vocabulary concept exists at all, and internally for
breakpoint/`ACCEPT`/`INTERPRET` resolution (`repl.ts`) — all
inherently scoped to "the compile chain," not "whatever's being
browsed." Checked every existing `'` call site in `system.fth`
individually: vocabulary names (`' EDITOR`, `' FORTH`) and kernel xts
(`' BRANCH`, `' LIT`, ...) all resolve correctly via `LATEST` regardless
of `CONTEXT`, since vocabulary marker words and kernel primitives
always live in `FORTH`'s own base chain, reachable from any fork.
Making native lookup `CONTEXT`-aware would need a genuine new sysvar
(`findWord` has no way to read an arbitrary Forth-level `VARIABLE`'s
current value) and risks breaking bootstrap itself (the native
fallback tokenizer resolves words the exact same way, before `CONTEXT`
would even be initialized) — real engine surgery, for a consistency
gain nothing in this codebase's own `'` usage actually needs. `HIDE`/
`FORGET` stay `LATEST`-scoped too, same reasoning, unchanged.

**Existing tests updated, not just extended.** `'`-based reachability
checks (`screen-editor.test.ts`, `empty.test.ts`) switched to a small
shared-shape `findable()` helper (`S" name" FIND`, checking
self-hosted `FIND`'s own returned flag) in each file — `'` no longer
means the same thing `CONTEXT`-wise, so checking reachability through
it would silently test the wrong mechanism from here on. The two
`EMPTY`-corruption regression tests from §1.58's own follow-up were
revised to reproduce the bug through `DEFINITIONS` (the actually
vulnerable path now) rather than plain `USE` (context-only, never
vulnerable in the new design). Two `LOAD` tests gained an explicit
`USE FORTH` *after* `LOAD`, not before, to call the loaded word — a
vocabulary you're only browsing can't see words compiled elsewhere
after its own fork point, ordinary chain isolation, not a leftover
chore left in by accident; had `LOAD` wrongly compiled into the
browsed vocabulary instead of `FORTH`, that same switch would fail to
find the word at all, so the test still genuinely covers the original
concern. Four new tests directly prove the fixed properties: browsing
alone never redirects compilation, `DEFINITIONS` does, and a word
`LOAD`ed while merely browsing `EDITOR` is reachable from plain
`FORTH` afterward with no special handling required.

*Implementation:* `packages/app/public/system.fth` only — no engine
package changes. *Tests:* `screen-editor.test.ts`/`empty.test.ts`
(both revised in place, plus new coverage). Full engine suite: 390
passed (387 before, +3 net — several tests rewritten, not purely
additive).

### 1.61 Four real self-hosted-only bugs: `DEPTH`/`PICK`/`.S`/`2OVER`, `FILL`/`CMOVE` zero-length, `WARM` (M49)

Found by actually using the machine — the freshly-built Screen Editor
and monitor — not by inspection or planned review. All four share one
shape: only the *self-hosted* (`system.fth`, post-boot) definition was
ever wrong; the native primitive of the same name (still boot-
registered and still what a bare `new Machine()` dispatches to) was
always correct. That's exactly why the existing test suite never
caught any of them — every affected word already had passing tests,
all constructed via `new Machine()`, none via `bootMachine()`.

**`DEPTH` — off by one.** `: DEPTH SP0 SP@ - 4 / ;` pushed `SP0`
*before* calling `SP@`, so `SP@` read the live pointer with `SP0`'s
own already-pushed value counted, over-stating every result by 1 (a
genuinely empty stack reported `DEPTH` 1). Fixed by reordering so
`SP@` runs first: `: DEPTH SP@ SP0 SWAP - 4 / ;`.

**`PICK` — a self-referential collision, found chasing a second `.S`
report.** `: PICK CELLS SP@ + @ ;` never accounted for its own
argument `u`'s stack slot sitting between `SP@`'s reading point and
the item `PICK` actually wants. Concretely: caller pushes `u`, `PICK`
converts it to a byte offset in place (`CELLS`, same slot, same
depth), then `SP@` reads the pointer — which is `u`'s own slot address,
one cell *too shallow*. `0 PICK` therefore collides with its own
leftover argument slot: the `+`/`@` pair ends up fetching from the
exact address `PICK`'s own scratch computation just wrote to, so it
returns that computed address's numeric value back to itself — visibly
a `SP`-ish garbage number, not a stack value. Every other index `n`
silently returns what should have been index `n-1`'s value (same
one-cell shallow reasoning, just not self-referential). Fixed with
`: PICK 1+ CELLS SP@ + @ ;`, counting `u`'s own slot. This
transitively fixes two dependents with no changes to their own source:
`.S` (garbage top/last-printed item on any nonempty stack) and
`2OVER` (`: 2OVER 3 PICK 3 PICK ;`, silently wrong the same way) —
both were already written assuming correct `PICK` semantics; verified
directly (`10 20 30 0 PICK` → `30`; `1 2 3 4 2OVER` → the standard
`1 2 3 4 1 2`).

**`.S`/`FILL`/`CMOVE` — the same missing zero-length guard, three
times.** Root cause: `(DO)`/`(LOOP)` (§6.5-equivalent, `system.fth`'s
own control-flow block) are the classic *unbounded-count* kind, not
ANS `?DO` — the compiled body always runs at least once, even when
`limit` equals the starting index at entry. `TYPE` already carries an
explicit guard for exactly this (`DUP 0= IF 2DROP EXIT THEN` before
its own loop) — `.S`'s `DEPTH 0 DO ... LOOP` didn't: with `DEPTH` 0,
`0 0 DO` still ran once, computing a spurious `-1 PICK` and printing
whatever garbage that resolved to. Auditing every other `DO`/`LOOP`
site in `system.fth` for the identical shape (not just fixing the one
reported) turned up two more real, previously-undetected instances:
`FILL`/`CMOVE` given a zero length each still wrote/copied one stray
byte instead of staying true no-ops — reproduced directly (a
5-byte-filled sentinel region, then a `0`-length `FILL`/`CMOVE` over
part of it, checking the untouched byte) before fixing, not merely
reasoned about. All three now carry the same guard:

```
: FILL ( addr len char -- )
  >R DUP 0= IF 2DROP R> DROP EXIT THEN R>
  -ROT OVER + SWAP DO DUP I C! LOOP DROP ;
: CMOVE ( addr1 addr2 len -- )
  DUP 0= IF 2DROP DROP EXIT THEN
  0 DO 2DUP SWAP I + C@ SWAP I + C! LOOP 2DROP ;
: .S
  DEPTH DUP 0= IF DROP EXIT THEN
  0 DO DEPTH 1- I - PICK . LOOP ;
```

`FILL`'s guard is shaped differently from `CMOVE`/`.S`'s because its
length argument (`len`) isn't on top — `char` is — so the char is
parked on the return stack (`>R`) just long enough to `DUP 0=` test
`len` underneath it, then restored (`R>`) before the real body runs.

**`WARM` — the one needing a real design decision, not just
arithmetic.** Reported as an RSTK underflow, traced first to `WARM`'s
own self-hosted redefinition (`: WARM SP0 SP! RP0 RP! ;` — §1.50's
original M35 derivation, later moved into `system.fth` as BOOTSTRAP by
M42). Removing that redefinition (falling back to the native
primitive, §1.50) didn't fix it — the *native* primitive underflowed
too, confirmed by direct instrumentation: at the moment `WARM`'s own
`ctx.rstack.clear()` ran, `RSTK` depth was already 1, not 0. That one
frame is self-hosted `INTERPRET`'s (M43) own return address —
`INTERPRET` is itself a `DOCOL`-threaded colon word, holding a live
`RSTK` frame for as long as it's running any line at all, definitions
or not. "Reset `RSTK` to true empty, then return normally" is a
structural contradiction once anything self-hosted is the caller, not
a bug specific to `WARM`'s own composition: plain `RP0 RP!`, typed
directly with nothing to do with `WARM`, reproduces the identical
underflow. `spec/04-FORTH-CORE.md` §6.12 independently traced and
endorsed this exact `WARM` composition as correct BOOTSTRAP, before a
self-hosted outer interpreter (§6.13) existed to break it against —
corrected there too (§6.12 now KERNEL, with the full derivation and
counter-derivation written out).

The fix changes `WARM`'s tested behavioral contract, so this one was
discussed before implementing: classic Forth `WARM`/`QUIT` don't
resume the interrupted line — they clear the stacks and jump back to
the interpreter's own top level, discarding whatever's left of the
current input, rather than the old (already-broken, never actually
achievable) "clears the stack, then keeps executing the rest of the
line" contract the original `warm.test.ts` assumed untested. `WARM`
(`primitives.ts` case 131) now clears both stacks, then throws a new
`WarmReset` (`extends Error {}`) purely to unwind the current line's
nested generator chain — `dispatch()` → `threadFrom()` → `executeXT()`
→ … → `dispatchLine()`, self-hosted `INTERPRET`'s own live frames
included — back to the nearest driver, reusing the same propagation
mechanism a genuine error already uses through every level of `yield*`
delegation, but as a distinct type. `repl.ts`'s two recovery sites
catch it specifically rather than treating it as a generic error:
`replLoop()` (the interactive REPL) prints a clean `ok`, not `?
...` error text; `runLine()` (`interpret()`/`beginLine()`, every
programmatic/test caller) swallows it without rethrowing, so
`interpret()`'s existing "does not throw" contract holds for both
entry points identically. `WARM` stays reclassified to native —
joining `COLD`/`ABORT`/`EXECUTE`/`ACCEPT` (§1.36, §1.50) as a word that
can't be safely self-hosted, for its own distinct reason: `COLD`
because no primitive dispatch can rebuild the environment it's
executing inside of; `WARM` because clearing `RSTK` from inside an
ordinary call destroys the very return address that call needs to get
back out.

**Verification, live in a real browser, not just the unit suite —
new for this session.** `chrome-devtools-mcp` installed mid-session
specifically to check the `.S`/`PICK` fix against actual dev-server/
production-build staleness Oliver suspected (ruled out: both a fresh
`ng serve` and a statically-served production build, in an isolated
browser context with no prior service-worker state, reproduced the
*fixed* behavior correctly). Once installed, also exercised the app's
own new WebMCP tools (`type`/`read_screen`/`read_stack`/…, exposed by
the running page itself) to drive the real Forth REPL directly for the
`WARM` fix specifically — `1 2 3 WARM 4 5` followed by `RP0 RP!`
followed by `10 20 30 .S`, confirming the abandoned-line behavior, the
still-expected `RP0 RP!` underflow-and-recover, and normal operation
immediately afterward, all in one running session.

**Test coverage gap, the actual root cause of all four shipping
unnoticed.** Eight new `bootMachine()`-based regression tests, added
specifically alongside (not replacing) the existing native-only ones,
across `stack-arith.test.ts` (`DEPTH`, `PICK`, `.S`, `2OVER`),
`low-level-batch.test.ts` (`.S` empty-stack, `FILL`/`CMOVE`
zero-length), and a rewritten `warm.test.ts` (the new contract, plus a
dedicated `RP0 RP!`-alone case confirming that primitive is
deliberately left as a genuine footgun, not silently patched over).

*Implementation:* `packages/app/public/system.fth`, `primitives.ts`,
`repl.ts`. *Tests:* `stack-arith.test.ts`, `low-level-batch.test.ts`,
`warm.test.ts`. `spec/04-FORTH-CORE.md` updated: §6.1's `DEPTH`/`PICK`
reference definitions corrected in place; a new zero-length `DO`/`LOOP`
trap paragraph in §6.5; §6.3/§6.8 (`FILL`/`CMOVE`/`.S`)
cross-referencing it; §6.12's `WARM` entry rewritten in full
(BOOTSTRAP → KERNEL); §2.4's headline BOOTSTRAP-word count corrected
(54 → 53) to match. `01-HAL.md`/`03-SYSVARS.md` checked, no changes
needed. Full engine suite: 398 passed (390 before, +8 new).
`packages/app` test suite: 20 passed, unaffected.

### 1.62 `BANK-SIZE`, and `BANK@` switches from `tag` to `name` lookup (M50)

Started as "add the read-only counterpart `BANK@` never had" and
surfaced a real, pre-existing ambiguity in `BANK@` itself along the
way (found by Oliver while looking at the bank monitor).

**`BANK-SIZE ( "name" -- size )`, primitive 144:** same parsed-word
lookup, uppercasing, and `? unknown bank: <NAME>` error `BANK@` (99)
already has; pushes `Bank.size` (already rounded to its size class at
creation, `banks.ts`'s `createBank`) instead of `base`. Deliberately
read-only — `spec/02-MEMORY-MODEL.md` §7 explicitly defers any richer
resize/reallocate model ("do not design ahead of these"): banks are
handed out by a pure bump allocator with no compaction or relocation
ever, so resizing anything but the most-recently-created bank would
mean either relocating it (rewriting every absolute address anyone
holds into it — infeasible for `DICT` once anything's compiled) or
leaking the freed space (no freelist exists). Discussed as a possible
future feature; left with no reserved wording rather than guessed at.

**`BANK@` switches from `tag` to `name` (see §1.39's own "Update, M50"
note for the historical context).** `MemoryMap.findBankAddr()` (M20,
§1.41) — `BANK@`'s old tag-keyed lookup path — is deleted outright,
along with the `mmap.test.ts` suite that tested it directly; nothing
else called it. `BankTable.findBankByName()` (pre-existing, `storage.ts`'s
own lookup) is what both `BANK@` and `BANK-SIZE` call now.

**Every boot-created system bank gained an explicit `name` (`repl.ts`):**
`SYSV`/`DSTK`/`RSTK`/`DICT`/`CHAR`/`KMAP` previously omitted `name` and
got an auto-generated 8-digit serial (`WORK`/`EDITOR`/`MMAP` already
had explicit names) — without this, switching `BANK@` to name-based
lookup would have broken `BANK@ SYSV`-style calls immediately, since
`SYSV`'s bank was never actually *named* `SYSV`. Now name == tag for
all six, so nothing about typing `BANK@ SYSV` changed observably.

**`CREATE-BANK` itself is deliberately unchanged** — it still always
auto-generates a name, never derived from its tag argument (M27's own
fix, §1.43, for exactly the "two same-tagged banks silently collide on
name" bug this would reintroduce). One real, narrow consequence: a
bank made via `CREATE-BANK MYBANK` is *not* later reachable via
`BANK@ MYBANK` — `MYBANK` became its tag, not its name — only via the
address `CREATE-BANK` already returned, or the real auto-generated
name read back host-side. Two `mmap.test.ts` tests that assumed the
old tag-reachability were rewritten to prove this explicitly rather
than silently pass on the new (accidentally-still-working) semantics.

*Implementation:* `rebel-opcodes.json` (tokens 99, 144), `primitives.ts`
(case 99 rewritten, case 144 new), `repl.ts` (6 `createBank` calls gain
an explicit name), `mmap.ts` (`findBankAddr()` deleted). *Tests:*
`bank-access.test.ts` (rewritten for name lookup, `BANK-SIZE` suite
added), `block-io.test.ts`, `mmap.test.ts` (`findBankAddr` suite
deleted, two `CREATE-BANK` tests rewritten). `spec/02-MEMORY-MODEL.md`
§4.7 and `spec/01-HAL.md`'s bank-introspection item updated to describe
name-based lookup; `spec/04-FORTH-CORE.md`'s one stale "`BANK@` only
looks up by tag" aside corrected.

### 1.63 `BANKS` and `PROJECTS`: dev-ergonomics listing words (M51)

Requested directly by Oliver: a `WORDS`-shaped word for banks, and one
for saved projects, to browse "what actually exists right now" without
first knowing a name to ask `BANK@`/`BANK-SIZE`/`RESTORE` about.

**`BANKS ( -- )`, `system.fth`, right after `WORDS`.** Pure Forth, no
new primitive — `MMAP` is an ordinary arena-resident structure (its
fixed-stride 64-slot table, `mmap.ts`) just like the dictionary chain
`WORDS` already walks, so this walks it the same way, printing each
active slot's name field, space separated. Layout constants (header 16
bytes, 24 bytes per slot, name field at offset 4 for 8 bytes, `ACTIVE`
flags bit 4) are hand-copied from `mmap.ts` as plain `CONSTANT`s right
above the definition, same "no generator yet, a known gap" situation
`spec/00-OVERVIEW.md` already names. `MMAP`'s own base is a literal
`0` rather than `BANK@ MMAP` — `BANK@`'s name argument is a *live*
input token consumed at the moment it runs (`nextInputToken()`, the
same shared-cursor mechanism `PROJECT`/`CREATE-BANK`/`'` use), so it
cannot resolve a name embedded in a definition's own source the way a
compiled literal could; `MMAP` being permanently bank 0 at absolute
base 0 (`mmap.ts`'s own documented invariant) sidesteps the need
entirely. The name field is NUL-padded to 8 bytes with only ever
*trailing* padding (never an embedded gap), so the inner byte loop
just skips zero bytes rather than needing `LEAVE`, which still doesn't
exist (`spec/04-FORTH-CORE.md` §9).

**`PROJECTS ( -- )`, primitive 145.** Backed by `storage.ts`'s
`Storage.listProjects()` — project names live in the host storage
layer (`StorageHal`), not the arena, so unlike `BANKS` there's no
in-memory structure for pure Forth source to walk directly. An
ordinary synchronous primitive, same precedent as `PROJECT`/`SAVE`/
`RESTORE` (M33): genuinely usable inside a colon-definition or via
`EXECUTE`, since — unlike `BANK@`/`PROJECT` — it takes no argument at
all, so the raw-token-consuming-primitives caveat above doesn't apply
to it.

**A pre-existing doc staleness found while testing `BANKS` against a
real `CREATE-BANK`'d bank:** `rebel-opcodes.json`'s own note for
`CREATE-BANK` (100) still described its original M21 design — a
direct `mmap.allocate()` bypass, "name equals the tag, no auto-serial
scheme" — which M30 (`PLAN.md`) superseded: `CREATE-BANK` routes
through `BankTable.createBank()` now, so it *does* get an
auto-generated serial name, same as any host-side creation. §1.62
above already relied on the correct (M30) behavior when explaining
`BANK@`'s narrowed reachability; only the opcode note itself had
drifted. Corrected in place — see `dictionary.test.ts`'s note-lookup
tests for why this field is read live rather than duplicated by hand
anywhere.

*Implementation:* `system.fth` (`BANKS` plus its layout constants),
`primitives.ts` (case 145), `rebel-opcodes.json` (token 145 added,
token 100's stale note corrected). *Tests:* `bank-access.test.ts`
(`BANKS` suite), `project.test.ts` (`PROJECTS` suite).

### 1.65 `BANK@` becomes `IMMEDIATE`, dual-mode — usable inside a colon-definition (M53)

Found by Oliver trying `: TESTING BANK@ CHAR ;` — it aborted at
compile time with `unrecognized word: CHAR`, before `TESTING` ever
ran. Root cause: `BANK@` (99) was a plain, non-`IMMEDIATE` primitive,
so `interpretCompiling` (`repl.ts`) just compiled a call to it and
moved straight on to its *own* next token — `CHAR` — trying to find or
number-parse *that* as an ordinary word, right there at compile time.
`BANK@`'s `nextInputToken()` call never got a chance to run; by the
time `TESTING` itself could execute, the compiler had already choked
on `CHAR` and the definition never finished.

This is exactly the class of primitive §1.63 already flagged when
`BANKS` had to fall back to a literal `0` instead of `BANK@ MMAP` for
the same reason — but `BANK@` is common enough (every "reach a sysvar
from Forth" idiom, `BANK@ SYSV <offset> + @`, §1.39) that working
around it felt worse than fixing it, once actually asked.

**Fix: `BANK@` is `IMMEDIATE` now, and dual-mode on `STATE`** — the
same pattern `S"`/`."` already use (case 68/70), except baking in a
*resolved value* rather than raw text, since a bank's base address is
one cell, not a byte run:

```ts
const name = ctx.nextInputToken().toUpperCase();
const bank = ctx.banks.findBankByName(name);
if (bank === undefined) {
  throw new Error(`unknown bank: ${name}`);
}
if (ctx.sysvars.getState() === -1) {
  compileCell(ctx, findWord(ctx, 'LIT')!.cfa);
  compileCell(ctx, bank.base);
} else {
  s.push(bank.base);
}
```

While compiling, the name is resolved *now* — at `BANK@`'s own
compile-time execution, which `IMMEDIATE` is what makes happen at all
— and `LIT` + the resolved base address are compiled in, exactly the
same compiled shape an ordinary numeric literal produces
(`interpretCompiling`'s own number-parsing path). While interpreting,
behavior is unchanged: the address is pushed directly. Interactive use
(`BANK@ SYSV`, `BANKS`' own internals, every existing caller) is
observably identical either way — only the compiled-into-a-definition
case changes, from "doesn't work" to "works."

**Tradeoff, stated up front rather than discovered later:** the
address gets baked in once, at the *defining* line's own compile
time — correct for the fixed system banks (`SYSV`/`DICT`/`CHAR`/...,
permanent for a session) and any bank already created and stable when
the word compiling it is defined, but stale if that bank is later
dropped and recreated at a new address. No bank-drop primitive exists
yet, so this is a documented future footgun, not a present one.

**Live-verified** via `chrome-devtools-mcp`: `: TESTING BANK@ CHAR ;`
now compiles clean (`ok`, no abort); `TESTING .` and `BANK@ CHAR .`
both print the same address (`81920`); `BANK@ CHAR DUMP` interactively
still leaves the stack empty afterward.

*Implementation:* `primitives.ts` (case 99), `rebel-opcodes.json`
(token 99's `immediate` flag + note). *Spec:* `02-MEMORY-MODEL.md`
§4.7 (the `IMMEDIATE`/dual-mode requirement, stated as a MUST),
`04-FORTH-CORE.md` §5.3 (moved from the "interactive, not IMMEDIATE"
list to the "baked into the definition" list, with a note on how it
differs from `S"`/`."`). *Tests:* `bank-access.test.ts`'s new "`BANK@`
compiled into a definition (M53)" suite.

### 1.66 `BANK-RESIZE` and a resize-triggered restart (M54, Oliver's idea)

Oliver's idea, working from two observations: `DICT` is the bank most
likely to ever need resizing (a project outgrowing its dictionary
capacity is a real, expected failure mode; the others less so), and
moving `DICT` right after `SYSV` (this same session, just before) keeps
its own base pinned regardless of how many times it's resized, since
neither it nor `SYSV` ever shift due to a *later* bank's resize.

**The mechanism, in three parts:**

1. **`BANK-RESIZE ( new-size "name" -- )`** (146) edits a bank's own
   `size` field in `MMAP` directly (`mmap.ts`'s `setSlotSize()`, reached
   through `banks.ts`'s `resizeBank()`), rounded to a size class the
   same way `CREATE-BANK` rounds. No bytes move, no other bank's base
   changes. Deliberately inert for the *currently running* `Machine`:
   `DataStack`, `dictionary.ts`'s `HERE`-overflow check, `Screen`, and
   `Keyboard` all captured their own bank's descriptor once, at
   construction time — a live `MMAP` edit doesn't reach any of them. A
   fresh `BANK@`/`BANK-SIZE` query *does* see the new size immediately
   (both always read `MMAP` fresh) — the split precisely between "read"
   and "the running subsystems that actually bounds-check against it"
   is what makes this safe to do mid-session at all.
2. **`RESTORE` (128) detects a pending resize before doing anything.**
   Comparing the project's saved sizes against `Machine.dictBank.size`-
   style live descriptors would be wrong — those already reflect any
   `BANK-RESIZE` edit, so they'd always agree with what was just saved.
   Comparison is instead against a new snapshot, `Machine`'s
   `bootBankSizes` map, captured once right after every bank is created
   in the constructor — the size each bank *actually* booted with,
   untouched by anything that runs afterward. Any saved size differing
   from that snapshot means reopening this project needs a different
   bank layout than the one currently running.
3. **A mismatch reboots instead of patching in place** — the same
   structural reason `COLD` already reboots rather than resetting a
   `Machine`'s readonly fields: `inner.ts`'s `dispatch()` special-cases
   the `RESTORE` token (never reaches `executePrimitive`'s switch, same
   tier as `COLD`/`ACCEPT`/`EXECUTE`), yielding a new `'restart-project'`
   `StepSignal` (`Inner.restartAtProject` carries the project name,
   mirroring `pausedAtXt`) instead of running `restoreProject()`. The
   host (`app.ts`'s `tick()`) treats it exactly like `'cold'` — discard
   `this.machine`, construct a fresh one — except `performBoot()` now
   takes an optional project name, threaded into `Machine`'s new
   `bootProject` option.

**`bootProject` in `Machine`'s constructor** peeks the project's saved
bank sizes (`storage.ts`'s `peekProjectAssets()`, a standalone function
— no `Storage` instance exists yet at this point in the constructor,
since `Storage` itself is built from `BankTable`) *before* creating a
single bank, using a saved size in place of the hardcoded default
wherever one exists. Every `createBank()` call in the constructor
already ran in a fixed order (`SYSV`, `DICT`, `DSTK`, `RSTK`, `CHAR`,
`KMAP`, `WORK`, `BLKS`) — feeding a bigger `DICT` size into that same
sequence makes the bump allocator naturally push `DSTK`/`RSTK`/`CHAR`/
`KMAP`/`WORK`/`BLKS` forward by exactly the growth, with zero bespoke
relocation logic. Content is restored afterward via
`Storage.openProject()`'s existing by-name matching (a new
`skipLayoutRestore` parameter skips only the raw `MMAP.MAP` byte copy,
which would otherwise stomp the freshly-correct bases with the OLD
saved snapshot — everything else, including the fresh-create fallback
for a genuinely-extra `CREATE-BANK`'d project bank, is unchanged).

**A correctness trap found while designing this, not by testing
afterward:** `DSTK`/`RSTK` are stack-shaped — their "how full" state
(`SP`/`RP`, live `SYSV` cells) is an absolute address measured from
`base + size`, the *high* end. `DICT`'s own `HERE`/`LATEST` are safe
regardless of `DICT`'s own resize (they're low-end-relative, and
`DICT`'s base never shifts — the whole reason for pinning it right
after `SYSV`), but restoring a saved `SP` value verbatim after *any*
earlier bank's resize shifted `DSTK`'s base would silently misplace the
stack's top by exactly the shift, without erroring — `DEPTH` would
overreport by that many phantom cells, and `DROP`/arithmetic would
consume garbage before reaching anything genuinely pushed. Fix: a
resize-triggered restart unconditionally clears both stacks
(`this.stack.clear()`/`this.rstack.clear()`, the same `WARM` already
does on a soft reset) after content-restore — data/return stack
contents were never expected to survive a structural relayout like
this anyway.

**Live-verified** via `chrome-devtools-mcp` against the real app:
pushed `11 22 33`, `70000 BANK-RESIZE DICT` (`DICT` 65536 → 262144
bytes), `PROJECT`/`SAVE`, then `RESTORE` — the screen showed a full
reboot (a fresh `Rebel Forth vX.Y.Z` banner, `RESTORE`'s own `ok` never
printed, same as `COLD` never lets the rest of its line run). Post-
reboot `read_banks` confirmed `DICT` at the new size, every later bank
shifted forward by exactly the growth (`DSTK` `73728` → `270336`, a
196608-byte shift matching `262144 - 65536`), the stack empty, and a
follow-up `SAVE` still succeeding (the project name round-tripped
through `SYSV`'s ordinary, unrelated content-restore).

*Implementation:* `mmap.ts` (`findSlotIndex`/`setSlotSize`), `banks.ts`
(`resizeBank`), `storage.ts` (`peekProjectAssets` extracted standalone,
`openProject`'s `skipLayoutRestore`), `primitives.ts` (case 146,
`restoreProject`/`projectNeedsRestart` extracted from the old case
128, `PrimitiveContext.bootBankSize`), `inner.ts` (`RESTORE` special-
cased in `dispatch()`, new `'restart-project'` `StepSignal`,
`Inner.restartAtProject`), `repl.ts` (`bootBankSizes` snapshot,
`bootBankSize()`, `bootProject` option, `'restart-project'`
`StepStatus`), `app.ts` (`resetUiSnapshotsForReboot()` extracted,
`'restart-project'` handling, `performBoot`/`constructMachine` take an
optional project name). *Spec:* `02-MEMORY-MODEL.md` §4.8 (new — the
resize mechanism itself, target-neutral) and §7 (the old "no richer
resize model" deferral narrowed to what's still actually undesigned:
reclaim, relocation-outside-a-full-re-derivation, compaction).
*Tests:* `resize.test.ts` (new — 13 tests: `BANK-RESIZE` rounding/
inertness/guardrails, unchanged in-place `RESTORE` behavior when
nothing was resized, and the full resize round trip: restart detection,
size/base re-derivation, stack clearing, and a dynamic bank surviving
the restart).

### 1.67 Size classes double instead of quadrupling, and lose their letter names (M55, Oliver's idea)

Prompted by using the resize mechanism (§1.66) for the first time:
"this almost feels elegantly simple and restrained" about the resize
itself, followed immediately by "I think we need to think about the
allocation size classes ... the jumps we have are a bit big and
unpredictable." Fair — the old ladder (`XS` 4 KiB, `S` 16 KiB, `M`
64 KiB, `L` 256 KiB, `XL` 1 MiB, `XXL` 4 MiB) grew 4x per step, so a
request just over a class boundary could round up by nearly 4x. The
explicit original goal of having size classes at all — banks are
handed out from a small fixed ladder specifically so `BANK-RESIZE`/
`CREATE-BANK` can't degrade into arbitrary-sized `malloc()`-style
allocations — still holds; only the ladder's *granularity* needed
revisiting.

**Fix: plain doubling, no named classes.** `roundToSizeClass(bytes)`
computes the next power of two directly (a `while` loop doubling from
`MIN_BANK_SIZE`) instead of scanning a lookup array of six named
constants:

```ts
export const MIN_BANK_SIZE = 4 * 1024;
export const MAX_BANK_SIZE = 4 * 1024 * 1024;

export function roundToSizeClass(bytes: number): number | undefined {
  if (bytes > MAX_BANK_SIZE) return undefined;
  let size = MIN_BANK_SIZE;
  while (size < bytes) size *= 2;
  return size;
}
```

This halves worst-case rounding waste (under 2x instead of under 4x)
while *removing* code rather than adding it — no maintained
`SIZE_CLASSES` array, and no more `BankSizeXS`/`S`/`M`/`L`/`XL`/`XXL`
constants to keep in sync across every consumer. A bank's size class is
simply its own rounded byte count now; nothing else names it.

**A satisfying, unplanned consequence:** every bank size chosen before
this change (4096, 65536, ...) was already a power of two — the old
4x-per-step classes were exactly the *even* powers of two (2^12, 2^14,
2^16, ...), and this ladder just fills in the odd ones between them
(2^13, 2^15, ...). So no existing bank's actual byte size changes; only
a *new*, in-between request (like `BANK-RESIZE`'s own `70000 BANK-RESIZE
DICT` in §1.66's live check, which now rounds to 131072 instead of the
old scheme's 262144) rounds more tightly.

*Implementation:* `banks.ts` (`MIN_BANK_SIZE`/`MAX_BANK_SIZE` replace
the six named constants and `SIZE_CLASSES`; `roundToSizeClass`
rewritten), `index.ts` (re-export list updated), `mmap.ts` (comments
only — no behavior change, `MMAP_SIZE` is still 4096). *Spec:*
`02-MEMORY-MODEL.md` §4.3 (the doubling rule replaces the six-class
table), §5.3/§5.4 (letter references removed, worked-example table
loses its Class column — no bank's Base/Size numbers change),
`03-SYSVARS.md` (two "XS class" mentions reworded). *Tests:*
`banks.test.ts`'s `roundToSizeClass` suite rewritten for the new
ladder; `resize.test.ts`/`bank-access.test.ts`/`storage.test.ts`/
`mmap.test.ts` comments and imports updated, no test *behavior*
changes beyond `roundToSizeClass`'s own new rounding points.

### 1.68 The remaining core screen-editor commands (M56)

M48 (§1.65's predecessor milestone) shipped only "the core edit/run
loop" — `LIST`/`L`, `T`, `LOAD`, `TOP`/`CLEAR` — deliberately deferring
the rest of `inspiration/figforth_editor_screens.txt`'s own six-screen
word set. Requested directly: "let's implement the remaining core
editor commands," followed by "everything" (line editing, search/
replace, and `COPY`) once asked how much to build in one pass, and
"keep classic name I" once asked about the one real naming collision
(`I` shadows `DO`/`LOOP`'s own loop index inside `EDITOR`, the same
reason `EDITOR` needed its own vocabulary in the first place).

**Cursor tracking (`R#`, `#LOCATE`, `#LEAD`, `#LAG`, `M`).** Classic
Forth's own `R#` is an absolute byte offset (0..1023) within the
current screen, ported faithfully as a plain `VARIABLE`. `#LOCATE`
splits it into `(col, line#)` via `/MOD`; `#LEAD`/`#LAG` are the
addr/len spans before and after the cursor on its own line; `M ( n -- )`
advances `R#` by `n` and redraws that line with a printed underscore
marking the cursor, classic Forth's live "you are here" feedback every
command below calls at the end. `LINE ( line# -- addr )`, a new shared
helper, factors out the address arithmetic `T` used to inline directly
and adds the bounds check classic's own `LINE` had and this project's
`T` never did — `T` itself was touched only to route through `LINE`
and to set `R#` first (`DUP C/L * R# !`), so a `T` immediately followed
by a cursor-relative command like `F`/`N` acts on the line just typed
rather than wherever the cursor last happened to be. `L`/`LIST`/`TOP`/
`CLEAR` themselves are otherwise untouched — none of them needed `R#`
to already work correctly.

**Line editing (`TEXT`, `-MOVE`, `H`, `E`, `S`, `D`, `R`, `P`, `I`).**
`TEXT` is `T`'s own delimiter-one `WORD` idiom factored out, reading
free-form typed text into `PAD` — the shared scratch buffer `S"`/`."`
already established `PAD`'s "no reentrancy, overwritten unconditionally
on next use" contract for (`rebel-opcodes.json`'s own `PAD` note); a
new `TEXT-LEN` records how many real, non-padded characters were
actually read, since this project's `PAD` holds no leading count byte
the way classic's own counted-string convention does. `-MOVE`/`H`/`E`/
`S`/`D` are classic exactly (decimal instead of classic's own hex),
each adapted only for the addr/len-not-counted-string PAD convention.
A genuinely satisfying discovery while tracing classic `D`'s own dense
stack code by hand: `D` calls `H` first not for tidiness but as a
deliberate cut — the deleted line's content lands in `PAD`, so an
`I` (insert) immediately afterward pastes it straight back, live-
verified end to end (delete line 1, insert at line 1, the exact
original three-line layout reappears). `R ( line# -- )` replaces a
line wholesale with whatever's in `PAD`; `P ( line# -- )` is `TEXT R`,
the everyday retype-this-line command; `I ( line# -- )` is `S R`,
classic's own name kept per Oliver's explicit choice — safe because
every `EDITOR` word defined before it that needs a loop index (`S`,
`D`) is already compiled with the real loop-index `I` baked into its
own body; nothing defined after `I` may write a bare `DO...I...LOOP`
inside `EDITOR` again. `PAD` itself gets a one-time space-fill right
after `CLEAR`'s own definition — unlike `BLKS`, nothing native pre-
fills it, and `I` can paste `PAD`'s content into a screen line without
ever calling `TEXT` first (classic's own paste-whatever-was-last-held
behavior, not a bug) if nothing was ever typed.

**`COPY ( source target -- )`** duplicates one screen into another.
Classic's own version scales for multiple disk buffers per screen
(`B/SCR`); this project's `BLOCK-SIZE` already matches one screen to
one buffer exactly, so it collapses to a single `BLOCK-SIZE CMOVE`
between the two screens' resident buffers, `UPDATE`, `FLUSH` — no
`DO`/`LOOP` at all, so (unlike `S`/`D`) its position relative to `I`
doesn't actually matter for the loop-index reason, though it's kept
grouped with the other line-editing words above `I` regardless.

**Search and replace (`-TEXT`, `1LINE`, `FIND`, `DELETE`, `N`, `F`,
`B`, `X`, `TILL`, `C`).** Classic's own versions (screens 4-6) are
dense, register-starved stack code — `MATCH` alone chains `>R >R 2DUP
R> R> 2SWAP` before its search even starts — written for hardware this
project has no reference implementation of to test transcription
against, and built on a `LEAVE` this project's `DO`/`LOOP` doesn't have
(spec/04-FORTH-CORE.md §9). Reimplemented instead with named scratch
`VARIABLE`s (the same clarity-over-density choice `T-LINE` already
established) and `BEGIN`/`WHILE`/`REPEAT` loops, preserving every
classic name and role: `-TEXT ( addr1 addr2 len -- flag )` byte-
compares; `1LINE ( -- flag )` searches the current line from the
cursor onward for `PAD`'s `TEXT-LEN` bytes, advancing `R#` *past* a
match (or to the line's end on failure); `FIND ( -- flag )` calls
`1LINE` across the whole screen, wrapping once at the screen's end;
`DELETE ( n -- )` shifts `n` bytes out of the *flat* 1024-byte buffer
at the cursor, spanning line boundaries freely, not the sixteen-line
display grid (confirmed live: deleting mid-line-0 text pulls line 1's
own leading characters into line 0's now-shorter tail — a real,
documented consequence of the block being one flat buffer, not a
bug). `N`/`F`/`B`/`X`/`TILL`/`C` are classic exactly in role: `F`
reads a new pattern and searches forward; `N` repeats the last one;
`B` backs up by exactly the pattern's own length, undoing one `1LINE`
advance; `X` finds and deletes a match; `TILL` deletes from the cursor
through a match on the current line only; `C` overwrites from the
cursor with fresh text, capped to whatever room is left on the line.

**One deliberate scope cut: `TS` is not ported.** Classic's own
interactive multi-line entry (`10 0 DO ... T LOOP`, screen 6) depends
on a blocking terminal read — each loop iteration's `T` call genuinely
pauses for the *next* line the user types. This project's `WORD`
(`T`'s own delimiter-one scan) never blocks: it returns immediately
with nothing found once the current input line runs out
(spec/04-FORTH-CORE.md §6.13's own contract). A literal port would
silently blank fifteen lines instead of prompting for each one — real
support would need `WORD` to suspend and resume the way `ACCEPT`
already does (`inner.ts`), a genuine engine change, not an
`EDITOR`-vocabulary word, so it's left as a documented gap rather than
shipped broken.

**Three real bugs found and fixed while building this, all caught by
either hand-tracing the stack effects or the test suite before this
ever reached the live app:**
1. A Forth `( ... )` comment doesn't nest — an inner `(` closes the
   comment at the *first* following `)`, dumping the rest of that
   prose line as code. Every multi-line explanatory comment in this
   section was first drafted with ordinary nested parentheses (English
   asides), which aborted `system.fth`'s own load the instant it hit
   one; rewritten throughout using em-dashes/commas instead, and
   caught immediately by loading the file line-by-line the same way
   `test-support.ts`'s `bootMachine()` does before any of this reached
   a real test.
2. `TEXT` was declared to set `TEXT-LEN` (needed by the search words
   added afterward) but the actual `DUP TEXT-LEN !` line never got
   added to `TEXT`'s own body in the first editing pass — `TEXT-LEN`
   silently stayed 0 forever, making every search "match" trivially at
   the cursor's current position without moving it. Caught by
   instrumenting `-TEXT`/`1LINE` directly rather than trusting the
   higher-level `F`/`N` output, which just looked like "nothing
   happened" without explaining why.
3. `-TEXT`'s first draft used `2DUP` assuming it would duplicate the
   two *address* arguments — it actually duplicates whatever's
   currently on top, which by that point in the word was `(addr2,
   len)`, not `(addr1, addr2)`. Rewritten with its own named scratch
   variables instead of relying on stack position at all, the same
   fix direction as `1LINE`'s design from the start. A related but
   separate bug in `FIND`'s own give-up path — leaving `R#` at exactly
   `BLOCK-SIZE` (one past the last valid byte) when a bounded search
   found nothing, which `M`'s subsequent `LINE` call then rejected —
   was fixed by factoring the wrap check into its own `WRAP-R#` word
   and calling it from both the loop's top *and* the early exit path.

**Live-verified** via `chrome-devtools-mcp` against the real app: `F`/
`B` landing and un-landing a match precisely; `X`/`TILL` deleting
exactly the intended span (including `X`'s own flat-buffer ripple into
the following line); `D` then `I` restoring an exact three-line
layout via the cut-to-`PAD` behavior; `COPY` duplicating a whole
screen.

*Implementation:* `system.fth` only — no engine changes this time.
*Tests:* `screen-editor-commands.test.ts` (new, 19 tests) covering
`LINE`'s bounds check, the cursor words, every line-editing command
including the `D`→`I` cut/paste round trip, `COPY`, and the full
search/replace set including `FIND`'s bounded not-found termination.

### 1.69 `TS`: interactive multi-line block entry (M57)

§1.68 (M56) left `TS` — classic's interactive multi-line screen entry —
deliberately unported, reasoning that it needed `WORD` itself to
suspend mid-scan and resume once more input arrived, a genuine engine
change. Revisiting that with Oliver surfaced that the premise was
wrong: classic's own `T` (screen 2, `DUP C/L * R# ! H 0 M`) never
reads anything at all — it only repositions the cursor and redraws,
relying on the *terminal's own hardware* to echo keystrokes straight
into the display at a hardware cursor, a model this project's
`CHAR`-bank-backed screen doesn't have and was never going to get.
Documented as `FORTH-ARCHITECTURE.md` §9 item 17 (the general
scheduler-less-blocking-`KEY` question) before coming back to build a
real, working `TS` — rebuilt around this project's own architecture
rather than ported literally.

**The actual gap needed no engine change.** `KEY` already blocks
(`inner.ts`, M7) and already suspends correctly through any depth of
colon-word/loop nesting: `dispatch`/`executeXT`/`threadFrom` all
delegate via `yield*`, so a plain Forth `BEGIN`-loop wrapped around
`KEY` gets exactly the same suspend/resume behavior `ACCEPT` gets, for
free — confirmed by reading `threadFrom`'s own dispatch loop, every
non-special token (ordinary calls *and* `DO`/`BEGIN` control flow
alike) already routes through `yield* this.dispatch(slotCode)`. What
`TS` actually needed instead was its own positioned-write loop:
`EMIT`/`TYPE`'s free-running stream cursor doesn't line up with block
lines, since `C/L` (64) doesn't evenly divide this project's 80-column
physical screen — so every character `TS` writes is drawn with
`AT-XY`/`CHAR!` at an explicitly computed column/row (`#LOCATE`),
never via `EMIT`'s own auto-advancing cursor. `CURSEN`/`CURSDIS`
(M25) — built four milestones before `TS` existed and never actually
called from `system.fth` until now — turned out to be exactly what was
needed for a live blinking/inverted cursor during typing, since
`Screen.setCursor()` already redraws the inverted cell correctly on
every `AT-XY`.

**Entry and the main loop.** `TS` opens with `CLS` and a full redraw of
the current screen's 16 existing lines (`0 I AT-XY  I LINE C/L TYPE`,
looped) — using a named `TS-ROW` counter with `BEGIN`/`WHILE` rather
than a bare `DO`/`LOOP`, since a literal `I` inside `EDITOR` by this
point in the file resolves to `EDITOR`'s own insert-line command
(§1.68's own constraint), not the loop index. `R#` starts at 0,
`TS-START` records that starting point (so Backspace can't erase past
it — the same never-go-below-where-this-call-started rule `ACCEPT`
already enforces), the visible cursor turns on, and the loop reads one
`KEY` per iteration. There's no `AGAIN` in this dialect — only
`BEGIN`/`UNTIL` and `BEGIN`/`WHILE`/`REPEAT` are defined — so the loop
is `BEGIN ... 0 UNTIL`, an unconditional loop-back (`0` is `FALSE`,
and `UNTIL` branches on `FALSE`), with every real exit an explicit
`EXIT`.

**Per-keystroke behavior**, confirmed with Oliver rather than assumed:
Esc ends the session immediately, keeping whatever was typed so far
(no undo/rollback buffer — adding one wasn't judged worth it for a
first cut) and leaving the cursor visible right where typing left off
(Oliver's own follow-up after using it — `CURSDIS` dropped from just
this exit path, unlike the two `BLOCK-SIZE`-overflow exits below,
which really do have nothing left to point at). Enter advances `R#`
to the start of the next line; on the
last line (15) that computation lands exactly on `BLOCK-SIZE`, which
the same overflow guard used for ordinary typing already catches, so
Enter-on-line-15 needed no special case at all — it just falls out of
sharing that guard. Backspace steps back one, blanks that cell in both
the block and on screen, and refuses to go below `TS-START`. An
ordinary character is written into the block at `R#`
(`SCR @ BLOCK R# @ +  C!`), drawn via `CHAR!` at its own `#LOCATE`'d
column/row, and `R#` advances — crossing a line boundary here
auto-advances to the next line with no Enter needed (Oliver's call,
over requiring an explicit Enter at the line boundary), sharing the
same `BLOCK-SIZE` guard as Enter's own end-of-screen case, so filling
the last line to its very end also ends the session cleanly.

**Cursor keys (Oliver's follow-up), Up/Down/Left/Right.** Same
groundwork as Escape: unmapped in `keyboard.ts`'s default `KMAP` like
every other non-printable key, so four more entries were added (codes
2-5, chosen only to dodge control codes already spoken for — 1 is
`TEXT`'s own end-of-line `WORD` delimiter, 8/9/10/27 are Backspace/
Tab/Enter/Escape). Movement itself is simpler than everything else in
`TS`: adjust `R#` by ±1 (Left/Right) or ±`C/L` (Up/Down), clamp to
`0..BLOCK-SIZE`, `#LOCATE AT-XY` — no block/screen write at all, unlike
every other branch in the loop. Asked directly whether movement should
stay bounded to wherever a session had actually typed (mirroring
`ACCEPT`'s own never-go-below-where-this-call-started rule, which
Backspace had been enforcing via a `TS-START` variable) or roam the
whole screen: "consistent to drop clamping everywhere ... as long as
we stay inside the screen buffer boundaries overall." Dropping it
turned out to simplify the code, not just extend it — `TS` always
starts fresh at `R# ! 0` (no way to resume elsewhere), so `TS-START`
had only ever equaled 0 in practice; it's gone now, replaced by a
plain `R# @ 0 >` bounds check shared with Left.

**Two real bugs the test suite caught, both before this reached the
live app:**
1. Five separate nested-`(...)`-comment breaks, found in two passes
   (same class of bug as §1.68's own first bug) — an English aside in
   parentheses inside a
   `( ... )` comment closes it at the *first* following `)`, not the
   intended one, dumping the rest of that prose line as code. Caught
   immediately by loading `system.fth` line-by-line the same way
   `test-support.ts`'s `bootMachine()` does.
2. `>=` doesn't exist in this dialect — the *same* gap §1.68's `FIND`
   already hit once and worked around inline with `< 0=`; `TS`'s own
   `BLOCK-SIZE` overflow guard hit it again independently. Two separate
   bugs from the same missing word is exactly the "wait for a real
   need" signal `CLAUDE.md`'s own scope-calibration section asks for —
   added for real this time (`: >= < 0= ;`, next to `<>`'s own
   `= INVERT`), and `WRAP-R#`/`TS` both now call it instead of the
   inline workaround. Fixing it also surfaced a real correctness bug
   the very first test run caught: `TS`'s overflow guard exited
   *without* resetting `R#`, leaving it at exactly `BLOCK-SIZE` (one
   past the last valid line) instead of wrapping back to 0 like every
   other boundary case in this file already does — fixed by calling
   `WRAP-R#` itself right there instead of duplicating the reset.

**A genuine, honest cross-target divergence, not silently papered
over:** Escape (HID usage `0x29`) had no `KMAP` entry at all — every
non-printable key besides Enter/Backspace/Tab/Space stays untranslated
by design (`keyboard.ts`), so `KEY` could never actually see an Esc
press before this. Added as `TS`'s own cancel key, but `rebel-rom`
isn't present in this checkout to confirm its own `CKeyboardModule::
BuildDefaultKeymap` does the same — the comment says so explicitly,
flagged as worth reconciling once a C++ Forth executor's own screen
editor needs the same thing, rather than claimed as settled parity.

*Implementation:* `system.fth` (`TS`, `TS-ROW`, `>=`), `keyboard.ts`
(Escape and the four cursor keys added to the default keymap).
*Tests:* `screen-editor-commands.test.ts` (12 tests: plain typing,
Enter mid-screen, Enter on the last line, Esc, Backspace's own
boundary, auto-advance at the end of a line, Left/Right/Up/Down
movement and their own boundaries); `keyboard.test.ts` (Escape's and
the cursor keys' own translation).

### 1.64 `DUMP`: a classic hex dump (M52)

Requested directly as a follow-on to `BANKS`/`PROJECTS`: 16 rows of 8
bytes each — an 8-digit hex address, 8 space-separated 2-digit hex
bytes, then those same 8 bytes again as characters (anything below
`BL`, a non-printable control code, shown as `.` instead) — a fixed
128-byte dump starting at a given address, no length argument. Pure
Forth, `system.fth`, right after `BANKS`; no engine changes.

**Nibble/byte/cell hex formatting built from scratch, no shift
primitive needed.** `HEXDIGIT ( n -- )` maps 0-15 to an ASCII hex
digit. `HEX2 ( byte -- )` prints a byte as two digits via one `/ 16`
(the high nibble) and one `MOD 16` (the low nibble) — no loop needed,
a single byte only has two nibbles. `HEX8 ( n -- )`, the interesting
one: extracts all eight nibbles of a cell via a `DUP 16 MOD SWAP 16 /`
loop, which leaves them on the stack lowest-nibble-first with the
now-always-zero ninth remainder on top; dropping that remainder and
then just popping straight through `HEXDIGIT` eight times prints
most-significant-first with no separate reversal step, since the last
nibble extracted is the most significant one and popping is LIFO.
Avoids needing a native `RSHIFT`/`LSHIFT` this codebase doesn't have —
plain `/`/`MOD`, already KERNEL primitives, are enough.

**No bounds checking against the arena's real extent** — same
trust-the-caller precedent raw `@`/`C@`/`BANK@` already have; dumping
past a bank's own end just reads whatever memory happens to follow.

**Live-verified** via `chrome-devtools-mcp`: `BANK@ SYSV DUMP` shows
the `SYSV` header's `'S'`/`'V'` magic bytes, its mostly-zero content
rendered as dots, and `0xFF` sysvar bytes rendering as their own raw
extended-ASCII glyphs — the spec's "0x20 or higher" printable rule has
no upper bound, so a high byte prints whatever glyph that code point
maps to rather than another dot, exactly as asked for.

*Implementation:* `system.fth` (`HEXDIGIT`/`HEX2`/`HEX8`/`DUMP`).
*Tests:* `dump.test.ts` (new).

### 1.70 `MIN_BANK_SIZE` drops to 2 KiB, and `DSTK`/`RSTK` shrink to 512 cells (M58, Oliver: "align on 2K banks as the smallest size")

Prompted by auditing what the M55 doubling ladder's 4 KiB floor was
actually buying: `MMAP` (1552 raw bytes), `KMAP` (512-byte keymap
table), `WORK` (384 bytes of `TIB`+`PAD`), and `SYSV` (448 bytes of
real sysvar content, against a 4096-byte request the boot code chose
explicitly) were all burning 2.5–3.5 KiB of pure allocator overhead per
arena for no reason tied to real content size. §4.3's floor was never
an MMU-paging requirement (this model doesn't page, §4.4) — just a nod
to ARM's native page size — so there was no structural reason it
couldn't drop further.

**Two design questions this raised, resolved with Oliver before
touching code:**

1. **Allocator alignment must track the floor, not stay hardcoded.**
   `mmap.ts`'s bump allocator (`(base + 4095) & ~4095`) was hardcoded
   to 4 KiB independently of `MIN_BANK_SIZE` — harmless while the two
   happened to be equal, but decoupled from a 2 KiB floor it would
   silently reintroduce padding waste between consecutive 2 KiB banks
   (up to 2 KiB lost realigning to a stale 4 KiB boundary), exactly the
   problem M55 eliminated. Resolved: alignment now derives from
   `MIN_BANK_SIZE` (`(base + 2047) & ~2047`), preserving the "every
   size class is a multiple of the alignment, nothing ever pads"
   property at the new floor.
2. **`DSTK`/`RSTK` are not a free shrink.** Unlike `MMAP`/`SYSV`/
   `KMAP`/`WORK`, whose 4096-byte requests were headroom above a much
   smaller real requirement, `DSTK`/`RSTK` were requested at exactly
   4096 bytes *by design* — 1024 cells of stack depth, not something
   rounded up from a smaller natural need. Dropping them to the new
   2 KiB floor is a genuine capacity cut to 512 cells each, not a side
   effect of the floor change. Resolved: cut them anyway, deliberately,
   alongside the floor change rather than leaving them at their old
   4096-byte size (which the new ladder still supports as the
   second-smallest class — nothing forces every bank down to the
   floor).

**A cross-target note, not resolved here:** `SYSV`'s and `KMAP`'s old
4096-byte sizing was explicitly commented as "matches Rebel-ROM's
minimum size class" — `rebel-rom`'s own `docs/MEMORY-MODEL.md` is
still on the pre-M55 four-name `XS`..`XXL` ladder (`XS` = 4 KiB) and
hasn't adopted the M55 doubling ladder at all yet, so this floor drop
widens an already-existing divergence between the two targets' bank
tables rather than creating a new one. Flagged in `repl.ts`'s own
comments rather than silently dropped; reconciling `rebel-rom` to a
matching ladder is a separate, future piece of work.

`CHAR` and `DICT`/`BLKS` are unaffected: `CHAR`'s real content (80×60
= 4800 bytes at the default screen size) already exceeds 2 KiB, so it
rounds to the same 8192-byte class either way; `DICT` (65536) and
`BLKS` (16384) were already well above the floor.

*Implementation:* `banks.ts` (`MIN_BANK_SIZE` 4×1024 → 2×1024), `mmap.ts`
(`MMAP_SIZE` 4096 → 2048, bump-allocator alignment 4095/~4095 →
2047/~2047), `repl.ts` (`SYSV_BANK_SIZE`/`KMAP_BANK_SIZE` 4096 → 2048;
`DSTK_BANK_SIZE`/`RSTK_BANK_SIZE` 4096 → 2048, i.e. 1024 cells → 512
cells; comments updated, including the `rebel-rom` divergence note
above). *Spec:* `02-MEMORY-MODEL.md` §4.3 (floor), §4.4 (alignment
tracks the floor), §5.3/§5.4 (`MMAP` size and worked-example table
recomputed), §8 (conformance table). *Tests:* `banks.test.ts` (comment
only, symbolic via `MIN_BANK_SIZE`/`MAX_BANK_SIZE`, no literal
changes), `mmap.test.ts`, `bank-access.test.ts`, `storage.test.ts`
(rounding-result assertions that hardcoded 4096 for a sub-2-KiB
request now expect 2048), `strings.test.ts` (comment only).

### 1.71 Arena-resident `FONT` bank, loaded from `rebel.FNT` by default (M59)

`packages/app/public/rebel.FNT` (2048 bytes — verified byte-identical
in layout and content to the glyph table this replaces: 256 chars × 8
bytes/glyph, one row per byte, MSB = leftmost pixel) was generated by
the user's own font-editing tool. Resolves `spec/03-SYSVARS.md` §8's
long-standing "populate when one actually does; do not speculate ahead
of that need" note for the `FONT` sysvar group for real — this is that
need.

**Engine creates the container, host fills the content** — the same
split `DICT`/`system.fth` already established. `repl.ts` creates a
`FONT` bank at boot (`FONT_BANK_SIZE = 2048` — the font's exact real
payload, and exactly `MIN_BANK_SIZE`, M58, so no rounding waste either)
and sets the new `FONT.FONT-BASE` sysvar to its address; the engine
package itself ships no font data, staying host-agnostic
(`PORTING-WEB.md`). `app.ts` fetches `rebel.FNT` and writes it into the
arena at `FONT-BASE` afterward, in parallel with `system.fth`
(`Promise.all`, both awaited before `VERSION`/`startRepl()` runs — the
same ordering guarantee that already kept nothing rendering before
`system.fth` loaded now also guarantees no glyph is ever blitted before
real font bytes exist). A fetch failure fails loudly, same
no-try-catch philosophy as `loadSystemVocabulary()`.

**`CanvasScreenHal` reads glyphs from the arena now**
(`arena.readByte(fontBase + charCode*8 + row)`) instead of importing
the now-deleted `font-zxspectrum.ts`. It's constructed *before* the
`Machine` that owns the arena it needs to read from (`screenHal` is a
`Machine` constructor option) — solved with a small `attach(arena,
sysvars)` method called immediately after `new Machine(...)` in
`app.ts`'s `constructMachine()`, before anything can possibly blit a
glyph. `FONT-BASE` is read fresh on every blit (not cached), so
repointing it at a different `FONT`-tagged bank — a future font
switch — needs no new mechanism.

**Iteration workflow, confirmed with Oliver:** a plain browser refresh
(edit `rebel.FNT` with the font editor, refresh) is the whole loop —
same as `system.fth` already works today. No dedicated live-reload tool
built; genuinely easy to add later if refresh-based iteration turns out
to be too slow in practice.

**A real cross-target divergence, flagged not hidden:** `rebel-rom`'s
own font system stays entirely HAL-side — compiled-in `TFont` structs
chosen once at boot, no Forth-addressable bank, no runtime switching
yet (`rebel-rom/docs/FONT-SYSTEM.md` §6: "Runtime font switching is
Forth/Phase 11 territory... when it lands, it should only need to
reconstruct/rebind `CCharGenerator` with a different `TFont`
reference"). This makes Rebel-Sim's font model genuinely ahead of
`rebel-rom` here, consistent with its "design lab the hardware targets
get implemented against" role (`CLAUDE.md`) — `01-HAL.md` §3.7 makes
the `FONT` bank/sysvar OPTIONAL group-wide for exactly this reason: a
target with no Forth-addressable font bank at all stays fully
conformant.

*Implementation:* `rebel-opcodes.json` (`sysvarGroups.FONT.fields` gets
`FONT-BASE`; `bankTags` gets `FONT`), `repl.ts` (`FONT_BANK_SIZE`, bank
creation, sysvar set), `canvas-screen-hal.ts` (rewritten to read the
arena instead of importing a compiled-in font; `attach()`),
`app.ts` (`constructMachine()`'s `attach()` call; new
`loadDefaultFont()`, run via `Promise.all` alongside
`loadSystemVocabulary()`). `font-zxspectrum.ts` deleted. *Spec:*
`02-MEMORY-MODEL.md` §4.6 (`FONT` added to known bank tags, shared),
§6.2 (shared-bank list); `03-SYSVARS.md` §8 (real `FONT-BASE` field,
replacing the "fully reserved" note); `01-HAL.md` §3.7 (new — sysvar
contract for `FONT`, OPTIONAL group-wide), §10 (removed from the
deferred list, `SPRITE` still deferred). *Tests:* `bank-access.test.ts`
(new: `FONT` bank exists at boot, sized 2048, `FONT-BASE` matches its
base), `sysvars.test.ts` (`listSysvars` now finds a real `FONT.FONT-BASE`
field, not an empty reserved group), `storage.test.ts` (`FONT` added to
the standard-bank round-trip-determinism check).

### 1.72 `LOAD`'s own stack-safety bug: a colon-definition split across block lines could `ABORT` (M60)

Found live, by Oliver, using the app directly: a `: HELLO ... ;` with
`DO`/`LOOP` written one clause per block line (via `T`) threw `? ABORT`
on `LOAD` — but the identical source typed as one interactive line
worked fine. `LOAD` (§1.4, `system.fth`) kept the block's base address
live on the *data* stack for its whole 16-line loop, re-`DUP`-ing it
each iteration:

```forth
: LOAD ( n -- )
  ...
  SWAP BLOCK
  L/SCR 0 DO
    DUP I C/L * + C/L (SET-INPUT)
    INTERPRET
  LOOP
  DROP ...
```

`DO`, `IMMEDIATE`, pushes its own backpatch address onto that *same*
data stack at compile time, popped only once its matching `LOOP` runs.
With `DO` on one block-line and `LOOP` on a later one, that pending
value was still sitting there when the next iteration's `DUP` ran —
dup-ing the wrong thing, computing a garbage line address, and feeding
`INTERPRET` unrelated arena memory as if it were Forth source (usually
non-text bytes, which fail `NUMBER`'s validation and hit `NUM-ABORT` —
explaining the reported symptom exactly: a big gap of invisible
characters, from `TYPE`-ing the bad token, before the printed `ABORT`).

**Isolated in a fresh `Machine`, not the live session, to avoid
touching in-progress work**: confirmed this was never actually specific
to `DO`/`LOOP` — a bare, unconsumed number split across two block
lines (`42` then `99`, no colon-definition at all) reproduced the
identical `ABORT`. Any interpreted line leaving *anything* on the data
stack corrupted the next iteration, `DO` was just the first construct
naturally likely to do that while spanning two lines.

**Fix:** two new variables, `LOAD-ADDR`/`LOAD-CONTEXT`, hold the block
address and the saved `CONTEXT` instead of leaving them live on the
data stack across arbitrary interpreted content — the same pattern
this file's own `R#`/`SCR`/`T-LINE`/`TEXT-LEN` scratch variables
already use for exactly this kind of loop-persistent state. `HIDE`n
immediately after `LOAD`, their only consumer, matching `NUM-ADDR`/
`NUM-LEN`/`NUM-ABORT`'s own precedent right after `NUMBER`. (The first
draft of this fix's own explanatory comment briefly reintroduced the
project's recurring nested-`(`-comment failure mode — see `LOAD`'s
inline comment itself, and M56/M57's own write-ups — caught immediately
since it broke `bootMachine()` for every single test in the suite, not
just `LOAD`'s own.)

*Implementation:* `system.fth` (`LOAD`, `LOAD-ADDR`, `LOAD-CONTEXT`).
*Tests:* `screen-editor.test.ts` — two new regressions: a `DO`/`LOOP`
colon-definition split across five block lines actually runs and
produces the right answer, and bare values on separate lines don't
corrupt a following `LOAD`.

### 1.73 `DUMP-NEXT`: an address-less `DUMP` pages forward (M61, Oliver's idea)

`DUMP` (§1.64) always needed an explicit address. Requested directly:
"store the next address to dump to a variable and use that if no
address is given on the stack" — classic-monitor "page forward" by
just typing `DUMP` again, no need to track or retype an address by
hand.

`DEPTH 0= IF DUMP-NEXT @ THEN` at the top decides which form was used
— any real cell value is a legitimate address, so there's no sentinel
to distinguish "no address" from "address 0" other than actually
checking how many things are on the stack. `DUP 128 + DUMP-NEXT !`
right after resolves and stores the *next* start address unconditionally,
before the existing 16-row body runs unchanged — so both forms
(explicit-address and bare) always leave `DUMP-NEXT` advanced by 128
for the following call, and the two compose naturally: dump a specific
spot once, then keep paging forward from there with bare `DUMP` calls.

**A real, accepted limitation, not a bug:** `DEPTH`-based detection
can't tell a deliberately-supplied address apart from an unrelated
value already on the stack if `DUMP` were ever called from inside
another definition with something else sitting underneath. Not a
concern for what `DUMP` actually is — an interactive top-level
inspection word, always typed directly, never a building block other
definitions call.

`DUMP-NEXT` is left as an ordinary, visible `VARIABLE` (not `HIDE`n
like `HEX8`'s own internal scratch words) — poking it directly to jump
elsewhere works exactly as well as giving `DUMP` an explicit address,
consistent with this project's "just memory, no hidden magic" sysvar/
scratch-variable philosophy elsewhere (`HERE`/`LATEST`/`STATE`, `SCR`,
`R#`).

*Implementation:* `system.fth` (`DUMP-NEXT`, `DUMP`). *Tests:*
`dump.test.ts` — five new cases: first bare `DUMP` starts at 0, an
explicit-address `DUMP` sets up a following bare one correctly, two
consecutive bare `DUMP`s page forward 128 bytes at a time, writing
`DUMP-NEXT` directly redirects the next bare `DUMP`, and the
address-less form is stack-neutral too.

### 1.74 Indexed color palette: `PAL`/`ATTR` banks, `PALETTE-BASE` (M62, `spec/01-HAL.md` §3.6, `spec/02-MEMORY-MODEL.md` §4.6)

`INK`/`PAPER` (§1.17) were always raw `0xRRGGBB` truecolor — this adds
an optional indexed mode sitting in front of that same value, resolving
the values a program was already passing, not a new HAL surface or a
new pair of primitives. Two new boot banks, created right alongside
`CHAR`:

- **`PAL`** — up to 16 selectable palettes, each 16 entries of
  `0xRRGGBB`, packed contiguously (map `N` at `PAL-base + N*64`). The
  engine (not a host asset, unlike `FONT`) writes the default 16-color
  palette into map slot 0 at boot — the same table `spec/02-MEMORY-MODEL.md`
  §4.6 specifies normatively.
- **`ATTR`** — `CHAR`'s per-cell attribute companion, same size and
  addressing stride. One byte per cell, `IIIIPPPP`: high nibble = ink
  index, low nibble = paper index.

**`PALETTE-BASE`** (new `SCREEN`-group sysvar, offset 36) is the one
switch everything keys off: `0` (the boot default, via the arena's own
zero-init — never explicitly set, same precedent as `CURSOR-VISIBLE`)
means disabled — `INK`/`PAPER` behave exactly as before, `ATTR` is
never written or read, and a `Machine` with a palette-unaware program
sees zero behavior change. Non-zero means "this is the active map's
address" — same address/0-disabled shape `FONT-BASE` already
established, not a palette *index*.

**The one resolution rule everything shares**
(`Screen.resolveColor()`): when `PALETTE-BASE` is non-zero and a color
value is `0..15`, the real color is the cell at `PALETTE-BASE +
value*4`; otherwise the value is used directly as a literal color. This
single rule governs both what `writeChar()` hands the HAL (always a
resolved `0xRRGGBB`, HAL unchanged) and how `ATTR` gets decoded back on
a redraw.

**Write-through** (`writeChar()`): while a palette is active, every
`CHAR`-bank write also packs the *raw* `ink`/`paper` values (not the
resolved ones) into that cell's `ATTR` byte, mechanically — a literal
color `>=16` truncates to its low nibble there, a named, accepted
limitation (below), not something guarded against. `cls()` fills `ATTR`
with the current ink/paper attribute the same way it fills `CHAR` with
spaces, so a freshly-cleared screen is attribute-consistent immediately.

**The redraw-path fix** (`redrawCursorAt()`, and therefore
`redrawAll()`): before this milestone, a redraw always reapplied
whatever `INK`/`PAPER` happened to be *right now*, never what a cell
was actually written with — a real, pre-existing gap named ahead of
time in the M25 note (§1.46) the day the cursor-inversion redraw hook
was added. While a palette is active, a redraw instead reads that
cell's own `ATTR` byte, decodes both nibbles, and resolves each through
the same rule above — both nibbles are always `0..15` by construction,
so they always hit the palette-lookup branch. Palette inactive: fully
unchanged, global-`INK`/`PAPER` behavior, `ATTR` untouched.

**Accepted limitation, not a bug:** a literal RGB `>=16` written while a
palette is active renders correctly that one time (the HAL still gets
the real, resolved color) but isn't `ATTR`-durable — a later redraw
(screen resize, `RESTORE`) reinterprets the truncated nibble as *some*
palette index, not the original literal. Named and accepted in
`spec/01-HAL.md` §3.6, not solved further here.

`PAL`/`ATTR` are ordinary boot banks — no `Storage`/`SAVE`/`RESTORE`
changes needed beyond registering their asset-file extensions
(`storage.ts`'s `TAG_TO_EXTENSION`: `ATR`/`PAL`), and they round-trip
like any other bank automatically.

*Implementation:* `screen.ts` (`resolveColor()`, `attrAddress()`,
`getPaletteBase()`/`setPaletteBase()`, and the `writeChar()`/`cls()`/
`redrawCursorAt()` changes above), `repl.ts` (`PAL`/`ATTR` bank
creation, `DEFAULT_PALETTE`), `rebel-opcodes.json` (`PALETTE-BASE`
field, `PAL`/`ATTR` bank-tag notes), `storage.ts`
(`TAG_TO_EXTENSION`). *Tests:* `screen.test.ts` (new "Indexed color
palette + ATTR bank" suite — default-disabled behavior, default
palette content, index resolution, the literal-color passthrough,
`ATTR` write-through and its green-on-black `0x40` worked example,
`ATTR` staying inert while disabled, the `redrawAll()`/`CURSEN` redraw
fix, `cls()`'s `ATTR` fill), `project.test.ts` (`PAL`/`ATTR`
`SAVE`/`RESTORE` round-trip).

**M62 follow-up, Oliver's request:** `PALETTE-BASE`, a plain `system.fth`
word (BOOTSTRAP, *not* a native primitive) — `: PALETTE-BASE BANK@ SYSV
100 + ;`, pushing the `SCREEN.PALETTE-BASE` sysvar cell's own address
(100 = `SCREEN`'s `baseOffset` 64 + the field's own offset 36, hand-kept
in sync with `rebel-opcodes.json` the same way `BANKS`'s `MMAP-*`
constants already are), so it's a real read/write variable —
`PALETTE-BASE @` reads it, `addr PALETTE-BASE !` writes it (e.g. `BANK@
PAL PALETTE-BASE !` enables the default palette in one line).
Deliberately *not* a native primitive: unlike `BASE`/`STATE`/
`HERE-ADDR`/`LATEST-ADDR`, which exist natively because something has
to bootstrap that very mechanism (self-hosted `INTERPRET`,
`VARIABLE`/`CONSTANT`, …) before it's available, `PALETTE-BASE` is
just an ordinary *user* of an already-existing one — `BANK@`'s own note
already describes exactly this "`BANK@ SYSV <offset> + @` reaches any
sysvar from pure Forth source" pattern, so a native primitive would
have spent a token ID on something Forth source already does natively.
First implemented as a native primitive (token 147) and corrected
same-session once this was pointed out.

**M62 follow-up 2, same request:** `PALETTE ( n -- )` — `: PALETTE
64 * BANK@ PAL + PALETTE-BASE ! ;`, selecting `PAL`'s `n`'th map as the
active palette in one word instead of writing the `n 64 * BANK@ PAL +
PALETTE-BASE !` arithmetic out by hand each time. `0 PALETTE` needs no
special-casing — map 0 already sits at `PAL`'s own base address.
Disabling the palette entirely still needs no dedicated word either:
`0 PALETTE-BASE !` already does it directly, per `PALETTE-BASE`'s own
0-means-disabled convention (the user's own point in requesting
`PALETTE`: "no reset to 0 needed, this can be done via the sysvar") —
so `PALETTE` only ever has to handle picking a real map. No bounds
check on `n`, same trust-the-caller convention `AT-XY` already uses —
an out-of-range `n` lands somewhere else inside `PAL`'s own allocated
bank, not memory-unsafe, just a meaningless palette until corrected.
This is a genuine BOOTSTRAP word, same reasoning as `PALETTE-BASE`
above — not a native primitive. *Implementation:* `system.fth`.
*Tests:* `screen.test.ts` (via `bootMachine()`, since both `PALETTE-BASE`
and `PALETTE` are `system.fth` words, not engine primitives).

**M62 follow-up 3, Oliver's request:** the default palette map is active
*from boot*, not opt-in — `repl.ts`'s `Machine` constructor now sets
`PALETTE-BASE` to the `PAL` bank's base right after writing the default
map, instead of leaving it `0`. `DEFAULT_INK`/`DEFAULT_PAPER` changed
from literal `0x00ff00`/`0x000000` to the matching palette indices `4`/
`0` — same rendered green-on-black, just resolved through the palette
from the start. Also fixed a latent bug found while touching `cls()`:
`hal.clearScreen(paper)` was passing the *raw* `PAPER` sysvar value
straight through instead of resolving it via `resolveColor()` first —
harmless while the palette defaulted to disabled, a real bug once it's
on by default (or with any custom map remapping index 0).

Enabling it by default then surfaced a second, more serious bug, found
live rather than by inspection: with a palette active and `CURSEN` on,
a literal RGB ink (e.g. `HEX FFFFFF INK`) rendered correctly for one
frame, then got silently replaced by an unrelated palette color on the
very next keystroke. Cause: `setCursor()`'s "un-invert the vacated
cursor cell" housekeeping unconditionally redraws that cell from its
`ATTR` byte whenever a palette is active — but `advanceCursor()`
(`EMIT`'s only caller of it) calls this on the exact cell `writeChar()`
just painted with the real, correct colors a moment earlier. `ATTR` only
has 4 bits per channel, so a literal RGB value's low nibble gets reread
back through the palette as if it were a genuine index — not the
accepted "resize/restore" gap `spec/01-HAL.md` §3.6 already documents,
but every ordinary keystroke. Fixed by giving `setCursor()` a
`redrawOldCell` flag, defaulting to `true` for every caller except
`advanceCursor()`, which already knows that cell is correctly on-screen
and skips the redundant/wrong redraw; `AT-XY` and `EMIT`'s `\r`/`\n`
still un-invert normally, since they move the cursor without writing
first. One pre-existing test (`screen.test.ts`, "typing a character at
the cursor draws it normally, not inverted") had explicitly documented
the old double-blit as a harmless quirk; updated to match the fixed
(single-blit) behavior. *Implementation:* `repl.ts`, `screen.ts`.
*Tests:* `screen.test.ts`.

**M62 follow-up 4, Oliver's request:** `spec/01-HAL.md` §3.6,
`spec/02-MEMORY-MODEL.md` §4.6, and `spec/03-SYSVARS.md` §6 updated to
make the `PAL`/`ATTR` banks and the `PALETTE-BASE` field **REQUIRED**
for every display-capable target, not OPTIONAL as originally specified
— resolving §3.6's own previously-open question about whether its
conformance checklist should gain rows for this. Rationale spelled out
in `01-HAL.md` §3.6: `PAL`/`ATTR` are a pure software indirection layer
in front of the same `hal_blit_glyph`/`hal_clear_screen` calls every
target already implements — nothing about them depends on the
underlying display's own color model, unlike `CURSOR-VISIBLE` (§3.5) or
`hal_draw_*` (§3.4), which are genuinely conditional on target
capability. This does not mandate that `PALETTE-BASE` default to
non-zero at boot on every target — that boot-time choice stays
target-specific (Rebel-Sim's own choice is M62 follow-up 3, above); what's
now required is that the mechanism exists and behaves per spec once
enabled. *Implementation:* `spec/01-HAL.md`, `spec/02-MEMORY-MODEL.md`,
`spec/03-SYSVARS.md` only — no engine code changed (Rebel-Sim already
conformed).

### 1.75 `MMAP`'s header grows again: `Personality` (M63, Oliver's idea)

Motivated by two things converging: wanting to test `REMOTE-TERMINAL.md`'s
wire protocol (a "board" role Machine driven against a "terminal" role,
in software, before the real RP2350 exists) without Rebel-Sim's own
hardcoded 80×60 screen geometry getting in the way, and a general want
for describing "what kind of machine is this" — headless vs. display,
screen geometry — cross-target, in a fixed, structured place rather
than as Rebel-Sim-local constants. Oliver's specific direction: not a
generic or dynamic config format — a few fixed fields in the one place
that's already the arena's early, spec-level (`spec/02-MEMORY-MODEL.md`
§5) source of truth for layout, read before any other bank exists, and
already round-tripping through ordinary project save/restore for free.

`MMAP`'s header grows a second time (§1.48/M27 grew it 4→16;
this grows it 16→28): a new `Personality` (`mmap.ts`) — `PERSONALITY`
(a flags cell, only `PersonalityFlagHeadless` = bit 0 defined so far),
`SCREEN-COLS`, `SCREEN-ROWS`. `initHeader(personality = DEFAULT_PERSONALITY)`
writes it; `getPersonality()` reads it back. `DEFAULT_PERSONALITY`
(`{ headless: false, screenCols: 80, screenRows: 60 }`) reproduces
today's hardcoded boot geometry exactly, so a caller that never touches
this option sees no behavior change at all. `BankTable`'s constructor
takes an optional `personality` and forwards it straight to
`initHeader()`; `Machine`'s constructor (`repl.ts`) reads it back via
`this.banks.mmap.getPersonality()` immediately after constructing
`BankTable`, and uses `screenCols`/`screenRows` (no longer the removed
`DEFAULT_SCREEN_WIDTH`/`DEFAULT_SCREEN_HEIGHT` constants) to size
`CHAR`/`ATTR` and set the `SCREEN` sysvar group — cell size itself stays
the fixed `DEFAULT_CHAR_CELL_W/H` constants, not personality-driven,
matching `REMOTE-TERMINAL.md` §5's existing "not negotiated in v1"
decision for cell pixel size.

**Deliberately not done in this pass, named rather than silently
skipped:** `headless` is stored and read back but doesn't change
anything else yet — `Machine` still always constructs `CHAR`/`ATTR`/
`PAL`/`KMAP` and `Screen`/`Keyboard` regardless of the flag. Actually
gating those on `headless` is real follow-on work (several `Machine`
fields are non-optional today, and `inner.ts`/`primitives.ts` assume
`screen`/`keyboard` exist) — confirmed with Oliver as out of scope for
this change. `HEADER_VERSION` bumped 1→2 alongside this (write-only,
never read/validated anywhere in this codebase, so free to bump without
a migration path — no real saved project exists yet to break).
`spec/02-MEMORY-MODEL.md` §5.1/§5.3/§5.4 updated to match (28-byte
header, 1564-byte raw requirement at the default 64 slots — still
rounds to the same `MIN_BANK_SIZE` class, no other bank's base moves).
*Implementation:* `mmap.ts`, `banks.ts`, `repl.ts`, `mmap.test.ts`,
`spec/02-MEMORY-MODEL.md`.

### 1.76 `REMOTE-TERMINAL.md`'s wire protocol + a software loopback harness (M64)

Oliver's idea: validate `REMOTE-TERMINAL.md`'s wire protocol design before
the real RP2350 firmware exists, by implementing both roles in software
and connecting them over an in-memory transport instead of real
`navigator.serial`. Scope confirmed with Oliver: protocol + harness only,
zero `packages/app` changes — the real `navigator.serial`/UI wiring (§7)
is separate, deferred follow-on work.

Three new, purely-additive files, no existing file touched except docs:
`remote-terminal-protocol.ts` (the wire format, §3/§4 — `SYNC`/message-ID
constants, per-message `encodeXxx`/`decodeXxx` pairs over a `DataView`
with `littleEndian: true` at every call, and `FrameDecoder`, the §6 resync
state machine: buffers arbitrary chunk boundaries, and on a checksum
mismatch discards only the one leading `SYNC` byte before resuming — never
the whole candidate frame — so a false-positive `0xA5` inside garbage
can't get the reader stuck); `remote-board.ts` (the "board" role, §8:
`BoardScreenHal implements ScreenHal` serializes every `blitGlyph`/
`clearScreen` call to the wire instead of drawing, and `RemoteBoard` wraps
a real `Machine` built with `MachineOptions.screenHal`/`personality` — no
engine changes needed there, both options already existed); `remote-terminal.ts`
(the "terminal" role, §7, deliberately scoped down: a shadow
`{charCode, ink, paper}` grid decoded from incoming frames, no `Machine`/
`Arena`/`FONT` bank and no real pixel rendering — that infrastructure only
matters once real `CanvasScreenHal` wiring happens later, and a shadow
grid is sufficient to prove the wire decodes correctly without it).

A real reentrancy bug surfaced and got fixed during this session, not
just planned around: `RemoteBoard` originally sent `HELLO` from inside its
own constructor (per §8 step 1, "before anything else touches the wire").
In the loopback harness, the terminal's synchronous `HELLO_ACK` reply
tried to call back into a `board` variable that wasn't assigned yet (still
mid-construction) — a real chicken-and-egg problem with any fully
synchronous two-role harness, not specific to this protocol. Fixed by
splitting `HELLO`-sending into an explicit `start()` method, called by the
harness only once both roles are fully constructed and reachable. Traced
through carefully before accepting the fix: `Machine`'s own
constructor already runs `Screen.cls()` unconditionally during boot
(ordinary `repl.ts` behavior, unrelated to remote-terminal mode), so a
`CLEAR` frame now lands on the terminal *before* `start()`'s `HELLO` goes
out — confirmed harmless, since `RemoteTerminal` ignores `PLOT_CHAR`/
`CLEAR` until its own `HELLO` handling has actually sized the shadow grid
(zero-length `Array.fill()` is a no-op). Documented explicitly in
`remote-board.ts`'s own doc comment as a named Rebel-Sim-`Machine`-reuse
simplification specific to this harness — real RP2350 firmware, written
fresh for this mode, can and should satisfy §8's literal "`HELLO` first"
ordering directly.

Message-ID table stays hand-coded constants, not a JSON source of truth —
§9 itself defers real cross-language codegen until `FORTH-ARCHITECTURE.md`
§0's own generator exists; building one just for this fixed 6-message
table now would be ahead of any real need (no second, independent
consumer exists yet — the RP2350 firmware project doesn't exist).
`REMOTE-TERMINAL.md` §0 updated with a status note recording exactly
what's now implemented vs. still design-only, so its own framing doesn't
go stale now that half of it has real code. *Implementation:*
`remote-terminal-protocol.ts`, `remote-board.ts`, `remote-terminal.ts`,
`remote-terminal-protocol.test.ts`, `remote-terminal-loopback.test.ts`,
`REMOTE-TERMINAL.md`.

### 1.77 `TERMINAL`: a hands-on connection to a simulated board (M65, Oliver's idea)

Wires §1.76's protocol/harness into the actual running app: `TERMINAL`
(rebel-opcodes.json 147) is a new portable HAL-level primitive, confirmed
with Oliver as genuinely cross-target from the start (like `hal_emit`) —
Rebel-Sim's own implementation connects to an in-process simulated board;
real targets are expected to implement it later via their own transport
(serial/USB/TCP) to an actual attached board. Follows `COLD`/`RESTORE`'s
exact existing host-signal plumbing: `inner.ts`'s `dispatch()` special-
cases the token (a new `TERMINAL_TOKEN`, resolved the same way
`COLD_TOKEN`/`RESTORE_TOKEN` are) before `executePrimitive` ever runs, and
yields a new `'terminal'` `StepSignal`/`StepStatus` with no payload — never
reaches `primitives.ts`'s switch.

`packages/app/src/app/app.ts` handling: `connectToRemote()` builds a
`RemoteBoard`+`RemoteTerminal` pair the first time (persisting across a
later disconnect, per Oliver's call) — reusing the app's own already-
attached `canvasScreenHal` as the terminal's render target rather than a
separate `Arena`/`FONT` bank (§7's own suggestion, unnecessary here since a
live local `Machine` with a real font already exists), and calling
`Screen.redrawAll()` on both connect (repaints the board's actual content,
essential on a reconnect) and Ctrl+Escape disconnect (restores the local
machine's own content on the shared canvas). `tick()` branches to a new,
much smaller `tickRemote()` while connected — the local machine is simply
never `step()`-ped during that time (freezing needs no separate mechanism,
it falls out of the branch), so local/board output can't interleave on
the shared canvas. `handleKeyEvent` reroutes real keyboard input to
`RemoteTerminal.sendKeyEvent()` instead of `machine.keyboard.pushRawEvent()`
while connected; Ctrl+Escape (the classic telnet/SSH escape convention) is
the disconnect chord, alongside the existing Ctrl+`` ` ``/Ctrl+`\` monitor
toggle.

**A real, non-obvious bug found and fixed while wiring this up:** the
`'terminal'` status branch (and `tickRemote()`'s own `'cold'`/`'restart-
project'` re-connect branch) initially didn't reset `this.pumping` before
their own async call — since that `tick()` invocation ends its RAF chain
right there with no trailing `requestAnimationFrame`, leaving `pumping`
stuck at its stale `true` meant every later `wake()` call (from
`connectToRemote()` itself, and from every subsequent keystroke) saw "a
chain is already scheduled" and silently no-opped, permanently starving
the pump — connecting appeared to succeed (`connectedToRemote` flips true,
keyboard events still reached the board fine, since `sendKeyEvent()` is
synchronous and RAF-independent) but nothing was ever actually *stepped*
again afterward. Found via a failing `app.spec.ts` test, isolated with
`it.only` and temporary diagnostics rather than guessed at blind. Fixed by
resetting `this.pumping = false` before each async call, mirroring how
`resetUiSnapshotsForReboot()` already does this for local `COLD`/`RESTORE`.

`RemoteTerminal` (`remote-terminal.ts`) gains an optional 4th constructor
param, `hal?: ScreenHal` — `PLOT_CHAR`/`CLEAR` now call it (`blitGlyph`/
`clearScreen`) in addition to updating the shadow grid. No cursor-specific
logic needed: `BoardScreenHal` only ever forwards plain `blitGlyph`/
`clearScreen` calls (this codebase has no separate cursor HAL primitive
anywhere), so the board's own `Screen` already produces correctly
pre-inverted `PLOT_CHAR` frames whenever it shows a cursor.

Real hands-on verification (not just automated tests): started the dev
server and typed `TERMINAL` in a live browser, confirmed the board's own
boot banner/prompt appear on the same canvas, typed a line, Ctrl+Escape
back to local, reconnected and confirmed the board's session resumed
rather than rebooting. *Implementation:* `rebel-opcodes.json`, `inner.ts`,
`repl.ts`, `primitives.ts`, `remote-terminal.ts`, `index.ts`, `app.ts`,
`app.spec.ts`, `terminal.test.ts`, `remote-terminal-loopback.test.ts`,
`REMOTE-TERMINAL.md`.

### 1.78 `Personality` gains `INK`/`PAPER`: a visual cue on `TERMINAL` connect (M66, Oliver's idea)

Small follow-up to §1.75/§1.77: `MMAP`'s header grows a third time
(16→28→**36** bytes) with two more `Personality` fields, `INK`/`PAPER` —
the boot-time `SCREEN.INK`/`SCREEN.PAPER` sysvar values, same
palette-index-or-literal-RGB convention those sysvars already use (M62).
Motivation stated directly: a `TERMINAL`-connected board booting into a
deliberately different color scheme than local's green-on-black is a
cheap, immediate, unmissable visual signal of "you're on a different
machine now" — before any text says so, and still true even if a user
misses the board's own boot banner.

`DEFAULT_PERSONALITY` gains `ink: 4, paper: 0` — the exact values
`repl.ts`'s own now-removed `DEFAULT_INK`/`DEFAULT_PAPER` constants held,
so a default-personality boot's colors are unchanged. `repl.ts`'s
`Machine` constructor now sources `SCREEN.INK`/`.PAPER` from
`personality.ink`/`.paper` instead of those hardcoded constants.
`app.ts`'s `connectToRemote()` passes the board a personality of `ink: 6,
paper: 1` — palette indices 6 (yellow) and 1 (blue) in `DEFAULT_PALETTE`
(`repl.ts`) — Oliver's specific request, verified live: connecting via
`TERMINAL` now visibly repaints the canvas yellow-on-blue immediately
(the board's own boot `CLS`), and Ctrl+Escape's `Screen.redrawAll()`
snaps it straight back to local's green-on-black.

Same header-growth discipline as §1.75/§1.77's prior two rounds:
`HEADER_VERSION` bumped 2→3 (still write-only/unenforced, free to bump);
`spec/02-MEMORY-MODEL.md` §5.1/§5.3/§5.4 updated to match (36-byte
header, 1572-byte raw requirement at the default 64 slots); and —
learned from §1.75's own hidden-bug discovery — `system.fth`'s `BANKS`
word's `MMAP-HDR` constant (`packages/app/public/`, outside the
TS-only grep that missed it the first time) updated 28→36 alongside the
TS-side change, not after. *Implementation:* `mmap.ts`, `repl.ts`,
`app.ts`, `mmap.test.ts`, `spec/02-MEMORY-MODEL.md`, `system.fth`.

### 1.79 `BANK-SIZE` becomes `IMMEDIATE`, dual-mode — same fix as §1.65's `BANK@` (M67)

Found by Oliver trying `: FOO BANK-SIZE SYSV ;` — it aborted at compile
time with `unrecognized word: SYSV`, the identical failure §1.65
diagnosed for `BANK@`, and for the identical reason: `BANK-SIZE` (144)
was a plain, non-`IMMEDIATE` primitive, so `interpretCompiling`
compiled a call to it and moved straight on to its own next token
(`SYSV`), trying to look that up as an ordinary word right there at
compile time — long before `FOO` itself could ever run and give
`BANK-SIZE`'s own `nextInputToken()` call a chance to consume it.

`BANK-SIZE` was added (M50, §1.62) as `BANK@`'s read-only counterpart
and has shared its parsed-word/name-lookup mechanics ever since, but
M53's `IMMEDIATE` fix was applied only to `BANK@` at the time — nobody
had tried compiling `BANK-SIZE` into a definition yet, so the identical
latent bug in its own dispatch case went unnoticed until now.

**Fix: identical to `BANK@`'s (case 99), applied to `BANK-SIZE` (case
144)** — `IMMEDIATE`, dual-mode on `STATE`, baking in a resolved `LIT`
value (the bank's `size` rather than its `base`):

```ts
const name = ctx.nextInputToken().toUpperCase();
const bank = ctx.banks.findBankByName(name);
if (bank === undefined) {
  throw new Error(`unknown bank: ${name}`);
}
if (ctx.sysvars.getState() === -1) {
  compileCell(ctx, findWord(ctx, 'LIT')!.cfa);
  compileCell(ctx, bank.size);
} else {
  s.push(bank.size);
}
```

Same tradeoff as `BANK@`'s, stated up front rather than rediscovered:
the size gets baked in once, at the *defining* line's own compile time
— correct for any bank already created and stable when the word
compiling it is defined, stale if that bank is later resized
(`BANK-RESIZE`, §1.66) or dropped and recreated afterward. Interactive
use (`BANK-SIZE SYSV`, `BANKS`' own internals) is observably identical
either way — only the compiled-into-a-definition case changes, from
"doesn't work" to "works."

*Implementation:* `primitives.ts` (case 144), `rebel-opcodes.json`
(token 144's `immediate` flag + note). *Spec:* `02-MEMORY-MODEL.md`
§4.7 (the `IMMEDIATE`/dual-mode requirement now stated for both
`BANK@` and `BANK-SIZE`), `04-FORTH-CORE.md` §5.3 (`BANK-SIZE` added
alongside `BANK@` to the "baked into the definition" list). *Tests:*
`bank-access.test.ts`'s new "`BANK-SIZE` compiled into a definition"
suite, mirroring `BANK@`'s M53 suite.

### 1.80 `GRAPHICS` vocabulary: `PLOT`/`POINT` primitives, LINE/RECT/CIRCLE in pure Forth (M68)

Two new primitives, `PLOT` (148, `x y --`) and `POINT` (149, `x y --
color`) — the classic Sinclair-BASIC-style pixel pair, and the only new
native surface this needed. `PLOT` calls `Screen.plot()`
(`screen.ts`), which resolves the current `INK` sysvar through the
active palette exactly like `writeChar` does before calling
`ScreenHal.drawPixel` (spec `01-HAL.md` §3.4's `hal_draw_pixel`) — this
turned out not to be optional: M62 boots with the default palette
already active, so the raw `INK` sysvar value at boot is the palette
*index* `4`, not literal green, and skipping resolution made a
default-configuration `PLOT` draw near-black pixels the first time it
was tried. `POINT` is the read-side counterpart (`ScreenHal.
readPixel`, spec's new `hal_read_pixel`, added alongside
`hal_draw_pixel` in this same pass); out-of-range coordinates return
`-1` for both `Screen.point()` and `PLOT`'s own silent no-op, mirroring
`CHAR@`'s out-of-range space convention with a sentinel no real
`0xRRGGBB` value can produce. Both are bounds-checked against
`SCREEN-WIDTH`/`SCREEN-HEIGHT` (pixel space), a new `Screen.
pixelWidth`/`pixelHeight` pair cached at construction the same way
`cols`/`rows` already are, not the character-cell grid.

Everything else — `LINE` (Bresenham, plus a `LINE-WIDTH`-driven
dominant-axis offset for a cheap thick-stroke approximation), `RECT`/
`RECT-FILL`, and `CIRCLE`/`CIRCLE-FILL` (the classic midpoint circle
algorithm — pure integer, no `SQRT` or trigonometry anywhere) — is pure
Forth in a new `GRAPHICS` vocabulary (`system.fth`, branching off
`FORTH` right after the `EDITOR` section closes, same `VOCABULARY`/
`DEFINITIONS` idiom `EDITOR` itself uses), per `CLAUDE.md`'s "primitives
only if absolutely necessary" rule. `ARC` and a `MATH` vocabulary
(needed for testing whether a point falls inside an angular range, not
for `CIRCLE` itself) are deliberately not built in this pass — named as
follow-up work in `system.fth`'s own `GRAPHICS` section comment, not
designed here.

One sharp edge worth recording since it cost real debugging time: this
codebase's `(` comment word consumes input up to the next *token that
merely ends in* `)`, not up to a standalone `)` token (`consumeQuotedText`,
`primitives.ts`). A comment referencing something like "token 148" as
`(148)` — a nested, unspaced parenthetical aside — closes the comment
early and dumps the rest of the sentence into the dictionary as live
code; the first draft of `system.fth`'s `GRAPHICS` section did exactly
this and broke `bootMachine()` for every test in the suite with a `DSTK
stack underflow` (the leaked word `AND` executing against an empty
stack), traced by interpreting `system.fth` one line at a time until the
exact line surfaced. Every comment in `GRAPHICS` was rewritten
paren-free to avoid it, and the section's own opening comment now
documents the hazard for the next person adding one.

Second, smaller effect: `GRAPHICS` adds roughly 34 dictionary entries
(`LINE`/`RECT`/`CIRCLE` and their internal state `VARIABLE`s), and
every one of their own word references pays the self-hosted
`INTERPRET`'s usual O(dictionary-size) `FIND` chain-walk against a now-
larger dictionary — the same cost model `vitest.config.ts`'s own
comment already names. Several `EDITOR`-vocabulary tests (a separate,
unrelated vocabulary branching the same way) started tripping the
existing 20s `testTimeout` ceiling under full-suite parallel
contention. Fixed the same way M48 already fixed the identical problem
once before: doubled `testTimeout` to 40s, not a per-test workaround.

*Implementation:* `screen.ts` (`ScreenHal.drawPixel`/`readPixel`,
`Screen.plot`/`point`, `pixelWidth`/`pixelHeight`), `primitives.ts`
(cases 148/149), `rebel-opcodes.json` (tokens 148/149),
`canvas-screen-hal.ts` (real `drawPixel`/`readPixel` via
`fillRect`/`getImageData`), `remote-board.ts` (`BoardScreenHal` gains
no-op `drawPixel`/`readPixel` stubs — `REMOTE-TERMINAL.md`'s wire
protocol has no raw-pixel message yet, §10 item 3), `system.fth` (the
new `GRAPHICS` vocabulary). *Spec:* `01-HAL.md` §3.4 (`hal_read_pixel`
added alongside `hal_draw_pixel`, both named as independently optional)
and its §11 conformance table. *Tests:* `screen.test.ts`'s new
"PLOT/POINT" suite (bounds-checking, palette resolution, HAL
forwarding), `graphics.test.ts` (new — `LINE`/`RECT`/`CIRCLE` and their
width/fill variants, exercised by loading real `system.fth` source via
`bootMachine()`).

### 1.81 `\` — rest-of-line comment, closing spec §9's own open item (M69)

Direct follow-up to §1.80's own postscript: writing `GRAPHICS`'s ~90-line
opening comment hit the `(`-comment-closes-early footgun (§1.80, M46,
M48) for a *fourth* time, from a nested `(148)`-style aside — the third
recurrence of the identical mistake in this codebase's history. Rather
than fix it a fourth time and wait for a fifth, Oliver asked for `\`
(rest-of-line comment) — previously named but explicitly deferred in
`spec/04-FORTH-CORE.md` §9 ("not specified here either... added only if
a real need surfaces") — to be built for real and added to that same
spec, closing the open item with the evidence that surfaced it.

**Needed no new primitive.** `WORD` (§6.13, native, token 134) already
returns a zero length as its own specified "line exhausted" signal
(`wordScan()`, `repl.ts`) — looping it with `BL` as the delimiter until
that happens consumes exactly the rest of the current line, discarding
each token, with no closing-token concept to glue an aside onto at all:

```forth
: \ BEGIN BL WORD NIP 0= UNTIL ; IMMEDIATE
```

`IMMEDIATE` for the same reason `(` carries it — a `\` comment written
inside another colon-definition must discard its text at that
definition's own compile time, not whenever the definition later runs.
Defined early in `system.fth` (right after `NIP`, its last real
dependency beyond `BEGIN`/`UNTIL`/`WORD`/`BL`, all already available by
then), so it's usable everywhere from that point on, including inside
its own explanatory comment.

**A real near-miss while writing that comment.** The first draft of
`\`'s own doc comment — explaining the exact bug `\` exists to avoid —
itself used stray parens (`the ( -- ) comment above`, `6.13)`,
`needs)`) and broke the same way `GRAPHICS`'s had, caught by running the
same token-stream simulation used to debug §1.80 before ever booting a
`Machine`. Rewritten paren-free like everything else in this file's
comments now has to be.

*Implementation:* `system.fth` (new `\` definition, Batch 4). *Spec:*
`04-FORTH-CORE.md` §6.7 (new `\` row, BOOTSTRAP) and §9 (the old
"not specified here either" bullet marked resolved, pointing at §6.7).
*Tests:* `comments.test.ts`'s new `\` suite (end-of-line discard
including embedded parens, `IMMEDIATE` inside a colon-definition, a
bare `\` as a no-op, and that it never spans past its own line).

### 1.82 `SEE`/`HIDE` fixed to resolve names through `CONTEXT`, not raw `LATEST` (M70)

Found by Oliver, using the machine: `SEE`/`HIDE` worked on a word in
`EDITOR` once `EDITOR DEFINITIONS` had run, but threw `unrecognized
word` on the identical word after only `USE EDITOR` — merely browsing
it. Root cause, confirmed directly against both code paths: `SEE`/
`HIDE` (M12, before vocabularies existed at all) resolve their target
name via the native `'` primitive (token 94), which finds a word
through the engine's own `findWord()` (`dictionary.ts`) — a walk rooted
at the raw `LATEST` sysvar, i.e. whatever `CURRENT-VOCAB` currently is.
Every *other* dictionary search — ordinary word dispatch, `WORDS` — goes
through the self-hosted, `CONTEXT`-aware `FIND` (`system.fth`) instead,
added at M48 specifically so browsing (`CONTEXT`) and compiling
(`CURRENT-VOCAB`/`LATEST`) could be independent. `'` was never updated
for that split — it predates `VOCABULARY` (M13) entirely, and the
original single-pointer `USE` (superseded at M48) happened to keep `'`
working by moving `LATEST` on every `USE`, which masked the gap until
M48's revision decoupled the two for real.

**Fix, entirely in `system.fth`, no engine change:**

1. **`FIND` relocated** from deep in the self-hosted-interpreter section
   (just above `NUMBER`) to right after `WORDS`, near the top of the
   file — moved, not rewritten. Its only real dependencies (`CONTEXT`/
   `CURRENT-VOCAB`, declared just above `WORDS`, plus ordinary Batch
   1-4 words) were already available that early; only `HIDE FIND-ADDR`/
   `HIDE FIND-LEN`, which used to follow it immediately, couldn't come
   along, since `HIDE` doesn't exist yet at that point — they now run
   in the same cleanup batch as `HIDE XT-NAME` etc., after `HIDE`
   itself is defined.
2. **`SEARCH-ROOT` extracted** as its own new word — the one-line rule
   `WORDS` and `FIND` already each inline (`CONTEXT @ CURRENT-VOCAB @ =
   IF LATEST ELSE CONTEXT @ @ THEN`) — specifically so the two *new*
   consumers below could share it instead of a fourth copy. `WORDS`/
   `FIND` themselves were left untouched, still using their own inline
   copies: they already work, and three near-identical one-liners is
   the ordinary case `CLAUDE.md`'s own "premature abstraction" warning
   is about, not a defect to clean up in passing.
3. **`(TICK)`, a new internal word** (`"name" -- xt`), replacing `SEE`/
   `HIDE`'s own call to native `'`: `BL WORD 2DUP FIND IF NIP NIP >CFA
   ELSE DROP TYPE SPACE ABORT THEN`. Errors via the same "print the bad
   token, then `ABORT`" convention `NUMBER`'s own fallback already
   uses, rather than reproducing `'`'s distinct "unrecognized word:
   NAME" wording.
4. **`XT-NAME`'s and `HIDE`'s own internal xt-to-entry walks**, both
   previously rooted at raw `LATEST` directly (not just the initial
   name lookup), switched to start from `SEARCH-ROOT` instead — fixing
   `SEE`'s ability to print a called word's real name (`XT-NAME`) and
   `HIDE`'s ability to actually locate and flag the target entry
   (`HIDE`'s own chain-walk), both for the identical "merely browsing"
   scenario, not just the front-door name parse.

`(TICK)`/`SEARCH-ROOT`/`FIND-ADDR`/`FIND-LEN` all join the existing
`HIDE XT-NAME`/`HIDE LIT-XT`/... cleanup batch once nothing later needs
to find them by name — `FIND` itself stays visible, since the
self-hosted `INTERPRET` (defined much later) still needs to find it by
name at its own compile time.

*Implementation:* `system.fth` (`FIND` relocated; new `SEARCH-ROOT`/
`(TICK)`; `XT-NAME`/`SEE`/`HIDE` updated). *Tests:* new
`see-hide.test.ts` (ordinary-word decompile/hide, the unrecognized-word
error path, and the exact `USE`-without-`DEFINITIONS` regression for
both `SEE` and `HIDE`, plus a same-vocabulary-after-`DEFINITIONS`
non-regression check).

### 1.83 `INK`/`PAPER` become real variables, not color-consuming stores (M71, breaking change — Oliver's call, pre-1.0)

Oliver's ask, for consistency: sysvars should read/write like ordinary
`VARIABLE`s wherever possible, the same way `BASE`/`STATE`/`HERE-ADDR`/
`LATEST-ADDR` already do (`fieldOffset()`'s own doc comment in
`sysvars.ts` flagged this as the intended general pattern back at M24).
`INK`/`PAPER` were the one pair of primitives still using the older,
inconsistent shape: `n INK` popped a color and stored it directly,
with no way to read the current value back at all. Changed both to
push their sysvar cell's arena address instead — `n INK !` to set,
`INK @` to read — identical to `BASE`/`STATE`. Accepted as a breaking
change: nothing outside this repo depends on the old calling
convention yet.

*Implementation:* `primitives.ts` (tokens 27/28 now push
`ctx.sysvars.fieldOffset('SCREEN', 'INK'/'PAPER')` instead of calling
`Screen.setInk`/`setPaper`, which had no other callers and were
deleted). `rebel-opcodes.json`'s notes for both tokens updated.
`system.fth`'s `GRAPHICS` intro comment (M68, §1.80) updated to match.
*Tests:* every `n INK`/`n PAPER` call site across `screen.test.ts`,
`project.test.ts`, `remote-terminal-loopback.test.ts` updated to `n
INK !`/`n PAPER !` — `Sysvars.get`/`.set` call sites in `mmap.test.ts`/
`empty.test.ts` reach the sysvar directly and needed no change.

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
| `.` | Found (a primitive, not `DOCOL`) → dispatches directly: pops 25, formats it in the current `BASE`, streams each character through `screen.emit()` — writing it into the `CHAR` bank at the cursor and blitting it via the `ScreenHal` (§1.16-§1.17). | `[]`, screen row 0: `"25 "` |

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
| **CHAR bank** | Arena bank holding one character code per screen cell (1 byte each). Never stores color — only the code. |
| **Framebuffer / `SCRN`** | The actual pixels. Not arena memory — owned by the host side of the HAL boundary (a `<canvas>` in Rebel-Sim), excluded from the portable-dump claim. |
| **HAL** | Hardware Abstraction Layer — the boundary where the engine defines an interface for something host-specific (drawing pixels) and the host supplies the implementation. |
| **`ScreenHal`** | Rebel-Sim's HAL interface for screen drawing: `blitGlyph`/`clearScreen`. Defaults to a no-op (`NULL_SCREEN_HAL`) so engine tests don't need a real canvas. |
| **Glyph** | One character's bitmap — a small fixed-size grid of on/off pixels, looked up by character code, never computed at render time. |
| **Ink / Paper** | Foreground / background color for a character write. Raw 24-bit truecolor by default; resolved through the active palette instead when `PALETTE-BASE` is non-zero and the value is 0-15 (§1.74). |
| **`PAL` bank** | Arena bank holding up to 16 selectable 16-entry `0xRRGGBB` palettes (64 bytes each), map slot 0 normatively the default 16-color palette (§1.74). |
| **`ATTR` bank** | `CHAR`'s per-cell attribute companion — one `IIIIPPPP` byte per cell (ink index, paper index), sized/addressed identically to `CHAR`. Written only while a palette is active; inert otherwise (§1.74). |
| **`PALETTE-BASE`** | `SCREEN`-group sysvar, **REQUIRED** on every display-capable target (`spec/01-HAL.md` §3.6): address of the active `PAL` map, `0` = disabled (literal-RGB-only). Same address/0-disabled *value* shape as `FONT-BASE`, but unlike that field not itself conditional on target capability (§1.74). |
| **Blit** | Copying a bitmap's pixels onto a destination (here: a glyph's pixels onto the framebuffer) — no scaling or transformation, just placement. |
| **Wrap (vs. scroll)** | What happens when text output reaches the last row: it overwrites row 0 rather than shifting everything up. A deliberate Rebel-ROM design choice, not a Rebel-Sim gap. |
| **Usage code** | A small integer identifying *which physical key* was pressed/released, independent of any character it might produce (a Caps Lock press has a usage code but no character). |
| **Pseudo usage code** | The `0x80 + bit` convention for reporting a modifier key's (Ctrl/Shift/Alt/GUI) own press/release as an ordinary queue event, alongside real keys, rather than only ever exposing modifiers as a side-channel bitmask. |
| **`KMAP` bank** | Arena bank holding the usage-code → character translation table (two 256-entry planes: unshifted, shifted). Data, not code — swapping layouts means loading different bytes, not changing translation logic. |
| **Keyboard event queue** | A small, fixed-size, non-blocking ring buffer of `{usageCode, modifiers, char, pressed}` events. Drops new events when full rather than overwriting or blocking. Not arena/bank memory — host/module-owned, like the framebuffer. |
| **`KEY?`** | Primitive: `-- flag` — TRUE if the keyboard queue has at least one event, without consuming it. |
| **`KEY`** | Primitive: `-- char` — pops the oldest queued event's translated character. Non-blocking; errors if the queue is empty (blocking `KEY` is deferred — see §1.20). |
| **Project** | A folder of asset files — one file per bank, each an exact byte dump. Editable, in-progress material (as opposed to a cart). |
| **Cart** | A single flat baked binary, meant only to be run, not edited. Baking (producing one from a project) isn't built yet. |
| **Asset file** | One project file, always `<bank-name>.<extension>` — the extension maps to the bank's `tag` (`DATA`↔`.DAT`, etc.), preceded by a small 6-byte sanity header. |
| **Size class** | One of a fixed ladder of bank sizes — every power of two from 4 KiB through 4 MiB (M55; an earlier revision used six named classes, each 4x the previous). A loaded file's bank size is looked up (round up to the smallest class that fits), not calculated. |
| **`StorageHal`** | Rebel-Sim's HAL interface for project/cart file I/O: synchronous `ensureDir`/`listFiles`/`readFile`/`writeFile` (M33 — originally `Promise`-based). Backed by `localStorage` in `packages/app`; defaults to a no-op (`NULL_STORAGE_HAL`) so engine tests don't need a real browser environment. |
| **Generator (JS)** | A function that can pause itself mid-execution (`yield`) and be resumed later exactly where it left off, with its local variables intact. What `executeXT` is built on (§1.23) — the mechanism blocking `KEY` needs. |
| **`StepSignal`** | What `executeXT`'s generator yields on every pause: `'progress'` (one step completed, likely more to do) or `'blocked'` (waiting on the bound `Channel`, the same point will be retried on resume). |
| **`StepStatus`** | What `Machine.step()` returns to its caller: `'idle'` (nothing running), `'blocked'`, or `'more-to-run'` (budget ran out, call `step()` again). |
| **`Channel`** | The abstraction blocking `KEY` waits on: `hasData()`/`readByte()`, deliberately input-only. `KeyboardChannel` is the only real implementation today; a future remote/network channel would implement the same two methods with zero changes to `KEY` or the interpreter (§1.24). |
| **`beginLine()` / `step()` / `interpret()`** | Three layers over one mechanism: `beginLine(line)` starts a session without running it; `step(budget)` drives it incrementally, reporting a `StepStatus`; `interpret(line)` is `beginLine` + an effectively-unbounded `step()` call, preserving the pre-M7 "runs to completion synchronously" feel for any line that never blocks. |
| **`ACCEPT`** | Primitive: `addr len -- len2` — classic Forth line input. Reads/echoes characters one at a time (blocking, like `KEY`) until Enter; Backspace erases the last echoed character. Built as its own multi-step blocking generator in `inner.ts`, not a plain `executePrimitive` case (§1.25). |
| **`TIB`** | "Terminal Input Buffer" — the small resident bank `ACCEPT` reads each on-screen REPL line into before it's tokenized. |
| **`startRepl()` / `replLoop()`** | The self-driving on-screen REPL (§1.25): draw a prompt, `ACCEPT` a line, interpret it (printing errors to the screen instead of throwing), repeat forever. Uses the same session `beginLine()`/`step()` drive — mutually exclusive with calling those directly. |
| **`BRANCH` / `0BRANCH`** | Primitives: unconditional / conditional (pop-a-flag) jump, reading the next compiled cell as an `ip` target. `ip`-mutating, special-cased in `threadFrom` like `LIT`/`EXIT` (§1.26). |
| **`COMPILE_ONLY`** | Dictionary flag: this word errors if found while interpreting (`STATE = 0`) rather than while compiling. Reserved since M2, first enforced in M8 for the control-flow/defining words. |
| **`DOVAR`** | Reserved Code Field sentinel (same tier as `DOCOL`): a plain `CREATE`d/`VARIABLE`d word — executing it just pushes its parameter field's start address (§1.28). |
| **`DOCON`** | Reserved Code Field sentinel: a `CONSTANT`-made word — executing it pushes the value stored in its one parameter cell. |
| **`DODOES`** | Reserved Code Field sentinel: what `DOES>` rewrites a word's Code Field to — executing it pushes the parameter field start, then threads into a stored does-pointer (§1.28). |
| **Does-pointer** | The address `DOES>` stores — where the "what this word does now" code begins. Lives in one leading parameter-field cell every `CREATE`d word reserves, whether or not `DOES>` is ever applied (§1.28). |
| **`(DO)` / `(LOOP)` / `(+LOOP)`** | Runtime primitives `DO`/`LOOP`/`+LOOP` compile calls to: push loop index/limit onto `RSTK` above the return address, then increment/test/pop on each iteration (§1.27). Parenthesized by convention — not meant to be typed directly. |
| **`(DOES>)`** | Runtime primitive `DOES>` compiles a call to: rewrites `LATEST`'s Code Field to `DODOES` and stores the current `ip` as its does-pointer, then unwinds like `EXIT` (§1.28). |
| **`(SLIT)`** | Runtime primitive `S"`/`."` compile a call to: `LIT` generalized to a length-prefixed byte run instead of one cell (§1.29). |

---

## 4. Milestone status

| Milestone | What it added | Key files |
|---|---|---|
| **M1** | Arena, banks, sysvars (`FORTH` group), data stack, primitive dispatch (20 primitives), a line-based outer interpreter with no dictionary yet. | `arena.ts`, `banks.ts`, `sysvars.ts`, `stack.ts`, `primitives.ts`, `repl.ts` |
| **M2** | Real dictionary (§1.9), colon-definitions (§1.11), the DOCOL-threaded inner interpreter with a real return stack (§1.13), `IMMEDIATE` (§1.14). Primitives became real dictionary entries. | `dictionary.ts`, `inner.ts`, `repl.ts` (rewritten) |
| **M3** | Screen: `CHAR` bank, the `ScreenHal` HAL boundary (§1.17), cursor/wrap-only output (§1.18), bitmap-font blitting (§1.19) — a real canvas-backed `CHAR!`/`CHAR@`/`EMIT`/`CR`/`CLS`/`AT-XY`/`INK`/`PAPER`. Sysvars grew `CORE`/`SCREEN` groups matching Rebel-ROM's real layout; M1's plain-text output buffer retired. Raw pixel drawing (`hal_draw_*`) deferred — nothing needs it yet. | `screen.ts`, `canvas-screen-hal.ts`, `font-zxspectrum.ts` |
| **M4** | Keyboard: `KMAP` bank (§1.21), non-blocking event queue (§1.20), `KEY?`/`KEY` primitives, `KEYBOARD.MODIFIERS` sysvar. Browser `keydown`/`keyup` → raw usage codes → the queue, routed only when the REPL input box isn't focused. Blocking `KEY` deferred (no task-suspension model yet). | `keyboard.ts`, `browser-keymap.ts` |
| **M5** | Storage: the real projects/carts model (§1.22) — `Storage` class, `StorageHal`, OPFS backing, bank identity retrofit (`name` vs. `tag`, §1.5), size classes, `runStorageSelfTest()`. Superseded `FORTH-ARCHITECTURE.md`'s original raw-block/`SCRS` framing (renamed `BLKS`, generic block storage, 2026-08-18), per that doc's own resolved divergence note. | `storage.ts`, `opfs-storage-hal.ts` |
| **M6** | PWA packaging — `packages/app` only, no engine changes. Angular's own PWA schematic (manifest, service worker, precaching), an on-brand icon set generated from the real `font-zxspectrum.ts` 'R' glyph, `navigator.storage.persist()`. Verified offline-bootable against a real production build, not just unit tests. | `packages/app/public/manifest.webmanifest`, `ngsw-config.json`, `app.config.ts` |
| **M7** | Execution loop & `Channel` binding (§1.23-§1.24) — `executeXT` became a resumable generator, blocking `KEY` suspends instead of throwing, `Machine.beginLine()`/`step()`/`interpret()`. Main-thread generator model chosen over a Web Worker (faithful to both hardware targets' cooperative execution). Sets up M9 (remote/WebMCP channel) to need zero interpreter changes. | `channel.ts`, `inner.ts` (rewritten), `repl.ts` (rewritten) |
| **M7a** | On-screen REPL (§1.25) — `ACCEPT` (a second, multi-step blocking primitive built the same way as `KEY`), `TIB` bank, `Machine.startRepl()`/`replLoop()`. `packages/app`'s DOM `<input>`/`<form>`/`.log` retired entirely — the whole page is the terminal now, keyboard routing no longer gated on any element's focus. | `inner.ts` (`accept()`), `repl.ts` (`startRepl`) |
| **M8** | Core vocabulary (§1.26-§1.29, 61 new primitives, tokens 32-92): memory access, return-stack words, control flow (`BRANCH`/`0BRANCH` + the `IF`/`BEGIN`/`DO`/... IMMEDIATE compiler words), `CREATE`/`DOES>` (two more Code Field sentinels, `DOVAR`/`DODOES`), strings (`S"`/`."`, scoped to single-token literals — a real tokenizer limitation, documented not hidden), and the remaining stack/arithmetic fillers. `FLAG_COMPILE_ONLY` (reserved since M2) finally enforced. `WORDS`/`VLIST` (`CORE-VOCABULARY.md` §12's own sufficiency check) runs correctly on nothing but this vocabulary, proving it's actually enough. | `primitives.ts`, `inner.ts`, `dictionary.ts`, `rebel-opcodes.json` |
| **M9** | Remote channel / WebMCP (§1.30): `RemoteChannel`/`CompositeChannel` merge remote input with the keyboard into one shared session — no interpreter changes, exactly as M7's `Channel` design intended. No server: the page registers tools via the real WebMCP browser API (`document.modelContext`, Angular's `declareExperimentalWebMcpTool`) — `type` plus five reads over the M8 inspector panel's existing introspection. Initial design assumed a bespoke bridge server; corrected after review, see `PLAN.md`. | `channel.ts`, `repl.ts`, `app.ts` |
| **M10** | Word-level breakpoints (§1.31): a third `StepSignal`/`StepStatus` value, `'breakpoint'`, reusing M7's exact suspend/resume shape — checked at the four "about to thread into a compiled word's body" sites in `inner.ts`. Breakpoints are a session-local `Set` on `Machine`, not a dictionary header flag (that byte's fully packed). Five new WebMCP tools; the one required app-side change was `App.startPump`'s `tick()`, which previously ignored `step()`'s return value entirely. | `inner.ts`, `repl.ts`, `app.ts` |
| **M11** | Comments as compiled data (§1.32): a new `IMMEDIATE` primitive, `(` (token 93), reusing `S"`'s `(SLIT)` mechanism via a `consumeQuotedText`/`compileSlit` refactor that also fixed `S"`/`."`'s previously-undocumented single-word-only bug. Compiles to `(SLIT)`+`2DROP` (a genuine no-op) while compiling, discards while interpreting. Zero `inner.ts`/`dictionary.ts`/`repl.ts` changes — dispatched through the same `IMMEDIATE`-primitive path `IF`/`S"` already use. | `rebel-opcodes.json`, `primitives.ts` |
| **M12** | System vocabulary (§1.33): `WORDS`/`SEE` loaded as genuine Forth source from `packages/app/public/system.fth` at boot, not native primitives — an interim step before real portable screens/carts exist. One new primitive, `'` (tick, token 94), needed since nothing let Forth-level code resolve a name to an `xt` at runtime before this. `SEE` is a real decompiler (`>CFA`/`XT-NAME` reverse-walk the dictionary); confirms live a tradeoff §1.32 only predicted (the comment encoding is ambiguous against a genuine discarded string). | `system.fth`, `app.ts`, `rebel-opcodes.json`, `primitives.ts` |
| **M13** | `VOCABULARY`/`USE` (§1.34): branching dictionary chains, not independent chains with a search order — a vocabulary is a `CREATE`d cell capturing the *current* `LATEST` position (a branch point, not empty) when created; `USE` swaps which chain `LATEST` extends. One new primitive, `LATEST-ADDR` (token 95), exposing the sysvar's own cell address so ordinary `@`/`!` can manipulate it — the same gap the dropped `FORGET` exploration hit. Zero `dictionary.ts`/`findWord` changes — `WORDS` becomes vocabulary-scoped for free. | `sysvars.ts`, `rebel-opcodes.json`, `primitives.ts`, `system.fth` |
| **M14** | `HIDE` (§1.35): decluttering `SEE`'s own support words (`>CFA`/`XT-NAME`/the `-XT` constants) from `WORDS`. The `VOCABULARY`-based plan §8.5 originally sketched doesn't actually work — branching only lets a *later* vocabulary see an *earlier* one, and visibility/listing are the same chain-walk. `HIDE` reuses `FLAG_HIDDEN` instead, permanently, pure Forth, zero engine changes. Every `HIDE` call has to wait until after `SEE` itself, not right after each helper, since `SEE`'s own compilation still needs to find them by name. | `system.fth` only |
| **M15** | `EXECUTE` (§1.36): one new primitive (token 96, `( xt -- )`), the indirect-call gap M13/M14 both flagged and deferred. Special-cased in `inner.ts`'s `dispatch()` (not `primitives.ts`) — recurses into `executeXT()` itself, so `DOCOL`/`DOVAR`/`DOCON`/`DODOES` dispatch, breakpoints, and nested blocking all work identically to a direct call, reusing the shared `rstack` sentinel `threadFrom` already manages on every call. | `rebel-opcodes.json`, `inner.ts` |
| **M16** | `S"`/`."` real interpret-time behavior (§1.37): `compileOnly` dropped from both; each now branches on `STATE` in `primitives.ts` instead of throwing while interpreting. A new `PAD` bank (128 bytes, like `TIB`) holds interpreted `S"`'s text; interpreted `."` needs no `PAD` at all. New primitive 97, `PAD ( -- addr )`. Rejected reusing `TIB` — an implicit, undocumented coupling with `ACCEPT` instead of a named contract. `inner.ts` untouched. | `rebel-opcodes.json`, `repl.ts`, `primitives.ts` |
| **M17** | `ABORT` (§1.38): scoped in full as `THROW`/`CATCH`/`ABORT`, deliberately trimmed to just `ABORT` (token 98) before implementing — no consumer for the rest without `CATCH`, and this project doesn't track ANS conformance closely. Empties the data stack (`DataStack.clear()`, new) and throws a plain `Error`. Found and fixed a real, independent bug along the way: `threadFrom`'s rstack sentinel leaked one entry per uncaught error, forever — `replLoop`'s catch now clears both stacks on any error, not just `ABORT`. `interpret()`'s contract is unchanged. | `stack.ts`, `rebel-opcodes.json`, `primitives.ts`, `repl.ts` |
| **M18** | `BANK@` (§1.39): `BANK@ ( "tag" -- addr )` (token 99) — parses the next input token like `'`/`CREATE`, uppercases it, looks up via `ctx.banks.findBank()`, pushes addr only (matching the `SOMETHING@` one-value convention) or throws `? unknown bank: <TAG>`. API-mediated, not arena-resident — `BankTable` is plain host-side TS. Built once a concrete need appeared: reaching any sysvar from Forth via `BANK@ SYSV <offset> + @`, a hardcoded-offset approach chosen over adding a second named-lookup primitive (`SYSV@`). | `rebel-opcodes.json`, `primitives.ts` |
| **M19** | `MMAP` (§1.40): arena-resident bank table, bank 0, 64 slots (matches `rebel-rom`'s `BANK_TABLE_MAX_BANKS`) — every `createBank()` call, including `MMAP`'s own self-referential registration, mirrors into it, in addition to (not instead of) the existing host-side array. `Bank` gains a real `flags` field; new `ACTIVE` flag (atomic exclusion during flush) supersedes ever wiring up the confirmed-inert `DIRTY`. Mirror only — `findBank()`/`BANK@`/Forth-side bank creation are unchanged, real follow-on work. Also added `CORE.ARENA-SIZE`, a new sysvar exposing total arena size to Forth. | `mmap.ts` (new), `banks.ts`, `index.ts`, `rebel-opcodes.json`, `repl.ts` |
| **M20** | `BANK@` reads `MMAP` directly (§1.41): new `MemoryMap.findBankAddr()` walks `MMAP`'s slots instead of `BANK@` calling `BankTable.findBank()` — a pure read-path swap, `BANK@`'s observable behavior unchanged (proven by the unmodified `bank-access.test.ts` suite passing as-is). The smaller half of M19's follow-on; Forth-side bank creation still doesn't exist. | `mmap.ts`, `primitives.ts`, `rebel-opcodes.json` |
| **M21** | `CREATE-BANK` (§1.42): `CREATE-BANK ( size "tag" -- addr )` (token 100) — calls `MemoryMap`'s allocator directly from a primitive, genuinely no host round-trip. Name always equals the (truncated) tag, no auto-serial, no out-of-space check. At the time: invisible to `getAllBanks()`/`findBank()`/`storage.ts`/`read_banks`/the inspector panel — closed by M22. | `rebel-opcodes.json`, `primitives.ts` |
| **M22** | `MMAP` becomes the real source of truth, no cached state anywhere (§1.43): `mmap.ts` gains `allocate()` (finds a free slot + computes base by scanning all 64 slots' `ACTIVE` bits, no cursor cell), replacing `addBank()`/`getNextFree()`/`getSlotCount()` outright. `BankTable` fully delegates reads/allocation to `mmap`, closing M21's visibility gap and fixing a real overlap bug (host and Forth creation used to drift apart). `MMAP_SIZE` shrinks to 1540. Object identity no longer stable across reads. | `mmap.ts`, `banks.ts`, `primitives.ts` |
| **M23** | A batch of 13 low-level primitives (§1.44, tokens 101-113): `XOR`, `.S`, `2SWAP`, `2OVER`, `CELLS`, `CELL+`, `FILL`, `CMOVE`, `BL`, `SPACE`, `WITHIN`, `PICK`, `ROLL` — real gaps against M8's own §9 batch. Plain stack-effect primitives, zero `repl.ts`/`dictionary.ts`/`inner.ts` changes needed. `WITHIN` deliberately plain-signed (not full ANS wraparound semantics); no `CMOVE>`/`LSHIFT`/`RSHIFT` added (nothing needs them yet). | `rebel-opcodes.json`, `primitives.ts` |
| **M24** | `BASE`/`HEX`/`DECIMAL` (§1.45, tokens 114-116): `BASE ( -- addr )` exposes `FORTH.BASE`'s sysvar address, same `fieldOffset()` pattern `LATEST-ADDR` (M13) used — a real variable, `BASE @`/`n BASE !`, not a read-only value word. `HEX`/`DECIMAL` are thin `setBase()` sugar. A real gotcha (every subsequent numeric token, not just this one, parses under the new base) documented in `DEVELOPING.md` §16, then actually tripped a first-draft test before being fixed and turned into its own explicit assertion. | `rebel-opcodes.json`, `primitives.ts` |
| **M25** | A visible, inverse-video text cursor: `CURSEN`/`CURSDIS` (§1.46, tokens 117-118). Neither target has ever rendered a visible cursor. `Screen`-level, not HAL, not Forth — `setCursor()` gains a redraw hook every existing cursor-movement path already routes through for free; `writeChar()` itself never auto-inverts (would highlight the character being typed, not the cursor). New `SCREEN.CURSOR-VISIBLE` sysvar, a genuine cross-target candidate like `CORE.ARENA-SIZE`. A real `cls()` ordering bug (cursor drawn before the framebuffer clear, then painted over) found and fixed as part of this change. | `screen.ts`, `rebel-opcodes.json`, `primitives.ts` |
| **M26** | Wiring the cursor into the interactive REPL (§1.47): one line, `showCursor()`, added to `startRepl()` — not the constructor (would affect every programmatic caller) and not just defaulting the sysvar (wouldn't actually draw anything until the first keystroke). Cursor now visible from the very first prompt, confirmed live. | `repl.ts` |
| **M27** | A real bank-naming collision bug, found while reviewing storage (§1.48): `CREATE-BANK` bypassed the uniqueness check and named banks after their tag, so two Forth-created banks sharing a tag always collided — reproduced end-to-end through `saveAsset()`/`openProject()`. Fixed by moving the bank-naming serial counter into `MMAP`'s own header (available before `Sysvars` even exists, avoiding a sysvar-backed design's real chicken-and-egg problem). Header grows 4→16 bytes: `NEXT-BANK` (the fix), `ARENA-SIZE` (moved out of `CORE`), `ARENA-ID` (reserved, future multi-arena bookkeeping). | `mmap.ts`, `banks.ts`, `primitives.ts`, `repl.ts`, `rebel-opcodes.json` |
| **M28** | The stack pointer becomes a real sysvar: `SP@`/`SP!`/`SP0`, `RP@`/`RP!`/`RP0` (§1.49, tokens 119-124). `DataStack`'s private `sp` field is gone — replaced by a getter/setter over two new `FORTH` sysvar fields (`SP`/`RP`, live) alongside the already-reserved-but-never-written `SP0`/`RP0` (constant base), matching how `HERE`/`LATEST`/`BASE`/`STATE` already avoid an engine-side copy. `SP0`/`RP0`/`SP@`/`RP@`/`SP!`/`RP!` push/pop through the sysvar directly; `RP!` carries a real, named risk (a wrong mid-execution write corrupts the live call chain), same "authentic risk" stance as `MMAP`'s raw writes. | `stack.ts`, `rebel-opcodes.json`, `primitives.ts`, `repl.ts` |
| **M32** | `FORGET` (`DEVELOPING.md` §8.6), picked back up after being left as an open question since M13: one new primitive, `HERE-ADDR` (token 125), exposing `FORTH.HERE`'s own cell address the same `fieldOffset()` pattern `LATEST-ADDR` (M13) established for `LATEST` — the half of the gap M13 deferred, since reclaiming a forgotten word's `DICT` space needs to roll `HERE` back too, not just relink `LATEST`. `FORGET` itself is pure Forth in `system.fth`, reusing `HIDE`'s reverse chain-walk with a different found-branch: `LATEST`/`HERE` roll back to the forgotten entry's own link/address, the same rollback `dictionary.ts`'s `abortDefinition` already does for a half-built definition, just reachable for any named word. Known limitation, unaddressed: forgetting a word a `VOCABULARY` branch point depends on corrupts that vocabulary's chain — not designed, no concrete joint use case yet. | `rebel-opcodes.json`, `primitives.ts`, `system.fth` |
| **M33** | Storage becomes synchronous, `localStorage` not OPFS (§1.22, `DEVELOPING.md` §25), plus `BSAVE`/`BLOAD`. Asked for `BSAVE`/`BLOAD`; investigating surfaced that `PROJECT`/`SAVE`/`RESTORE` (M29) were outer-loop-only special syntax purely because OPFS's Promise-based API had forced a dedicated `'storage'` `StepStatus`/`StepSignal` onto the core interpreter — checked against `FORTH-ARCHITECTURE.md`'s own porting note, real hardware's storage access has no async concept at all, so this was a browser-platform artifact in the shared engine contract, not a genuine requirement. Rejected: a Web Worker (reverses M7's settled main-thread decision) and `lightning-fs` (Promise/callback-only, same IndexedDB main-thread limitation as OPFS, checked directly against its docs). Fixed by swapping to `localStorage` (genuinely synchronous, smaller quota, base64-encoded payloads, `local-storage-storage-hal.ts` replacing `opfs-storage-hal.ts`): `StorageHal`/`Storage` dropped every `Promise`; `repl.ts`'s `'storage'` `StepStatus` and its suspend/resume fields/methods deleted outright; `PROJECT`/`SAVE`/`RESTORE` moved into `primitives.ts` as ordinary dispatch cases (tokens 126-128) — genuine dictionary entries, `SAVE` fully usable compiled/`EXECUTE`d. Two new primitives, `BSAVE`/`BLOAD` (tokens 129-130, `( "tag" -- )`), resolve a bank via `BankTable.requireBank` and call `saveAsset`/a new `Storage.loadAsset()`. Known, inherited limitation: `PROJECT`/`RESTORE`/`BSAVE`/`BLOAD` still parse their argument via `nextInputToken()`, the same shape `BANK@`/`CREATE-BANK`/`'` already have — only resolves correctly interpreted directly, not compiled with a following literal. | `storage.ts`, `repl.ts`, `primitives.ts`, `rebel-opcodes.json`, `local-storage-storage-hal.ts`, `app.ts` |
| **M34** | `MMAP` conforms to the size-class rule, no more exception (`DEVELOPING.md` §26). Suggested directly, following on from M33: bump `MMAP`'s size to the XS class (4096 bytes) instead of its exact computed 1552, for consistency — a real, accepted breaking change for anything already saved (no real project data exists yet). Traced through the bump allocator's actual rounding math before touching anything: `(1552+4095)&~4095` and `(4096+4095)&~4095` both equal `4096`, so this is layout-neutral for every other bank — confirmed empirically, the full engine suite passed unmodified except one stale comment. `mmap.ts`'s `MMAP_SIZE` is now a literal `4096` (matching `BankSizeXS`, not imported, same reason `NAME_SIZE` isn't); the raw `16 + MAX_SLOTS × 24` computation is kept internally only to assert it never exceeds 4096. `spec/02-MEMORY-MODEL.md` §5.3 rewritten (`MMAP` no longer exempt from §4.3, now rounds up like any other carved bank) and §5.4's worked example updated. `rebel-rom` needs no matching change — its bank table is still a plain host-side array, not yet an arena-resident `MMAP`. | `mmap.ts`, `spec/02-MEMORY-MODEL.md` |
| **M35** | `WARM`/`COLD` (§1.50, `DEVELOPING.md` §27), picked back up after M29 deferred both citing `Machine`'s `readonly` fields as the blocker. Split by how much state each touches instead of making `Machine` rebuildable: `WARM` (token 131) is a plain primitive clearing both stacks, `DICT`/`MMAP` untouched. `COLD` (token 132) is a pure Forth-to-host signal — a fourth `StepSignal`/`StepStatus` value, `'cold'`, riding M10's breakpoint-yield mechanism — since a full reset genuinely can't happen in place; the host (`app.ts`) reacts by constructing a brand new `Machine`. Two real bugs found and fixed along the way: an `ngAfterViewInit` reordering that broke keyboard-listener registration's implicit "before the first `await`" invariant (caught by an existing test going flaky, not assumed), and `registerWebMcpTools()` capturing a now-stale `Machine` reference at registration time. | `rebel-opcodes.json`, `primitives.ts`, `inner.ts`, `repl.ts`, `app.ts` |
| **M36** | Dictionary hover tooltip shows a primitive's note (§1.51, `DEVELOPING.md` §28). Web-only monitor-panel sugar, requested directly, out of scope for `FORTH-ARCHITECTURE.md`/`PORTING-WEB.md`. New `dictionary.ts` export `getPrimitiveNote(name)` — a name→note lookup over `opcodes.primitives`, not a `DictionaryEntry` field (a note is documentation, not runtime state). `app.ts`'s `wordTooltip()` shows the note when one exists, falling back to the original breakpoint-hint text for every user-defined word and note-less primitive. Click-to-toggle-breakpoint behavior itself is unchanged. | `dictionary.ts`, `index.ts`, `app.ts`, `app.html` |
| **M37** | `REDRAW` (§1.52, `DEVELOPING.md` §29): repaints the framebuffer from `CHAR` content, for when Forth source pokes `CHAR` directly (`BANK@ CHAR ... C!`) and bypasses `writeChar()`'s HAL write-through. Exposes the already-existing `Screen.redrawAll()` (M29) as an ordinary word (token 133) — no new mechanism. A real cross-target primitive (checked against `rebel-rom`'s `CScreenModule::Redraw()`, not assumed), unlike M36's web-only tooltip. Deliberately whole-buffer only for now, to find out empirically how expensive a full sweep is before adding a targeted single-cell/rectangle variant. | `rebel-opcodes.json`, `primitives.ts` |
| **M38** | Sysvars section in the left-side monitor overlay (§1.53, `DEVELOPING.md` §30). Web-only UI, requested directly, same scope as M36's tooltip. New `sysvars.ts` export `listSysvars(sysvars)` walks `opcodes.sysvarGroups`, skips groups with no fields defined yet (`FONT`/`SPRITE`), and reads each real field's live value plus its JSON note — same "read `rebel-opcodes.json` metadata through a dedicated accessor" pattern `getPrimitiveNote` established for M36. `.storage-panel` gained a `sysvars:` table (group/field/value, note as the field's hover title); `app.ts`'s new `sysvarsTable` signal is polled/diffed every `tick()` frame rather than behind a cheap proxy, since sysvars move on nearly every executed word. | `sysvars.ts`, `index.ts`, `app.ts`, `app.html` |
| **M39** | The `follow-specs` pass begins: `spec/01-HAL.md` conformance. Screen/Keyboard/Channel/Storage already conformant. Closed the one real gap, Timing (§7): a new `TimingHal` interface (`millis()`), a `performance.now()`-backed browser implementation — deliberately plumbing only, no Forth-visible word yet, nothing needs elapsed time. Named the Error Reporting (§8) sink: extracted the existing uncaught-error screen print into `reportError()`, tying it to `hal_report_error`. | `timing.ts`, `performance-timing-hal.ts`, `repl.ts` |
| **M40** | `spec/02-MEMORY-MODEL.md` conformance: already fully conformant, byte-for-byte, down to the exact worked-example bank sequence. One stale comment fixed (`banks.ts` still described the pre-M34 MMAP size exemption `mmap.ts` itself had already closed). | `banks.ts` |
| **M41** | `spec/03-SYSVARS.md` conformance: already fully conformant — every group base offset and field offset matches exactly, including the offsets optional/omitted fields leave unshifted. No code changes. | — |
| **M42** | `spec/04-FORTH-CORE.md` §6 KERNEL→BOOTSTRAP reclassification (§1.26's control-flow block and more): 59 words moved from native primitives into `system.fth` — the entire control-flow compiler, `VARIABLE`/`CONSTANT`, stack shufflers/arithmetic derivatives — built from five primitives that stay native (`BRANCH`/`0BRANCH`/`(DO)`/`(LOOP)`/`(+LOOP)`). The `DOCON` Code-Field sentinel removed entirely (`CONSTANT` is `CREATE , DOES> @` now). New `COMPILE-ONLY` bootstrap-marking keyword. `test-support.ts`'s `bootMachine()` introduced — engine tests exercising any now-BOOTSTRAP word need it, since a bare `Machine` no longer has `IF`/`BEGIN`/`VARIABLE`/etc. defined at all. | `system.fth`, `primitives.ts`, `dictionary.ts`, `inner.ts`, `rebel-opcodes.json`, `test-support.ts` |
| **M43** | Self-hosting the outer interpreter (§1.54, `spec/04-FORTH-CORE.md` §5.2/§6.13) — the deferred half of M42's own spec. `WORD`/`FIND`/`NUMBER`/`INTERPRET`/`[`/`]` and `:`/`;`/`IMMEDIATE`/`COMPILE-ONLY` are all genuine dictionary words now; the old native tokenizer survives only as a fallback (bootstrapping `system.fth` itself, and any `Machine` that never loads a bootstrap layer). Full detail in §1.54. Followed by two small spec/behavior additions the same day: `NUMBER`'s digit-validation gap folded back into `spec/04-FORTH-CORE.md` §6.13 (a divergence found while implementing it), and `NUMBER` echoing its failing token before `ABORT` (§8's own new RECOMMENDED convention, the classic fig-Forth/Forth-79 `TOKEN ?` idiom — neither predecessor had `THROW`/`CATCH`). | `repl.ts`, `primitives.ts`, `rebel-opcodes.json`, `system.fth`, `app.ts`, `app.spec.ts` |
| **M44** | Comment retention reverted (§1.32, §1.55): `(` (token 93) now discards its text unconditionally, compiling or not — plain classic Forth behavior — instead of M11's `(SLIT)`+`2DROP` compiled-inline-data encoding. The whole point of retaining it was so `SEE` could echo a comment back; it never did (M12 confirmed `SEE` shows `"comment text" 2DROP`, not `( comment text )`, indistinguishable from a genuine discarded string) and the ambiguity was never resolved, so keeping the extra compiled bytes stopped earning its keep. `FORTH-ARCHITECTURE.md` §9 item 13 and `spec/04-FORTH-CORE.md`'s `(` row both updated to record the reversal. | `primitives.ts`, `rebel-opcodes.json`, `comments.test.ts` |
| **M45** | `BLKS` bank + `(BLOCK-READ)`/`(BLOCK-WRITE)` (§1.56, `FORTH-ARCHITECTURE.md` §7): the HAL half of the classic Forth block-buffer mechanism, spec'd ahead of the Screen Editor work and built the same day the backing bank was renamed `SCRS`→`BLKS` (generic block storage, no screen/text assumption). Boot-created 16-block (16 KiB) resident bank, two bounds-checked memcpy primitives (tokens 140/141), a new `.BLK` extension so `SAVE`/`RESTORE`/`BSAVE`/`BLOAD` round-trip it for free. Portable Forth `BLOCK`/`BUFFER`/`UPDATE`/`FLUSH` and any editor word are still unbuilt — staged next. | `banks.ts`, `repl.ts`, `primitives.ts`, `rebel-opcodes.json`, `storage.ts`, `block-io.test.ts` |
| **M46** | `BLOCK`/`BUFFER`/`UPDATE`/`FLUSH` (§1.57, `FORTH-ARCHITECTURE.md` §7): the portable half of M45's mechanism, built entirely in `system.fth` over `(BLOCK-READ)`/`(BLOCK-WRITE)` — no engine changes. A fixed 4-slot buffer pool (round-robin eviction, one dirty flag per slot), explicitly initialized rather than trusting a zero-filled default, every loop a full unconditional scan since `LEAVE`/`UNLOOP` don't exist yet and `EXIT` inside a `DO` loop would corrupt the return stack. Caught and fixed a real bug while writing it: a paren-named primitive like `(BLOCK-READ)` mentioned inside a `(` comment closes that comment early, since `(` doesn't nest and a comment's own scan is per-token — every mention rewritten as plain prose instead. Internal plumbing `HIDE`n after `FLUSH`; only `BLOCK`/`BUFFER`/`UPDATE`/`FLUSH` stay visible. | `system.fth`, `block-words.test.ts` |
| **M47** | `EMPTY` (§1.58, `FORTH-ARCHITECTURE.md` §7): resets the dictionary to `COLD`'s post-boot state in place, without `COLD`'s own full `Machine` rebuild — spec'd for the Screen Editor's expected edit/reload cycle. Pure Forth, no engine changes: reuses `FORGET`'s `LATEST-ADDR`/`HERE-ADDR` write-back against a captured point instead of a named-word chain-walk. The real trick is capturing that point *after* `EMPTY`'s own definition closes (via two plain `VARIABLE`s set post-hoc, not a `CONSTANT` baked in too early), so `EMPTY` never forgets itself. Defined after `INTERPRET` on purpose — "the state `COLD` produces" means the complete post-boot vocabulary. | `system.fth`, `empty.test.ts` |
| **M48** | The Screen Editor (§1.59, `FORTH-ARCHITECTURE.md` §7): `LOAD` plus an `EDITOR` vocabulary (`LIST`/`L`/`T`/`TOP`/`CLEAR`) — the core edit/run loop, single-letter fig-FORTH-style names, full classic set (insert/delete/search/`COPY`) deferred. One new native primitive, `(SET-INPUT)` (142) — nothing before this needed to redirect the shared input cursor away from the TIB. `EDITOR` is a real, separate vocabulary (`VOCABULARY`/`USE`, M13) specifically so single-letter names like `T` don't collide with ordinary code (`I` would shadow the loop-index word). Two real bugs surfaced and fixed: the `(` comment-closing footgun a third time (plus a new unclosed-comment variant), and a genuine ~2.5x boot-time regression from a first-draft Forth-level blank-fill loop, fixed by giving `Arena` a native `fillBytes()` and space-filling `BLKS` at bank creation instead — `vitest.config.ts`'s `testTimeout` raised to absorb the remaining, structural self-hosted-compile cost. **Follow-up 1, found immediately:** `EMPTY` silently corrupted `EDITOR`'s own dictionary chain if called while `EDITOR` was still active, since it reset `LATEST` without ever touching `CURRENT-VOCAB` — fixed by having `EMPTY` also force `CURRENT-VOCAB` back to `FORTH`. **Follow-up 2 (§1.60), the next day:** replaced single-pointer `USE` with the real classic `CONTEXT`/`CURRENT-VOCAB` split — browsing a vocabulary no longer redirects where new words compile, fixing the `LOAD`-lands-in-the-wrong-vocabulary concern for good, plus a genuine dead-end design (`FIND`/`WORDS` always dereferencing `CONTEXT`) found and reversed before landing on the right one (compare `CONTEXT` against `CURRENT-VOCAB`, only dereference when they differ). Zero engine changes for either follow-up. | `arena.ts`, `repl.ts`, `primitives.ts`, `rebel-opcodes.json`, `system.fth`, `vitest.config.ts`, `screen-editor.test.ts`, `empty.test.ts` |
| **M49** | Four real self-hosted-only bugs (§1.61), found by Oliver actually using the machine rather than planned review: `DEPTH` (off-by-one, `SP0`/`SP@` pushed in the wrong order), `PICK` (self-referential garbage on `0 PICK`, off-by-one on every other index — transitively fixed `.S`/`2OVER` too, no changes to either), `.S`/`FILL`/`CMOVE` (all three missing the same zero-length `DO`/`LOOP` guard `TYPE` already had), and `WARM` (self-hosted `INTERPRET`'s own live `RSTK` frame makes "reset `RSTK`, then return normally" structurally impossible — reclassified back to native, now throws a dedicated `WarmReset` signal caught by `repl.ts`'s two recovery sites, aligned with classic `WARM`/`QUIT` semantics: abandons the rest of the line instead of the old, already-broken "keeps executing it" contract). All four only ever affected the self-hosted (`system.fth`) definition, never the native primitive underneath — exactly why none of it showed up in the existing native-only tests. Verified live in a real browser for the first time this session, via `chrome-devtools-mcp` and the app's own new WebMCP tools. `spec/04-FORTH-CORE.md` corrected in several places to match (§6.1, §6.3, §6.5, §6.8, §6.12, §2.4). | `system.fth`, `primitives.ts`, `repl.ts`, `stack-arith.test.ts`, `low-level-batch.test.ts`, `warm.test.ts` |
| **M50** | `BANK-SIZE` (§1.62), the read-only `Bank.size` counterpart `BANK@` never had — and, found by Oliver while looking at the bank monitor, `BANK@` itself switches from `tag` to `name` lookup: a tag-keyed lookup could only ever reach whichever same-tagged bank was created first, silently hiding every other one, once multiple banks could legitimately share a tag (project `DATA` assets today, a future second `BLKS`-tagged bank). Every boot-created system bank gets an explicit `name` matching its `tag` (`SYSV`/`DSTK`/`RSTK`/`DICT`/`CHAR`/`KMAP` previously got auto-generated serials) so existing `BANK@ SYSV`-style lookups are unaffected; the `BLKS` bank (renamed `EDITOR`, same session) is the first real beneficiary — `BANK@ EDITOR`, not `BANK@ BLKS`. `MemoryMap.findBankAddr()` (M20) deleted as dead code once nothing called it. Also renamed the `BLKS`-tagged boot bank's own `name` to `EDITOR` (its only consumer today, the Screen Editor) — tag stays generic/HAL-level, `name` is free to say what a given instance is for. Resize discussed as a future direction; deliberately given no reserved wording, since `spec/02-MEMORY-MODEL.md` §7 already defers it explicitly and the reason is structural (no compaction/relocation), not just unbuilt. | `repl.ts`, `primitives.ts`, `rebel-opcodes.json`, `mmap.ts`, `bank-access.test.ts`, `block-io.test.ts`, `mmap.test.ts` |
| **M51** | `BANKS` and `PROJECTS` (§1.63), requested directly: `WORDS`-shaped dev-ergonomics words to browse what banks/projects actually exist. `BANKS` is pure Forth (`system.fth`), walking `MMAP`'s own fixed-stride slot table directly, the same "it's just arena memory" reasoning `WORDS` already applies to the dictionary chain. `PROJECTS` is one new primitive (145) wrapping `storage.ts`'s `listProjects()`, since project names live in `StorageHal`, not the arena. Found and fixed a real, pre-existing `rebel-opcodes.json` doc staleness along the way: `CREATE-BANK`'s (100) own note still described its pre-M30 design (name==tag, no auto-serial), superseded once M30 routed it through `BankTable.createBank()`. | `system.fth`, `primitives.ts`, `rebel-opcodes.json`, `bank-access.test.ts`, `project.test.ts` |
| **M52** | `DUMP` (§1.64), a classic hex dump: 16 rows of 8 bytes, 8-digit hex address, space-separated hex bytes, ASCII column with `.` for non-printable. Pure Forth, `system.fth` — no engine changes. New `HEXDIGIT`/`HEX2`/`HEX8` helpers build nibble/byte/cell hex formatting from `/`/`MOD` alone, no native shift primitive needed; `HEX8` extracts all eight nibbles via a `DUP 16 MOD SWAP 16 /` loop and prints them straight off the stack, most-significant-first, since extraction order and LIFO pop order happen to align. | `system.fth`, `dump.test.ts` |
| **M53** | `BANK@` (§1.65) becomes `IMMEDIATE` and dual-mode on `STATE`, found by Oliver trying `: TESTING BANK@ CHAR ;` — a plain non-`IMMEDIATE` `BANK@` compiled a call to itself and left the compiler's own outer loop to choke on the following name token, since it was never meant to be looked up as an ordinary word. Same `S"`/`."` STATE-dispatch pattern (case 68/70), but bakes in a resolved `LIT` address rather than raw text — the name is resolved at the *defining* word's own compile time now, correct for the fixed system banks and any already-stable bank, stale only if that bank is later dropped and recreated. Interactive behavior (`BANK@ SYSV`, `BANKS`' internals) is unchanged. | `primitives.ts`, `rebel-opcodes.json`, `bank-access.test.ts`, `02-MEMORY-MODEL.md`, `04-FORTH-CORE.md` |
| **M54** | Bank resizing (§1.66), Oliver's idea: `BANK-RESIZE` edits a bank's `MMAP` size field only, inert until a `RESTORE` that detects the saved size no longer matches what the running `Machine` actually booted with (`bootBankSize`, not a live re-read, which would always agree with a just-edited `MMAP` cell) triggers a full restart instead of an in-place patch — `inner.ts`'s `dispatch()` special-cases `RESTORE` the same way `COLD` already is, yielding a new `'restart-project'` `StepSignal`/`StepStatus` the host (`app.ts`) reboots into via `Machine`'s new `bootProject` option, which re-derives every bank's base from the saved sizes through the ordinary bump allocator before restoring content. `DSTK`/`RSTK` are unconditionally cleared across that restart — their live `SP`/`RP` are high-end-relative absolute addresses a relayout can silently invalidate even when their own size didn't change, a correctness trap found while designing this. Reordering `DICT` right after `SYSV` (this same session, just before M54) is what keeps `DICT`'s own base pinned regardless of how many times it's resized. | `mmap.ts`, `banks.ts`, `storage.ts`, `primitives.ts`, `inner.ts`, `repl.ts`, `app.ts`, `rebel-opcodes.json`, `02-MEMORY-MODEL.md`, `resize.test.ts` |
| **M55** | Size classes double instead of quadrupling, and lose their letter names (§1.67), Oliver's idea, prompted right after using M54's resize mechanism for the first time: the old 4x-per-step ladder (`XS`..`XXL`) could round a request up by nearly 4x; plain doubling from `MIN_BANK_SIZE` (4 KiB) to `MAX_BANK_SIZE` (4 MiB) halves that worst case while removing the maintained `SIZE_CLASSES` lookup array and its six named constants entirely — `roundToSizeClass` is now a direct power-of-two computation, no table. Every bank size chosen before this change was already a power of two (the old classes were exactly the even powers of two), so no existing bank's actual byte size changes — only new, in-between requests round more tightly now. | `banks.ts`, `index.ts`, `mmap.ts`, `rebel-opcodes.json`, `02-MEMORY-MODEL.md`, `03-SYSVARS.md`, `banks.test.ts`, `resize.test.ts`, `bank-access.test.ts`, `storage.test.ts`, `mmap.test.ts` |
| **M56** | The remaining core screen-editor commands (§1.68), completing what M48 deliberately deferred: cursor tracking (`R#`/`#LOCATE`/`#LEAD`/`#LAG`/`M`), line editing (`TEXT`/`-MOVE`/`H`/`E`/`S`/`D`/`R`/`P`/`I`, `I` kept as classic's own name per Oliver's explicit call despite shadowing `DO`/`LOOP`'s loop index), `COPY`, and search/replace (`-TEXT`/`1LINE`/`FIND`/`DELETE`/`N`/`F`/`B`/`X`/`TILL`/`C`) — all ported from `inspiration/figforth_editor_screens.txt`, reimplemented with named scratch variables and `BEGIN`/`WHILE`/`REPEAT` instead of classic's own dense stack code and `DO`-loop-plus-`LEAVE` (this project has no `LEAVE`). `TS` initially left unported here — see M57 (§1.69), which revisited and shipped it. Three real bugs found and fixed while hand-tracing the port: a nested-paren Forth comment aborting the whole file's load, `TEXT-LEN` never actually getting wired into `TEXT`'s own body, and `-TEXT`'s first draft using `2DUP` on the wrong two stack items (fixed, like `1LINE`, with named variables instead of positional stack tricks). | `system.fth`, `screen-editor-commands.test.ts` |
| **M57** | `TS` (§1.69): interactive multi-line block entry, rebuilt rather than literally ported once the M56 premise turned out wrong — classic's own `T` never reads anything itself, it's the terminal hardware that echoes keystrokes, a model this project's screen doesn't have. Needed no engine change: `KEY` already suspends correctly through any depth of colon-word/loop nesting (`dispatch`/`executeXT`/`threadFrom`'s `yield*` chain), so a plain `BEGIN`-loop around it gets `ACCEPT`'s own suspend/resume for free. Built instead around `AT-XY`/`CHAR!` positioned writes (`C/L` doesn't evenly divide the 80-column screen) and `CURSEN`/`CURSDIS` (M25, never actually called until now). Found and fixed while building it: five more nested-paren comment breaks; `>=`, missing from this dialect, hit as a real bug twice independently (§1.68's `FIND`, now `TS`'s own overflow guard) and finally added for real (`: >= < 0= ;`); a genuine `R#`-left-out-of-range bug the first test run caught; Escape given a `KMAP` entry for the first time, flagged as a Rebel-Sim-only addition until `rebel-rom`'s own keymap is confirmed to need the same thing. Two Oliver follow-ups after trying it live: Esc leaves the cursor visible instead of hiding it (`CURSDIS` dropped from just that exit path); Up/Down/Left/Right cursor movement added (four more `KMAP` entries, same reasoning as Escape), deliberately unclamped beyond the screen's own `0..BLOCK-SIZE` bounds ("consistent to drop clamping everywhere... as long as we stay inside the screen buffer boundaries") — which also retired `TS-START` entirely, since `TS` always starts fresh at `R#` 0 and that variable had only ever equaled 0 in practice. | `system.fth`, `keyboard.ts`, `screen-editor-commands.test.ts`, `keyboard.test.ts`, `FORTH-ARCHITECTURE.md` |
| **M58** | `MIN_BANK_SIZE` drops 4 KiB → 2 KiB (§1.70), Oliver's idea, prompted by auditing how much of the 4 KiB floor `MMAP`/`KMAP`/`WORK`/`SYSV` actually used (well under half each). Bump-allocator alignment (`mmap.ts`) now derives from `MIN_BANK_SIZE` instead of a hardcoded 4095/`~4095` mask, preserving the doubling ladder's zero-padding property at the new floor. `DSTK`/`RSTK` deliberately cut from 1024 cells to 512 (a real capacity decision, not a side effect — confirmed with Oliver, since unlike the other four banks they weren't rounded-up-from-smaller in the first place). `SYSV`/`KMAP` now diverge from `rebel-rom`'s still-4-KiB-floor bank sizing — flagged in code comments as a widening of an already-existing ladder mismatch (`rebel-rom` never adopted M55's doubling ladder either), not a new problem. `CHAR`/`DICT`/`BLKS` unaffected — already above the new floor. | `banks.ts`, `mmap.ts`, `repl.ts`, `02-MEMORY-MODEL.md`, `banks.test.ts`, `mmap.test.ts`, `bank-access.test.ts`, `storage.test.ts`, `strings.test.ts` |
| **M59** | Arena-resident `FONT` bank (§1.71), loaded by default from the user's own `rebel.FNT` (packages/app/public), resolving `spec/03-SYSVARS.md` §8's long-reserved `FONT` group for real. `repl.ts` creates the bank and points the new `FONT.FONT-BASE` sysvar at it; `app.ts` fetches `rebel.FNT` and writes it into the arena in parallel with `system.fth`, before anything can render. `CanvasScreenHal` now reads glyphs from the arena via `FONT-BASE` instead of importing a compiled-in font (`font-zxspectrum.ts` deleted) — `attach(arena, sysvars)` solves the ordering problem of the HAL being constructed before the `Machine` that owns what it needs to read. Confirmed with Oliver: iteration is edit-the-file-then-refresh, same as `system.fth` already works, no dedicated live-reload tool built. Flagged, not hidden: `rebel-rom`'s own font system stays entirely HAL-side with no Forth-addressable bank or runtime switching (`docs/FONT-SYSTEM.md` §6) — this makes Rebel-Sim genuinely ahead here, and `01-HAL.md` §3.7 makes the whole `FONT` bank/sysvar group OPTIONAL for exactly that reason. | `rebel-opcodes.json`, `repl.ts`, `canvas-screen-hal.ts`, `app.ts`, `01-HAL.md`, `02-MEMORY-MODEL.md`, `03-SYSVARS.md`, `bank-access.test.ts`, `sysvars.test.ts`, `storage.test.ts` |
| **M60** | `LOAD` stack-safety bug (§1.72), found live by Oliver: a colon-definition with `DO`/`LOOP` split across block lines threw `? ABORT` on `LOAD`, working fine on one line. Root cause: `LOAD` kept the block's base address live on the *data* stack across its whole 16-line loop, re-`DUP`-ing it each iteration — `DO`'s own compile-time backpatch address, still pending on that same stack until its matching `LOOP` (a later block line) consumed it, got re-`DUP`-ed instead, corrupting every subsequent line's computed address. Isolated in a fresh `Machine` (not the live session) to a general case: any interpreted line leaving anything on the data stack, not just `DO`, breaks it — confirmed with two bare unconsumed numbers split across lines, no colon-definition involved. Fixed with two dedicated variables (`LOAD-ADDR`/`LOAD-CONTEXT`) instead of leaving state live on the data stack, matching `R#`/`SCR`/`T-LINE`'s own established pattern. | `system.fth`, `screen-editor.test.ts` |
| **M61** | Address-less `DUMP` (§1.73), Oliver's idea: a bare `DUMP` continues from wherever the last one left off, monitor-style paging, instead of always needing an explicit address. `DEPTH 0= IF DUMP-NEXT @ THEN` decides which form was used; `DUP 128 + DUMP-NEXT !` right after unconditionally advances the next start address, so explicit-address and bare calls compose naturally. `DUMP-NEXT` stays an ordinary visible `VARIABLE`, pokeable directly, not hidden internal plumbing. | `system.fth`, `dump.test.ts` |
| **M62** | Indexed color palette (§1.74, `spec/01-HAL.md` §3.6, `spec/02-MEMORY-MODEL.md` §4.6): new `PAL` bank (up to 16 selectable 16-entry `0xRRGGBB` palettes, default palette normatively resident at map slot 0) and `ATTR` bank (`CHAR`'s per-cell `IIIIPPPP` ink/paper-index companion), gated by a new `PALETTE-BASE` sysvar (`SCREEN` group, `0` = disabled, address-of-active-map otherwise — same shape as `FONT-BASE`). `INK`/`PAPER` values 0-15 resolve through the active map when one is set; values >=16 and the disabled state stay exactly today's literal-RGB behavior, unchanged. Also fixes a real, previously-named gap: `redrawCursorAt()`/`redrawAll()` used to always reapply the *current global* `INK`/`PAPER` on redraw, never a cell's actual stored color (flagged ahead of time in the M25 note, §1.46) — now reads each cell's own `ATTR` byte instead, while a palette is active. Accepted, documented limitation: a literal RGB `>=16` written while paletted renders correctly once but isn't `ATTR`-durable across a later redraw (4-bit nibbles can't encode it). **Follow-ups, same session (§1.74):** `PALETTE-BASE`, an ordinary `system.fth` word exposing the sysvar cell's own address for direct `@`/`!` access, `BANK@ SYSV <offset> +`-built — deliberately *not* a native primitive, unlike `BASE`/`STATE`/`HERE-ADDR`/`LATEST-ADDR` (those bootstrap the very mechanism this word is just an ordinary user of). Then `PALETTE ( n -- )`, also `system.fth`: `n 64 * BANK@ PAL + PALETTE-BASE !` as one word — selects map `n`; disabling stays a plain `0 PALETTE-BASE !`, no dedicated word needed for that half. Then the default palette made active *from boot* (`PALETTE-BASE` no longer starts disabled; `DEFAULT_INK`/`DEFAULT_PAPER` are now the matching indices `4`/`0`), which surfaced and fixed two real bugs: `cls()` was passing raw `PAPER` straight to `hal.clearScreen()` unresolved, and `setCursor()`'s cursor-advance un-invert step was re-deriving the just-written cell's color from its `ATTR`-truncated nibble, silently replacing a literal RGB ink with an unrelated palette color on the very next keystroke (fixed via a `redrawOldCell` flag, skipped only from `advanceCursor()`). Then the spec itself (`01-HAL.md` §3.6, `02-MEMORY-MODEL.md` §4.6, `03-SYSVARS.md` §6) updated to make `PAL`/`ATTR`/`PALETTE-BASE` **REQUIRED** for every display-capable target instead of OPTIONAL — a software indirection layer, not a hardware-contingent capability. | `screen.ts`, `repl.ts`, `rebel-opcodes.json`, `storage.ts`, `system.fth`, `screen.test.ts`, `project.test.ts`, `spec/01-HAL.md`, `spec/02-MEMORY-MODEL.md`, `spec/03-SYSVARS.md` |
| **M63** | `MMAP`'s header grows again: `Personality` (§1.75), Oliver's idea, motivated by wanting to test `REMOTE-TERMINAL.md`'s wire protocol in software before real RP2350 hardware exists, plus a general want to describe "what kind of machine is this" (headless, screen geometry) cross-target in a fixed structured place rather than Rebel-Sim-local constants. Header grows 16→28 bytes: `PERSONALITY` (flags cell, `PersonalityFlagHeadless` bit 0 defined), `SCREEN-COLS`, `SCREEN-ROWS` — `DEFAULT_PERSONALITY` (80x60, non-headless) reproduces today's hardcoded boot geometry exactly. `BankTable`/`Machine` take an optional `personality`; `Machine` reads it back via `getPersonality()` to size `CHAR`/`ATTR` and the `SCREEN` sysvar group (cell size stays the fixed 8x8 constants, matching `REMOTE-TERMINAL.md` §5's "not negotiated in v1"). Deliberately NOT done here, confirmed with Oliver: `headless` is stored/read but doesn't yet skip any bank or `Screen`/`Keyboard` construction — real follow-on work. `HEADER_VERSION` bumped 1→2 (write-only, unenforced, free to bump). | `mmap.ts`, `banks.ts`, `repl.ts`, `mmap.test.ts`, `spec/02-MEMORY-MODEL.md` |
| **M64** | `REMOTE-TERMINAL.md`'s wire protocol + a software loopback harness (§1.76), Oliver's idea: validates the design before real RP2350 hardware exists. Three new files, no existing engine file touched: `remote-terminal-protocol.ts` (framing/checksum/`FrameDecoder` resync, per-message codec, §3/§4), `remote-board.ts` (the "board" role, §8: `BoardScreenHal implements ScreenHal` serializes to the wire instead of drawing; `RemoteBoard` wraps a real `Machine` via existing `MachineOptions.screenHal`/`personality`, no engine changes needed), `remote-terminal.ts` (the "terminal" role, §7, scoped down: a shadow `{charCode,ink,paper}` grid, no `Machine`/`Arena`/real pixel rendering — deferred until real `CanvasScreenHal` wiring happens). A real reentrancy bug found and fixed this session: `HELLO`-sending moved out of `RemoteBoard`'s constructor into an explicit `start()`, since a fully-synchronous two-role harness has the terminal's `HELLO_ACK` reply try to reach a `board` variable that isn't assigned until the constructor returns — confirmed harmless that this means `Machine`'s own unconditional boot-time `Screen.cls()` now fires (and its `CLEAR` frame lands) before `HELLO`, since `RemoteTerminal` ignores screen frames until its own `HELLO` handling has sized the shadow grid. Message-ID table stays hand-coded, not JSON-driven (§9's own deferred stance — no second consumer exists yet). `packages/app`/`navigator.serial` wiring (§7's actual UI) explicitly out of scope, confirmed with Oliver — `REMOTE-TERMINAL.md` §0 updated with a status note distinguishing what's now implemented from what's still design-only. | `remote-terminal-protocol.ts`, `remote-board.ts`, `remote-terminal.ts`, `remote-terminal-protocol.test.ts`, `remote-terminal-loopback.test.ts`, `REMOTE-TERMINAL.md` |
| **M65** | `TERMINAL`: a hands-on connection to a simulated board (§1.77), Oliver's idea. New portable HAL-level primitive (147), confirmed cross-target from the start (real targets implement it later via their own transport) — follows `COLD`/`RESTORE`'s exact host-signal plumbing (`inner.ts` dispatch()-level token check, a new `'terminal'` `StepSignal`, no payload). `app.ts`'s `connectToRemote()` builds a `RemoteBoard`/`RemoteTerminal` pair (persists across disconnect), reusing the already-attached `canvasScreenHal` as the render target; `tick()` branches to a new `tickRemote()` while connected, freezing the local machine for free; Ctrl+Escape disconnects. A real bug found and fixed via a failing `app.spec.ts` test (isolated with `it.only` + temporary diagnostics): the `'terminal'`/board-`'cold'` branches didn't reset `this.pumping` before their async call, permanently starving the RAF pump after connecting (`wake()`'s "already pumping" guard silently no-opped forever) — fixed by resetting it first, mirroring `resetUiSnapshotsForReboot()`. `RemoteTerminal` gained an optional `hal?: ScreenHal` param (no cursor-specific logic needed — no separate cursor HAL primitive exists anywhere in this codebase). Verified live in a real browser: `TERMINAL`, board banner/prompt appear, typed a line, Ctrl+Escape, reconnected and confirmed the board's session resumed rather than rebooting. | `rebel-opcodes.json`, `inner.ts`, `repl.ts`, `primitives.ts`, `remote-terminal.ts`, `index.ts`, `app.ts`, `app.spec.ts`, `terminal.test.ts`, `remote-terminal-loopback.test.ts`, `REMOTE-TERMINAL.md` |
| **M66** | `Personality` gains `INK`/`PAPER` (§1.78), Oliver's idea: a `TERMINAL`-connected board booting into a deliberately different color scheme (yellow-on-blue, palette indices 6/1) than local's green-on-black is a cheap, immediate visual "different machine" signal. `MMAP`'s header grows a third time, 28→36 bytes; `DEFAULT_PERSONALITY` gains `ink: 4, paper: 0` (replacing `repl.ts`'s now-removed `DEFAULT_INK`/`DEFAULT_PAPER` constants, unchanged default-boot colors). `HEADER_VERSION` bumped 2→3. `system.fth`'s `MMAP-HDR` constant updated 28→36 alongside the TS-side change this time, not after (§1.75's own hidden-bug lesson applied). Verified live: connecting via `TERMINAL` now visibly repaints the canvas, Ctrl+Escape snaps straight back. | `mmap.ts`, `repl.ts`, `app.ts`, `mmap.test.ts`, `spec/02-MEMORY-MODEL.md`, `system.fth` |
| **M67** | `BANK-SIZE` (§1.79) becomes `IMMEDIATE` and dual-mode on `STATE`, same fix as M53's `BANK@`, found by Oliver trying `: FOO BANK-SIZE SYSV ;` — a plain non-`IMMEDIATE` `BANK-SIZE` compiled a call to itself and left the compiler's own outer loop to choke on the following name token, identical to `BANK@`'s M53 bug. Bakes in a resolved `LIT` size rather than raw text, same `S"`/`."` STATE-dispatch pattern `BANK@` already uses. Interactive behavior (`BANK-SIZE SYSV`) is unchanged. | `primitives.ts`, `rebel-opcodes.json`, `bank-access.test.ts`, `02-MEMORY-MODEL.md`, `04-FORTH-CORE.md` |
| **M68** | `GRAPHICS` vocabulary (§1.80): two new primitives, `PLOT`/`POINT` (148/149) — the classic PLOT/POINT pixel pair, `Screen.plot`/`point` resolving `INK` through the active palette before reaching `ScreenHal.drawPixel`/`readPixel` (spec `01-HAL.md` §3.4, `hal_read_pixel` newly added alongside `hal_draw_pixel`). Everything else — `LINE` (Bresenham, `LINE-WIDTH`-driven thick-stroke approximation), `RECT`/`RECT-FILL`, `CIRCLE`/`CIRCLE-FILL` (midpoint circle, no `SQRT`/trig) — is pure Forth in a new `GRAPHICS` vocabulary, `system.fth`, branching off `EDITOR`'s close per `CLAUDE.md`'s "primitives only if necessary" rule. `ARC`/a `MATH` vocabulary deliberately deferred. Hit the `(`-comment-closes-early footgun a fourth time (M46/M48 hit it before) via a nested `(148)`-style aside — every comment in the new section rewritten paren-free. `testTimeout` doubled to 40s (same fix as M48) once the bigger dictionary started tripping the old 20s ceiling on unrelated `EDITOR` tests under full-suite contention. | `screen.ts`, `primitives.ts`, `rebel-opcodes.json`, `canvas-screen-hal.ts`, `remote-board.ts`, `system.fth`, `01-HAL.md`, `screen.test.ts`, `graphics.test.ts`, `vitest.config.ts` |
| **M69** | `\` — rest-of-line comment (§1.81), closing `04-FORTH-CORE.md` §9's own long-deferred "not specified here either" item. Direct fallout from M68's `(`-comment footgun hitting a fourth time: `: \ BEGIN BL WORD NIP 0= UNTIL ; IMMEDIATE`, no new primitive — loops the already-native `WORD` (token 134) until its own "line exhausted" zero-length signal fires. Has no closing token to glue a nested paren onto, so it structurally can't suffer `(`'s failure mode. Caught a real near-miss while writing its own doc comment (the same bug, in the very comment explaining the bug), fixed by paren-free rewriting before it ever ran. | `system.fth`, `04-FORTH-CORE.md`, `comments.test.ts` |
| **M70** | `SEE`/`HIDE` fixed to resolve names via `CONTEXT`, not raw `LATEST` (§1.82) — found by Oliver: both worked on a word in `EDITOR` once `EDITOR DEFINITIONS` had run, but threw `unrecognized word` on the same word after only `USE EDITOR`. Root cause: both predate `VOCABULARY` (M12 vs. M13) and resolve names via native `'`, which walks raw `LATEST`, never updated when M48 split browsing (`CONTEXT`) from compiling (`CURRENT-VOCAB`/`LATEST`) for real. Fixed entirely in `system.fth`: `FIND` relocated next to `WORDS` (near the top of the file) so `SEE`/`HIDE` can resolve names through it via a new `(TICK)` helper, a new shared `SEARCH-ROOT` word, and `XT-NAME`/`HIDE`'s own internal xt-to-entry walks switched from `LATEST` to `SEARCH-ROOT` too. No engine change. | `system.fth`, `see-hide.test.ts` |
| **M71** | `INK`/`PAPER` become real variables (§1.83), Oliver's call, breaking change accepted pre-1.0: `n INK`/`n PAPER` (store, no read) replaced with `n INK !`/`n PAPER !` and the new `INK @`/`PAPER @`, matching the `BASE`/`STATE`/`HERE-ADDR`/`LATEST-ADDR` variable idiom instead of being the one remaining color-consuming-store pair. `Screen.setInk`/`setPaper` deleted (no other callers). | `primitives.ts`, `screen.ts`, `rebel-opcodes.json`, `system.fth`, `screen.test.ts`, `project.test.ts`, `remote-terminal-loopback.test.ts` |

See `PLAN.md` for the decision log and detailed per-milestone build notes.
