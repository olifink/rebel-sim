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

Bank sizes are drawn from a small fixed ladder of **size classes** — XS
(4 KiB) through XXL (4 MiB), each 4x the previous — rather than
arbitrary byte counts. Most banks (`SYSV`, `DSTK`, ...) just happen to
be sized in code to match a class already; the ladder's real payoff is
loading a file of unknown length (§1.22): round its size up to the
smallest class that fits, and that's the bank's size — a lookup, not a
calculation.

*Implementation:* `BankTable` (`banks.ts`) — `createBank(tag, size,
name?)` / `findBank(tag, name?)` / `findBankByName(name)` /
`roundToSizeClass(bytes)`. Current banks (in creation order): `SYSV`,
`DSTK`, `RSTK`, `DICT`, `CHAR` (§1.16), `KMAP` (§1.21), plus whatever a
project's `openProject()` call creates (§1.22). `SCRN` — the pixel
framebuffer — is deliberately **not** one of these; see §1.17.

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
truecolor values, not palette indices — matching Rebel-ROM's likely
default mode, and meaning no palette table exists anywhere.

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

**Why storage operations are plain async functions, not Forth
primitives:** every other subsystem (screen, keyboard) is driven by
synchronous primitives dispatched through the same `switch` as `DUP`/
`+`. Storage deliberately isn't — persistence only ever happens at
*project open/close* time, as an explicit, host-triggered operation, not
on every individual memory read/write a Forth program makes. Once a
project's banks are loaded, Forth code just reads and writes them
directly, the same as any other bank — no storage-device call hides
behind an ordinary `@`/`!`.

*Implementation:* `storage.ts` — the `Storage` class (`openProject`,
`saveAsset`, `loadCart`, `saveCart`), all `async`. Talks to a
host-supplied `StorageHal` (`ensureDir`/`listFiles`/`readFile`/
`writeFile`) rather than any browser API directly — in
`packages/app`, `OpfsStorageHal` backs this with the Origin Private File
System. `runStorageSelfTest()` is a standalone round-trip proof (write a
byte-pattern bank, save it, reload it fresh, compare) that `app.ts` runs
once at startup, surfaced as a small `storage: OK`/`FAILED` status line.

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
established for OPFS storage).

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
`pausedAtWord`), `app.ts` (`pausedAtBreakpoint`, five `debug_*` tools).

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
| **Ink / Paper** | Foreground / background color for a character write. Raw 24-bit truecolor in Rebel-Sim, not a palette index. |
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
| **Size class** | One of a fixed ladder of bank sizes (XS 4 KiB through XXL 4 MiB, each 4x the previous). A loaded file's bank size is looked up (round up to the smallest class that fits), not calculated. |
| **`StorageHal`** | Rebel-Sim's HAL interface for project/cart file I/O: `ensureDir`/`listFiles`/`readFile`/`writeFile`. Backed by OPFS in `packages/app`; defaults to a no-op (`NULL_STORAGE_HAL`) so engine tests don't need a real filesystem. |
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
| **M5** | Storage: the real projects/carts model (§1.22) — `Storage` class, `StorageHal`, OPFS backing, bank identity retrofit (`name` vs. `tag`, §1.5), size classes, `runStorageSelfTest()`. Superseded `FORTH-ARCHITECTURE.md`'s original raw-block/`SCRS` framing, per that doc's own resolved divergence note. | `storage.ts`, `opfs-storage-hal.ts` |
| **M6** | PWA packaging — `packages/app` only, no engine changes. Angular's own PWA schematic (manifest, service worker, precaching), an on-brand icon set generated from the real `font-zxspectrum.ts` 'R' glyph, `navigator.storage.persist()`. Verified offline-bootable against a real production build, not just unit tests. | `packages/app/public/manifest.webmanifest`, `ngsw-config.json`, `app.config.ts` |
| **M7** | Execution loop & `Channel` binding (§1.23-§1.24) — `executeXT` became a resumable generator, blocking `KEY` suspends instead of throwing, `Machine.beginLine()`/`step()`/`interpret()`. Main-thread generator model chosen over a Web Worker (faithful to both hardware targets' cooperative execution). Sets up M9 (remote/WebMCP channel) to need zero interpreter changes. | `channel.ts`, `inner.ts` (rewritten), `repl.ts` (rewritten) |
| **M7a** | On-screen REPL (§1.25) — `ACCEPT` (a second, multi-step blocking primitive built the same way as `KEY`), `TIB` bank, `Machine.startRepl()`/`replLoop()`. `packages/app`'s DOM `<input>`/`<form>`/`.log` retired entirely — the whole page is the terminal now, keyboard routing no longer gated on any element's focus. | `inner.ts` (`accept()`), `repl.ts` (`startRepl`) |
| **M8** | Core vocabulary (§1.26-§1.29, 61 new primitives, tokens 32-92): memory access, return-stack words, control flow (`BRANCH`/`0BRANCH` + the `IF`/`BEGIN`/`DO`/... IMMEDIATE compiler words), `CREATE`/`DOES>` (two more Code Field sentinels, `DOVAR`/`DODOES`), strings (`S"`/`."`, scoped to single-token literals — a real tokenizer limitation, documented not hidden), and the remaining stack/arithmetic fillers. `FLAG_COMPILE_ONLY` (reserved since M2) finally enforced. `WORDS`/`VLIST` (`CORE-VOCABULARY.md` §12's own sufficiency check) runs correctly on nothing but this vocabulary, proving it's actually enough. | `primitives.ts`, `inner.ts`, `dictionary.ts`, `rebel-opcodes.json` |
| **M9** | Remote channel / WebMCP (§1.30): `RemoteChannel`/`CompositeChannel` merge remote input with the keyboard into one shared session — no interpreter changes, exactly as M7's `Channel` design intended. No server: the page registers tools via the real WebMCP browser API (`document.modelContext`, Angular's `declareExperimentalWebMcpTool`) — `type` plus five reads over the M8 inspector panel's existing introspection. Initial design assumed a bespoke bridge server; corrected after review, see `PLAN.md`. | `channel.ts`, `repl.ts`, `app.ts` |
| **M10** | Word-level breakpoints (§1.31): a third `StepSignal`/`StepStatus` value, `'breakpoint'`, reusing M7's exact suspend/resume shape — checked at the four "about to thread into a compiled word's body" sites in `inner.ts`. Breakpoints are a session-local `Set` on `Machine`, not a dictionary header flag (that byte's fully packed). Five new WebMCP tools; the one required app-side change was `App.startPump`'s `tick()`, which previously ignored `step()`'s return value entirely. | `inner.ts`, `repl.ts`, `app.ts` |

See `PLAN.md` for the decision log and detailed per-milestone build notes.
