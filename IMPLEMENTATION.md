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
word's one-value convention. `Bank.size` (and `name`/`flags`) isn't
returned — left to a future bank-inspection word if a real need shows
up, not built ahead of one.

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
a new Rebel-Sim-first addition, default-on — atomic exclusion during a
flush (`storage.ts`'s `saveAsset()` is genuinely `async`, the
interpreter keeps stepping between awaits) instead of finally wiring up
`DIRTY`, which needs a write-interception point neither side's `@`/`!`
gives it.

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

**A real gotcha, found while testing, still true today:** a tag over 4
characters truncates on write (the fixed field width every real tag
already respects by convention), but `BANK@`'s lookup never truncates
its search string — a bank created with a >4-char tag is only findable
by its first 4 characters. Not new behavior in `BANK@` itself, just the
first time anything could actually create a tag violating the
already-existing convention.

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

See `PLAN.md` for the decision log and detailed per-milestone build notes.
