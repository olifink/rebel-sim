# Rebel-Sim: Developing & Writing Code

Status: **Living/exploratory document.** Unlike `DEBUGGING.md` (a single
fully-scoped milestone), this tracks a connected set of ideas around
*how source gets written, kept, and refined* — starting from one
concrete, buildable-now piece (§2, comment retention — **done, M11**)
and opening outward into things that are real but genuinely not
designed yet. §3 (`SEE`) and §6 (the system-vocabulary loading
mechanism it shipped alongside) are also **done, M12** — see `PLAN.md`
for both. §4/§5 (screens, baking) remain future, blocked on
infrastructure that doesn't exist yet. §7 (`S"`/`."` real
interpret-time behavior) is open, not yet built — a genuine low-level
Forth correctness gap, split off and kept after dropping a larger
Canon Cat `tForth`-inspired exploration of interactive compile-only
execution that turned out to belong at a higher (editor-UI) layer than
this document is currently working at. §8 (`VOCABULARY`/`USE`) is also
**done, M13** — a branching-chain mechanism needing one new primitive
(`LATEST-ADDR`), otherwise pure Forth source, same M12 precedent —
its own decluttering follow-up (§8.5) turned out to need a different
tool than vocabularies entirely, `HIDE`, **done, M14**.
Expect this to grow across several sessions as that infrastructure
actually gets built, rather than being written once and left alone.

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

**Sharper than "imprecise," confirmed while building `SEE` (M12):**
leading/trailing whitespace that isn't glued to a real content
character isn't just normalized, it's lost entirely. `." : "` (meant
to print a leading and trailing space around a colon) tokenizes to
`:` and a bare `"` — the "content" of that closing token, once its
delimiter is stripped, is empty, so there's nothing for the rejoin
logic to preserve. The practical fix used throughout `system.fth`:
don't put a space adjacent to the opening/closing delimiter inside a
`."`/`S"`/`(` — emit it separately (`." :" 32 EMIT` rather than
`." : "`). Not a bug to fix in the tokenizer for this pass (would need
a genuinely different, raw-character-stream-based parser, a bigger
lift than anything scoped here) — just a real, sharp edge to know
about before writing more system-vocabulary source.

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

**Decided for this pass: A** — consistent with this project's "build
the minimum real mechanism, revisit once an actual need shows up"
discipline (`CLAUDE.md`). Reversible (§2.3's B is still there if `SEE`
output ever proves ambiguous in practice), recorded here as the
concrete plan §2.4 implements, not a permanently closed question.

**Correction to this section's earlier framing:** "zero `packages/engine`
changes, only bootstrap Forth source" was imprecise once actually
checked against the code. This repo has no bootstrap-Forth-source
loading mechanism at all yet — `WORDS` (M8) was explicitly "type it in
once M8 ships, no loader dependency," and *every* current word,
including every `IMMEDIATE` one (`IF`/`BEGIN`/`S"`/`.`"`), is a native
primitive in `primitives.ts` with a token id in `rebel-opcodes.json` —
there's no other way for a word to exist yet. `(` will need to become
one more such primitive. What *is* still accurate, and is the part
that actually matters for "no engine change": Option A needs no new
Code Field sentinel and no `inner.ts`/`threadFrom` special-casing —
`(` compiles into ordinary `(SLIT)` + `2DROP` calls, dispatched exactly
like any other compiled word, so the *threading model* genuinely
doesn't change, only the primitive table grows by one entry (same
tier of change M8's `S"`/`IF`/etc. already were, not a new mechanism).

### 2.4 Concrete implementation plan

Verified directly against `interpretExecuting`/`interpretCompiling`
(`repl.ts`): an `IMMEDIATE` primitive found while compiling runs
*right now* (`if (found.immediate) { yield* this.inner.executeXT(found.cfa); }`,
`repl.ts:478`) — the exact mechanism `IF`/`BEGIN`/`S"` already use to
manipulate compiler state (`HERE`/`STATE`) directly from inside a
`primitives.ts` case via `PrimitiveContext`. `(` needs nothing
different, so this is genuinely additive: one new token id, one new
`primitives.ts` case, and — since `S"`/`."` already have the exact
single-token bug §2.2 describes — a small refactor of the existing
`compileInlineString` helper that fixes it for both as a side effect,
not a second mechanism built alongside a first.

**`rebel-opcodes.json`:** one new entry, next available id (currently
92 primitives, so `93`):
```json
{ "id": 93, "name": "(", "immediate": true, "note": "comment: ( ... ) — retained as compiled (SLIT)+2DROP inline data while compiling (DEVELOPING.md §2), discarded (consumed and ignored) while interpreting at the top level" }
```
Not `compileOnly` — unlike `IF`/`BEGIN` (meaningless outside a
definition), `(` must also work loose at the prompt (discard-only,
§2.3's Option A already covers why).

**`primitives.ts`:** split `compileInlineString` (`primitives.ts:74`)
into two pieces — the token-consuming loop (§2.2's generalization,
shared by `S"`/`."`/`(`) and the actual `(SLIT)`-compiling step (shared
by all three, unchanged from today):
```ts
/** Consumes input tokens (nextInputToken) until one ends with
 * closingChar, rejoining with single spaces — §2.2's known limitation:
 * doesn't preserve original whitespace exactly, fine for now. Shared
 * by S"/./( so all three get (and keep) the same multi-word support. */
function consumeQuotedText(ctx: PrimitiveContext, closingChar: string): string {
  let text = '';
  while (true) {
    const rawToken = ctx.nextInputToken();
    if (rawToken.endsWith(closingChar)) {
      return text + (text ? ' ' : '') + rawToken.slice(0, -1);
    }
    text += (text ? ' ' : '') + rawToken;
  }
}

/** Compiles (SLIT) + length + text's bytes inline — the "LIT followed
 * by inline data" convention LIT itself uses, generalized to a byte run. */
function compileSlit(ctx: PrimitiveContext, text: string): void {
  compileCell(ctx, findWord(ctx, '(SLIT)')!.cfa);
  compileCell(ctx, text.length);
  const start = ctx.sysvars.getHere();
  for (let i = 0; i < text.length; i++) {
    ctx.arena.writeByte(start + i, text.charCodeAt(i));
  }
  ctx.sysvars.setHere(alignCell(start + text.length));
}

function compileInlineString(ctx: PrimitiveContext): void {
  if (ctx.sysvars.getState() !== -1) {
    throw new Error('S"/." only work inside a colon-definition for now');
  }
  compileSlit(ctx, consumeQuotedText(ctx, '"'));
}
```
`S"`/`."`'s existing cases (68/70) call `compileInlineString(ctx)`
exactly as today — genuinely unchanged at the call site, multi-word
support falls out of the refactor for free. New case for `(`:
```ts
case 93: { // ( ( -- ) IMMEDIATE: comment
  const text = consumeQuotedText(ctx, ')');
  if (ctx.sysvars.getState() === -1) {
    compileSlit(ctx, text);
    compileCell(ctx, findWord(ctx, '2DROP')!.cfa);
  }
  // else: interpreting at the top level — consumed and discarded,
  // nothing to compile into, matches classic Forth's ( ... ) here.
  break;
}
```

**`inner.ts`/`dictionary.ts`/`repl.ts`: no changes.** `(` is discovered
via the same `findWord`/dictionary-entry path every primitive already
uses; nothing about tokenization, the outer loop, or the threading
model needs to know `(` exists.

### 2.5 Verification plan

- A comment inside a definition compiles without corrupting what
  follows it, and has zero runtime stack effect when the word is
  called (`(SLIT)` pushes, `2DROP` immediately un-pushes).
- A multi-word comment (spaces preserved via the token-rejoin) parses
  and stores correctly — and, as a direct check on §2.4's refactor, a
  multi-word `S"`/`."` string now works too (`S" hello world"`, a case
  that threw/misparsed before this).
- A comment immediately before `;` doesn't interfere with `;` correctly
  closing the definition.
- A comment typed loose at the prompt (interpreting, `STATE = 0`) is
  silently discarded — no stack effect, no dictionary change, no error.
- An unterminated comment (`(` with no matching `)` before input ends)
  throws the same "expected a name, but the input ended" error
  `nextInputToken()` already raises for any other exhausted-input case
  — not a new error path to build.
- Explicitly *not* tested (out of scope, see §2.6): nested `(` inside a
  comment — classic Forth's `(` doesn't nest either, and this isn't a
  new limitation being introduced.

### 2.6 Explicit scope cuts for this pass

- **No `\` (rest-of-line comments)** — still open, §2.7 (renumbered
  from the previous §2.4) is unchanged by this plan.
- **No nested `(`** — matches standard Forth; a `)` inside a comment's
  text has no special meaning, the first `)` always closes it.
- **No byte-exact whitespace preservation** — §2.2's already-documented
  limitation, unchanged.
- **No WebMCP/UI changes.** Comments aren't independently queryable by
  anything yet (no `SEE`) — this pass only makes them *survive*
  compilation, §3's `SEE` is the next milestone that would ever surface
  them to a caller.
- **No `SEE` itself** — §3 remains sketched, not designed, exactly as
  before.

### 2.7 `\` (rest-of-line comments) — open question, not decided

Classic Forth's `\` comments out everything to the end of the current
line — typically used for source-file bookkeeping (a screen's header
line, a TODO) rather than being part of a word's semantic content the
way an inline `( ... )` explaining a tricky line is. Worth deciding
once screens exist (§4) whether `\` should get the same retain-as-data
treatment as `(`, or stay genuinely discarded as a different, lesser
kind of comment. Not resolved here — flagged so it isn't silently
assumed either way.

## 3. `SEE` — decompiling a definition — done, M12 (see §6)

`CORE-VOCABULARY.md` §12 already anticipated this: `WORDS` (shipped,
M8) was explicitly framed as proving the dictionary chain-walk
mechanics `SEE` would need, calling `SEE` itself "a bigger lift... worth
doing once `WORDS` proves the chain-walk mechanics work" — that
precondition was met, and `SEE` shipped as Forth source in
`packages/app/public/system.fth`, alongside the loading mechanism
described in §6.

The core mechanism, exactly as sketched: walk a word's Parameter Field
cell by cell, same as `threadFrom` does at runtime, but read-only and
printing instead of executing. Two cases per cell, both built:

- **A call to another word** (a `DOCOL`/`DODOES`/primitive-coded XT):
  resolved back to a name via `XT-NAME`, a reverse chain-walk — given
  a CFA, find the dictionary entry whose own `>CFA` matches it. No
  separate lookup table needed: primitives are boot-installed as real
  dictionary entries too, so one uniform walk covers both user-defined
  and primitive words.
- **An inline-data token** (`LIT`, `BRANCH`/`0BRANCH`, `(SLIT)`):
  special-cased via named constants captured at load time (`' LIT
  CONSTANT LIT-XT`, etc.) — comparing a Parameter Field cell's *value*
  directly against these (not a second dereference the way
  `threadFrom` itself does — a plain-call cell's value already *is*
  the target's `cfa`, so a direct address comparison is sufficient and
  simpler at the Forth level).

**Real bugs caught building this, not just theorized:**
- `XT-NAME`'s first cut leaked the matched entry's own `entry-addr`
  onto the data stack in its found-path before `EXIT` — a genuinely
  silent, session-corrupting bug (every subsequent call, including
  `SEE`'s own loop calling `XT-NAME` repeatedly, inherited an extra
  stray stack item), caught only by explicitly checking `read_stack`
  rather than trusting that correct-looking printed output meant a
  clean stack. Manifested as an apparent runaway/infinite loop in
  `SEE` (corrupted `pfa` tracking, endless "not found" `?` output) —
  diagnosed by isolating `XT-NAME` alone against a known-good
  reference (`'`'s own native `cfa` computation) rather than debugging
  the composed failure directly.
- `." : "` and `." <branch> "` both silently lost their leading/
  trailing spaces — not just imprecisely, but *entirely*, since a bare
  delimiter token (` "` with nothing but whitespace around it) carries
  no content for the rejoin logic to preserve (§2.2's addendum has the
  full explanation). Fixed by moving those spaces to explicit `32
  EMIT` calls instead of embedding them in the quoted string.

**Confirmed, not just predicted:** `FORTH-ARCHITECTURE.md` §9 item 13
flagged that Option A's `(SLIT)`+`2DROP` comment encoding is
ambiguous against a real string a program discards on purpose — `SEE`
on a word containing a `( comment )` now visibly demonstrates exactly
that: `: ANNOTATED ( this is a comment ) 5 ;` decompiles as
`: ANNOTATED "this is a comment" 2DROP 5 ;`, not clean `( ... )`
syntax. Not fixed here — recorded as the first real evidence for that
predicted tradeoff, still not registering as a problem worth a
dedicated `(COMMENT)` token yet.

**Explicit scope cuts, not yet done:** only `DOCOL`-coded (plain
colon-definition) words are decompiled — `CONSTANT`/`VARIABLE`/
`DOES>`'d words print `(not supported)` rather than guessing wrong.
`BRANCH`/`0BRANCH` targets print as a bare `<branch>` placeholder,
not reconstructed `IF`/`THEN`/`BEGIN`/`WHILE` source structure — a
real decompile, not a polished one, matching this project's
minimum-mechanism-first discipline throughout.

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

## 6. System vocabulary source loading — done, M12

The interim step §1 always meant to reach before screens (§4) exist:
words that should live in Forth source rather than as native
primitives — `WORDS`, `SEE` — loaded from a plain host text file,
`packages/app/public/system.fth`, at app startup, rather than typed in
by hand each session.

**Loading is App-layer, not engine-layer**, per `CLAUDE.md`'s
framework-agnostic-engine rule: `App.loadSystemVocabulary()`
(`app.ts`) `fetch()`es the file (relative to `<base href>`, exactly
like the PWA manifest/icons already are — resolves correctly under
both local dev and the GitHub Pages `--base-href /rebel-sim/` deploy,
and is offline-precached by the service worker for free alongside
those same assets) and calls `machine.interpret(line)` once per line,
before `startRepl()`. A colon-definition spanning multiple lines just
works — `STATE` is a persistent sysvar, so a `:` left open at the end
of one `interpret()` call is picked up correctly by the next. Errors
are deliberately **not** caught the way `registerWebMcpTools()`
degrades gracefully — a broken system vocabulary is a bug in *our*
source, not a missing browser feature, and should fail loudly.

**A real constraint discovered, not designed for in advance:**
`Machine.interpret()` (used for loading) has no line-length limit —
it operates directly on a JS string. The *interactive* path (typed at
the on-screen REPL, or via a WebMCP `type` call) goes through
`ACCEPT`, which is capped at `TIB_BANK_SIZE` (128 bytes) — a line
typed interactively that exceeds that gets silently truncated
mid-token by `ACCEPT` itself (not an engine bug — `abortDefinition`
correctly rolls back the resulting broken colon-definition attempt,
same recovery path a plain unrecognized-word error already uses).
Relevant only to *interactively developing* system-vocabulary-style
words at the REPL before committing them to the file — worth splitting
a long definition across a few shorter typed lines while iterating,
same way `system.fth` itself reads more clearly split across lines
regardless.

**Testing:** `app.spec.ts` mocks `fetch` to return the real file's
content read straight off disk (`node:fs`, not a canned fixture
string) rather than a fabricated stand-in, so a test failure here
means the actual shipped file broke, not a stale copy of it — needed
adding `@types/node` as an app-package devDependency (scoped to
`tsconfig.spec.json` only, not the app's own build) purely for this.
No dedicated engine-level tests for `WORDS`/`SEE`'s own Forth-level
correctness — deliberately deferred (there's no established pattern
yet for testing pure-Forth-source content in this repo, and forcing
one now wasn't worth it for two words); verification instead leaned
entirely on live interactive testing against the running REPL via the
Chrome DevTools MCP path, redefining/re-testing each helper word in
isolation before composing the full `SEE` — which is exactly how both
real bugs above were actually found.

*Implementation:* `packages/app/public/system.fth` (`WORDS`, `>CFA`,
`XT-NAME`, the five `-XT` constants, `SEE`), `app.ts`
(`loadSystemVocabulary`), `primitives.ts`/`rebel-opcodes.json` (token
94, `'`/tick — needed once it became clear `SEE`/`WORDS` needed some
way to resolve a typed name to an `xt` at runtime, which nothing in
the existing vocabulary provided).

## 7. `S"`/`."` — real interpret-time behavior — done, M16

Split off from a larger Canon Cat `tForth`-inspired exploration
(interactive execution of compile-only control structures like
`IF...THEN`/`DO...LOOP`) that turned out to belong at a different
layer than this document is currently working at — Canon Cat's actual
mechanism lived in its document editor's "execute this block" command,
a higher-level UI concern, not a low-level interpreter one. Dropped
from scope here rather than carried forward half-considered; this
section keeps only the one piece that's a genuine, already-flagged,
low-level Forth correctness gap in its own right.

`S"`/`."` are `compileOnly: true` (`rebel-opcodes.json`) for an
engine-specific reason, not a Forth semantic — `compileInlineString`
always compiles regardless of `STATE`, and the primitive's own note
already flags this as an interim scope cut ("Throws if used while
interpreting (STATE=0) rather than pretending to support it"). In real
Forth, `S" hello" TYPE` typed loose at the prompt is completely
ordinary: `S"` parses the string and returns `addr len` directly, no
compilation involved.

The fix: give `S"`/`."` real dual-mode behavior — while interpreting,
copy the string into a scratch/transient area and push `addr len`
directly (no `HERE`/dictionary involvement at all); while compiling,
keep compiling `(SLIT)` inline exactly as today. Once fixed this way,
`S"`/`."` genuinely stop being compile-only, so the `compileOnly` flag
should be removed (`immediate` stays — both still need to run at
compile time to do their own parsing/compiling, the same reason
`IF`/`S"` already run immediately while `STATE=-1`).

`S"`/`."` diverge slightly in what "interpreted mode" even means for
them, so they get two separate (short) case bodies rather than one
shared dual-mode helper:

- **`S" ( -- addr len )`** — while interpreting, the string has to
  *outlive* this one primitive call (the caller might pass `addr len`
  to `TYPE`, store it, compare it — anything), so it needs a real
  backing address. Copy the text into the scratch area (below), push
  that area's address, then the length.
- **`." ( -- )`** — while interpreting, nothing needs to survive past
  this call: the whole point is printing immediately. No scratch area
  involved at all — just loop `ctx.screen.emit()` over the parsed
  text directly, same as `TYPE`'s own loop but fed from the JS string
  instead of arena bytes.

### Where the scratch text lives — resolved: a new `PAD` bank

Classic Forth's `PAD` is a small, fixed, "overwritten on next use"
scratch region, entirely separate from any input buffer — real
systems don't double up `TIB` for this. This engine doesn't have a
`PAD` yet; adding one (a new bank, tag `PAD`, 128 bytes — the same
size as `TIB`, plenty for anything typed at the prompt) is the
smallest thing that's still the *actual* mechanism, not a workaround.

**Rejected alternative, considered and set aside:** reuse the existing
`TIB` bank as scratch instead of adding a new one. It would technically
work — by the time a line is being interpreted, `TIB`'s bytes have
already been copied out into the JS token array `tokenizeAndRun` walks
(`repl.ts`), so `TIB` really is idle for the rest of that line's
processing, and nothing currently exposes `TIB`'s base address to
Forth for anything to read stale bytes back out of it. But it makes
"terminal input buffer" secretly also mean "string-literal scratch
area," coupling two call sites (`ACCEPT` and `S"`) through an
implicit "doesn't overlap *today*" invariant rather than a named
contract — the same category of mistake this project caught itself
making with the `VOCABULARY`-based re-filing plan (§8.5): reusing a
mechanism for an adjacent-but-different job, rather than building the
actual right-sized one. A dedicated 128-byte `PAD` bank costs about as
much as `TIB` itself did and keeps each bank's contract to one job.

**Bounds check:** a string longer than the `PAD`'s 128 bytes while
interpreting throws a clear error rather than silently overwriting
whatever bank comes after it in the arena — matching this project's
existing "fail loudly on a scope cut" convention (`ACCEPT`'s
`maxLen`-capped write, `S"`'s own current compile-only throw) rather
than real Forth's usual no-bounds-check `PAD`, which only gets away
with that because it typically sits in unmapped/don't-care memory a
host language wouldn't tolerate silently corrupting.

**A small, free, in-scope addition:** since `PAD`'s address becomes a
real, meaningful thing to have once the bank exists, expose it as an
ordinary primitive, `PAD ( -- addr )` — the same "if it's a real
address, give Forth source a word for it" precedent `HERE`/`LATEST`
already set. Costs one more primitive token, nothing else.

**A real, tested-behavior change, confirmed by checking, not
assumed:** `strings.test.ts`'s `'S" is compile-time only for now —
throws a clear error while interpreting'` asserts today's throw
outright and needs rewriting to assert the new dual-mode behavior
instead — the interim scope cut it exists to document goes away
entirely, not just partially.

**Implementation sketch:**
- `rebel-opcodes.json`: remove `compileOnly` from primitives 68
  (`S"`) and 70 (`."`); add a `PAD` bank tag with a Rebel-Sim-only
  note (same status as `TIB`'s — no shipped Rebel-ROM Phase 11 to
  reconcile against yet); add primitive 97, `PAD ( -- addr )`.
- `repl.ts`: `Machine`'s constructor creates a `PAD` bank (128 bytes,
  same tier as `TIB_BANK_SIZE`) alongside the existing `tibBank`;
  expose its `base`/`size` via two new `PrimitiveContext` fields
  (`padBase`/`padSize`) so `primitives.ts` can bounds-check and write
  into it without needing the whole `Bank` object.
- `primitives.ts`: case 68 (`S"`) and case 70 (`."`) each branch on
  `ctx.sysvars.getState()` — compiling keeps today's `compileSlit`
  (-`+TYPE`-call, for `."`) path unchanged; interpreting takes the new
  path described above. Case 97 (`PAD`) is a one-liner:
  `s.push(ctx.padBase)`.
- `inner.ts`: **no changes.** `SLIT_TOKEN`'s existing "used outside a
  compiled word body" guard is about the `(SLIT)` *runtime helper*
  primitive, not `S"`/`."` themselves — this fix never touches that
  path.

**Verification plan:** rewrite the one throw-assertion test; add
cases for `S"`/`."` used loose at the top-level prompt (not inside a
colon-definition) — `S" hi" TYPE`, `." hi"` — plus one confirming a
compiled definition using `S"`/`."` is completely unaffected (same
`(SLIT)` path as always), and one confirming the `PAD`
bounds-check throws on an oversized interpreted string. Live-verify
in the browser via the `type` WebMCP tool, same as every milestone
since M9.

**Scope cuts, explicit:** no attempt to make `PAD` reentrant/nestable
(`S" a" S" b" TYPE` while interpreting would have the second call
overwrite the first's bytes before they're used — a documented
footgun, not a bug, matching real Forth's own `PAD` contract); no
`WORD`/general tokenizer rework — this only touches `S"`/`."`'s own
two primitive cases.

## 8. `VOCABULARY`/`USE` — multiple named dictionary chains — done, M13; decluttering follow-up done differently as `HIDE`, M14 (see `PLAN.md`)

### 8.1 Motivation

A concrete, already-*observed* pain point, not a hypothetical one:
M12's own system-vocabulary tooling (`SEE`, `XT-NAME`, `>CFA`, the
five `-XT` constants, `WORDS`, `'`) already shows up in every single
`WORDS`/`read_dictionary` listing right alongside whatever the user
defines next — visible in this session's own live-verification
screenshots. As `system.fth` grows (`FORGET`, and whatever else lands
there before the screen editor), this only gets noisier. Classic
Forth's answer is `VOCABULARY`/`USE`: separate, named dictionary
chains, switchable, so system tooling and project/user code don't
have to share one flat namespace. This also matters for this
project's own cart/project model directly — independently-loadable
carts choosing their own internal helper-word names shouldn't be able
to collide with system tooling or with each other.

Scoped to the simpler classic model the request asked for — one
"current chain" you switch with `USE`, not ANS Forth's fuller
`WORDLIST`/`SEARCH-ORDER`/`ALSO`/`ONLY` stack (a separate current-vs-
search-order split). Revisit only if a real need for multi-vocabulary
*search order* (not just switching) shows up in practice.

### 8.2 The real blocker, found by re-checking, not assumed — the same one `FORGET` hit

`HERE`/`LATEST` (`primitives.ts` cases 59/60) are read-only from
Forth: `s.push(ctx.sysvars.getHere())`/`getLatest()`, no write path,
no raw address exposure a `!` could target. `VOCABULARY`/`USE`
fundamentally need to *write* `LATEST` (swap which chain new
definitions extend) — the exact same gap the (now-dropped) `FORGET`
exploration hit.

**Worth naming plainly: this is a departure from Forth tradition, not
a deliberate design position being reconsidered here.** Real Forth
systems typically implement `HERE`/`LATEST`/`STATE`/`BASE` as
ordinary variables, directly `@`/`!`-able by any word — this engine
chose dedicated read-only primitives instead (an M1/M2-era decision,
apparently never revisited until a real need — this one — surfaced).

### 8.3 One general fix, not a bespoke primitive per feature

Rather than a native `setLatest()`-calling primitive built specifically
for this (or, separately, for `FORGET`), expose the sysvar's own
*cell address* — a new primitive, `LATEST-ADDR ( -- addr )`, reusing
the same offset math `Sysvars`' own internal `fieldOffset('FORTH',
'LATEST')` already computes — so ordinary `@`/`!` can manipulate it
directly, exactly like any other memory cell. Unblocks
`VOCABULARY`/`USE` as pure Forth source (matching M12's own
`WORDS`/`SEE` precedent) rather than needing another native primitive
addition. Scoped to just `LATEST-ADDR` for this feature specifically
— not a blanket "expose every sysvar's address" — `HERE-ADDR` would
be `FORGET`'s own concern if that gets picked back up, and
`STATE-ADDR`/`BASE-ADDR` aren't needed for anything scoped so far;
add only when a concrete need shows up, not preemptively.

### 8.4 Mechanism — branching chains, not a search order (rejected alternative noted)

**Considered and rejected: fully independent per-vocabulary chains
with a multi-chain search order at lookup time** (closer to ANS
Forth's model) — this would need `dictionary.ts`'s `findWord` itself
to walk a short *list* of chains instead of one fixed `LATEST`-rooted
walk, a real engine-level change, and the "how many vocabularies get
searched, in what order" question is exactly the complexity the
simpler request was explicitly trying to avoid.

**What actually works, needing zero `dictionary.ts`/`findWord`
changes at all:** each vocabulary is a *branch* off the dictionary
chain at the point it's created, not an independent chain. A
vocabulary word is a plain `CREATE`d cell holding its own remembered
`LATEST` value — `VOCABULARY <name>` ≈ `CREATE <name> LATEST ,` (the
value stored, not zero — it starts as a *continuation* of whatever
chain was current, not empty). `USE <name>` swaps which chain
`LATEST` (the live sysvar) currently extends, saving the outgoing
chain's position back into *its own* cell first:

```forth
VARIABLE CURRENT-VOCAB

: USE
  ' 8 +                \ target vocab's own stored-latest cell address
                        \ (past CREATE's reserved does-pointer cell —
                        \ same +8 offset executeXT's own DOVAR
                        \ dispatch already uses)
  LATEST-ADDR @         ( target-addr current-latest )
  CURRENT-VOCAB @ !     ( target-addr )        \ save outgoing chain's position
  DUP @                 ( target-addr target-latest )
  LATEST-ADDR !         ( target-addr )        \ LATEST := target's remembered chain
  CURRENT-VOCAB !       ( )                    \ remember target as current
;
```

Verified by hand, cell by cell, against this engine's actual `@ (
addr -- x )`/`! ( x addr -- )` stack effects — not hand-waved. This
used the manual `' <name> 8 +` form rather than a cleaner `' <name>
EXECUTE` — at the time, `EXECUTE` genuinely didn't exist (checked, not
assumed — 94 primitives, none named `EXECUTE`). **Resolved, M15:**
`EXECUTE ( xt -- )` now exists (token 96, `IMPLEMENTATION.md` §1.36),
special-cased in `inner.ts` rather than `primitives.ts` since it needs
to recurse into `executeXT` itself — DOCOL/DOVAR/DOCON/DODOES,
breakpoints, and nested blocking all fall out of that for free. `USE`
itself wasn't rewritten to use it (the `8 +` form still works and
isn't broken), but any future indirect-call need in `system.fth` can
now reach for `EXECUTE` directly instead of hand-rolling the offset.

**Why branching gets the actual goal (declutter/isolation) right,
verified by tracing through it, not assumed:** switching to a
*different* branch genuinely can't see words added to another one
(each only remembers its own chain position) — but every branch still
sees everything that existed *before* it split off, so `USE SYSTEM`
doesn't lose access to `DUP`/`DROP`/core words the way a fully
independent chain would. `WORDS` needs **zero changes** to become
vocabulary-scoped for free — it already just walks from `LATEST`,
which now means "whichever chain is currently active."

### 8.5 A real sequencing dependency for `system.fth` — superseded, see `HIDE` (M14)

This section originally sketched re-filing `SEE`/`XT-NAME`/`>CFA`/etc.
into their own `SYSTEM` vocabulary as the decluttering follow-up.
**That plan doesn't actually work, caught before writing any code
for it:** branching chains (§8.4) only let a *later* vocabulary see
an *earlier* one's contents, never the reverse — move `SEE` into
`SYSTEM` and switch back to `FORTH` for normal use, and `SEE` becomes
uncallable without an explicit `USE SYSTEM` first. Sequencing it the
other way (`FORTH` branching *from* `SYSTEM`, inheriting visibility)
doesn't help either, since "found by lookup" and "listed by `WORDS`"
are the exact same chain-walk under this mechanism — there's no way
to get one without the other with vocabularies alone.

**What actually shipped instead, M14:** `HIDE`, reusing `FLAG_HIDDEN`
— the same bit `findWord`/`WORDS` already skip for a colon-definition
mid-compilation, applied permanently instead of temporarily. An
already-compiled caller (`SEE`) is unaffected by hiding a word it
calls, since compiled calls are raw addresses, not names re-resolved
at call time. Pure Forth, zero engine changes, reusing `>CFA`/
`XT-NAME`'s own reverse chain-walk shape. One real constraint that
*is* still a sequencing dependency: every `HIDE` call has to happen
after everything that still needs the target by name during its own
compilation — for `>CFA`/`XT-NAME`/the `-XT` constants, that's after
`SEE` itself, not right after each individual helper (a mistake the
first draft made and testing caught immediately).

`VOCABULARY`/`USE` remain exactly as designed for their own real use
case — project/cart isolation — just not this one.

### 8.6 Open questions

- ~~**Root vocabulary naming/bootstrap.**~~ **Resolved, shipped:**
  `FORTH` is the root vocabulary name; `CURRENT-VOCAB`'s initial value
  is set via a small `system.fth` bootstrap step
  (`VOCABULARY FORTH` `' FORTH 8 + CURRENT-VOCAB !`) right after
  `VOCABULARY`/`USE` are defined — no engine-level help needed,
  confirmed live.
- **`FORGET` interaction:** if `FORGET` (part of the dropped Canon Cat
  exploration, possibly revisited later on its own merits) removes a
  word that some *other* vocabulary's branch point depends on being
  there, what happens to that vocabulary's own chain integrity? Not
  designed — worth a real pass once both features are seriously on
  the table together, not assumed compatible by default.
- **Nested/temporary `USE`:** classic Forth sometimes wants "use this
  vocabulary for one definition, then restore the previous one" — not
  scoped here; the base `USE` as designed and shipped is a plain,
  non-nesting swap.
- ~~**Re-filing `SEE`/`XT-NAME`/`>CFA`/the `-XT` constants into their
  own `SYSTEM` vocabulary.**~~ **Resolved, differently than
  expected, M14:** vocabularies turned out to be the wrong tool for
  this specific goal — see §8.5's rewrite. `HIDE` solved it instead,
  with zero connection to `VOCABULARY`/`USE` at all.


## 9. `ABORT` — done, M17

Originally scoped as a full `THROW`/`CATCH`/`ABORT` exception model
(`FORTH-ARCHITECTURE.md` §9 item 3/14). **Reconsidered and trimmed**:
`THROW`/`CATCH` — and the `ForthError` class hierarchy, ANS-code
bucketing of ~30 throw sites, and new `LAST-ERROR` sysvar that
existed only to serve them — are tabled. This project doesn't need to
track ANS Forth conformance closely, and none of that machinery has a
real consumer without `CATCH` actually existing to use it; building it
speculatively ahead of an actual need is exactly what this project's
own scope discipline (`CLAUDE.md`) warns against. Revisit only if a
concrete need for catchable errors shows up — not by default.

What's still worth building: a classic `ABORT` — empty the data
stack and get back to a clean prompt, callable from Forth source
itself (e.g. `... IF ." bad input" ABORT THEN`), not just something
that happens to you via an uncaught JS exception.

### A genuine, pre-existing bug found while scoping this (confirmed empirically)

`threadFrom()` (`inner.ts`) pushes an rstack sentinel (or, for a
nested `DOCOL` call within the same loop, a return `ip`) with no
`try`/`finally` around the loop that's supposed to pop it back off.
When an exception is thrown from anywhere inside — a primitive, a
stack under/overflow, anything — that push is simply never undone.
Confirmed live, not assumed: defining a word that throws when called,
then repeatedly interpreting it in the same `Machine`, grows
`rstack.depth` by exactly one on every single error (checked: 0 → 1 →
2 across two successive caught errors). Neither `replLoop` nor
`runLine`'s `catch` blocks reset `rstack` (or the data stack) today —
this leak is real, silent, and accumulates forever in a long-lived
session. Worth fixing alongside `ABORT`, since an `ABORT` that clears
the data stack but leaves the return stack quietly corrupted wouldn't
actually deliver "a clean prompt" — the two are the same underlying
fix, not two separate features bundled together.

### Design

One new primitive, **`ABORT ( -- )`, token 98** (next free after
`PAD`, M16), an ordinary `primitives.ts` case — no generator access
needed: `ctx.stack.clear(); throw new Error('ABORT');`. `DataStack`
gains a new `clear()` method (`this.sp = bank.base + bank.size`, i.e.
depth back to 0) — the one new piece of shared mechanism this
actually needs. `ABORT` throwing a plain `Error('ABORT')` (no new
error class) is deliberate: nothing distinguishes it from any other
error without `CATCH` to special-case it, so a dedicated class would
have no consumer — same "don't build ahead of an actual need"
reasoning as tabling `THROW`/`CATCH` itself. Uncaught, it surfaces via
the *existing* `replLoop`/`runLine` catch-and-print path exactly like
every other error already does today (`? ABORT`) — no new display
logic needed.

**`replLoop`'s catch block also gets a stack/rstack clear**, for
*any* uncaught error, not just explicit `ABORT` — this is the actual
fix for the leak above, and it's what makes an ordinary uncaught error
(divide-by-zero, an unrecognized word, anything) behave the same way
`ABORT` does: back to a genuinely clean prompt, not a data stack reset
sitting on top of a silently-growing return stack.

```ts
} catch (err) {
  if (this.sysvars.getState() === -1) abortDefinition(this);
  this.stack.clear();
  this.rstack.clear();
  const message = err instanceof Error ? err.message : String(err);
  this.emitString(`? ${message}`);
}
```

**Deliberately not applied to `interpret()`/`runLine()`** (the
programmatic path `beginLine()`/`step()`/every engine test uses) —
that contract stays exactly as documented today ("throws exactly as
before on a genuine error," no side effects beyond the existing
mid-compile cleanup). Host callers may have real reasons to inspect
post-error stack state. Only the interactive on-screen/WebMCP REPL —
the one place a human or agent is actually typing successive lines
into one long-lived session — gets the new recovery behavior.

### Rejected/tabled

- **`THROW`/`CATCH`, the `ForthError` class hierarchy, ANS-code
  bucketing, and `LAST-ERROR`** — see above. Not rejected as wrong,
  just not worth building without a concrete need driving it; "probably
  not," per direction, unless something later actually needs catchable
  errors.
- **`ABORT"`** — needs its own quoted-string parsing (`S"`-style);
  a separate unit of work regardless, not folded in here either.

### Implementation sketch

- `stack.ts`: new `DataStack.clear()` method.
- `rebel-opcodes.json`: token 98, `ABORT`.
- `primitives.ts`: case 98, `ABORT`.
- `repl.ts`: `replLoop`'s catch block clears both stacks on any
  uncaught error (fixes the confirmed leak generally, not just for
  explicit `ABORT`).

### Verification plan

- New engine test(s): `ABORT` empties a non-empty data stack and
  throws. The `rstack`-leak fix has to be verified through
  `startRepl()`/`replLoop` specifically (a fresh `Machine`,
  `startRepl()`, feed a throwing line via a test `Channel`, `step()`
  through it, then check `rstack.depth === 0`) — the programmatic
  `interpret()` path is explicitly *not* getting this fix, so a test
  asserting the fix must drive it through `replLoop`, not
  `interpret()`.
- Live, via WebMCP: an uncaught `5 0 /` at the prompt leaves
  `read_return_stack`/`read_stack` both empty afterward; an explicit
  `ABORT` after pushing some values does the same.
- Full engine + app test suite and `npm run build` — confirm zero
  regressions, same discipline as every prior milestone.

### Scope cuts, explicit

- No `THROW`/`CATCH`, no `ForthError`, no `LAST-ERROR`, no ANS
  error-code assignments of any kind.
- No `ABORT"`.
- `interpret()`/`runLine()`'s host-facing error contract is unchanged
  — only the interactive `replLoop` gets stack-reset-on-error.

## 10. Forth-visible bank access (`BANK@`) — done, M18

`FORTH-ARCHITECTURE.md` §9 item 4 has flagged this as open since it was
written: whether the bank table needs to become arena-resident memory
Forth walks via raw address arithmetic, or whether an API-mediated
primitive (calling into the host bank table, the way `CBankTable::
FindBank` already exists in C++) is sufficient — "`docs/MEMORY-MODEL.md`
§3.2 explicitly left this as a 'revisit once Forth is actually
reading/writing through it' question." Raised directly (2026-08-02):
shared banks should probably be reachable the same way, by type — which
led to checking whether cross-arena/shared-bank memory access is
enforced anywhere today (below), and then a deliberate call on what to
do about it (2026-08-05, also direct): nothing — see "Isolation: a
confirmed non-goal, not an oversight" below.

### A real finding, checked not assumed: memory-access isolation isn't enforced anywhere today

Checked against `rebel-rom/docs/MEMORY-MODEL.md` §2, directly, not
assumed: *"There is no separate 'special' memory kind from Forth's
point of view; everything is reachable by address"* — no MMU, no
bounds-checking, deliberately ("full read/write... it should feel like
real, physical, fully-accessible memory"). This means `MEMORY-MODEL.md`
§3.7's "isolation as the default" claim for multi-arena is, today, a
*convention* (a task simply isn't handed another arena's base address),
not an *enforcement* — nothing stops a stray or crafted offset from one
arena's Forth code reaching another arena's private `DICT`/`SYSV`, or a
shared bank like `KMAP`, since there's no distinction at the addressing
level once an address is computed. Not flagged anywhere in `rebel-rom`'s
own docs — a genuine finding, surfaced by asking "should shared banks
be `BANK@`-reachable too," not a restatement of something already
tracked.

### Isolation: a confirmed non-goal, not an oversight

Decided directly (2026-08-05), after the finding above was raised:
**this is correct as-is, not a gap to close.** Multiple, independent
Forth sections (arenas), fully accessible to the local user and
machine, with all the risks that implies, is the intended v1 model —
the same "authentic risk" philosophy `MEMORY-MODEL.md` §1 already
states for a *single* arena ("a stray write from Forth can corrupt
Rebel's own programs, screen, or dictionary — that's the intended,
authentic risk") extends naturally to *multiple* arenas once they
exist: a fully-trusted, single-local-user machine has no real
"attacker" for arena isolation to defend against, any more than a
Spectrum's BASIC program needed protecting from another BASIC program
that could never run at the same time anyway. A more security-focused
implementation could enforce real boundaries later — giving
genuinely-shared banks a separate `ArrayBuffer` a per-arena program is
never handed offset-space into is a real option, since `DataView`
already throws a real `RangeError` on any out-of-range offset
(confirmed by checking `arena.ts`: it does zero bounds-checking of its
own, relying entirely on `DataView` for this) — but that's future,
opt-in hardening for a different threat model than this one, and not
designed further here.

### Design direction: API-mediated, not an arena-resident table

With isolation settled as a non-goal, the choice between `BANK@` as a
primitive versus an arena-resident table Forth walks via raw `@`/`C@`
(`FORTH-ARCHITECTURE.md` §9 item 4's two options) comes down to
ordinary implementation economics, not access control: **a primitive
wins on simplicity today.** Rebel-Sim's `BankTable` (`banks.ts`) is a
plain host-side TS array of `{tag, name, base, size}` objects, not
arena-backed data — making it arena-resident would mean inventing a
wire format and writing real descriptor bytes into the arena on every
`createBank()` call, solely so Forth could re-parse them back out
byte-by-byte, when a primitive can just read the existing TS objects
directly. Same shape as `PAD ( -- addr )`/`LATEST-ADDR` (M16/M13) —
expose something the host already tracks via a small primitive, rather
than duplicating it as arena bytes with no other consumer.

**`BANK@ ( "tag" -- addr )`** — parses the next input token
directly (the same `nextInputToken()` mechanism `'`/`CREATE`/`VARIABLE`/
`CONSTANT`/`S"`/`VOCABULARY`/`USE` already all use), not a string
`addr len` off the stack — there's no reason to route a 4-character tag
through `PAD`/`S"` when every other "resolve a source-level name to
something" primitive already has a simpler, established pattern to
follow. Uppercased before lookup, matching `findWord`'s own
case-insensitivity (`dictionary.ts`) — bank tags are always stored
uppercase (`'DICT'`, `'SYSV'`, …). Looks up via `ctx.banks.findBank(tag)`
— first bank of that tag, matching the existing method's own semantics
(tags repeat; name-based disambiguation is a separate, unbuilt need,
see scope cuts). Throws (`? unknown bank: <TAG>`) on no match, same
convention as `'` throwing on an unrecognized word rather than pushing
a sentinel — consistency with the one existing primitive this is
closest to in shape.

**Addr only, not `addr size` — matching the `SOMETHING@` convention
directly (2026-08-05, direct call):** every other `@`-suffixed word in
this dictionary fetches exactly one value (`C@`/`HERE`/`LATEST`/a
sysvar cell read); a two-value stack effect reads as a different kind
of word wearing `@`'s name. `Bank.size` — and `name`/`flags`, the rest
of `Bank`'s `{tag, name, base, size}` shape (`banks.ts`) — simply
isn't returned. `name` needs no exposure yet (the multiple-`DATA`-banks
disambiguation case is a storage/project-loading concern, not a Forth
one); `flags` doesn't exist on Rebel-Sim's own `Bank` interface at all
today (no `RESIDENT`/`EXTERNAL`/`SWAPPABLE`/`DIRTY`). All three are
documented future extensions (a `BANK-SIZE@`/`BANK-NAME@`-style
inspection word, or a fuller descriptor word, once something concrete
needs them) — not built ahead of an actual need now.

### Shared banks: `BANK@` reaches them too, no special-casing

Per the "confirmed non-goal" decision above, `BANK@` doesn't
distinguish "this arena's own bank" from "a shared bank" at all — it
finds any bank, arena-private or shared, by tag, uniformly. Rebel-Sim
has zero multi-arena support today anyway (`Machine`'s constructor
creates exactly one `Arena`, unconditionally, `HAL.md` §3), so every
bank `BANK@` can find lives in the one arena that exists regardless;
once multi-arena lands, this stays exactly this simple by design, not
by omission — no per-arena filtering to add later, because none is
wanted.

### Implementation sketch

- `rebel-opcodes.json`: one new primitive, `BANK@`, next free token.
- `primitives.ts`: `PrimitiveContext` gains a `banks: BankTable` field
  (mirrors the `padBase`/`padSize` precedent, M16); one case, parsing
  the token, uppercasing, calling `ctx.banks.findBank()`, pushing
  `addr`/`size` or throwing.
- `repl.ts`: `Machine` already has `readonly banks: BankTable` — just
  needs to satisfy the widened `PrimitiveContext` interface, which it
  already does structurally (no constructor change needed).
- No `inner.ts` change — this is a plain synchronous case, same
  category as `PAD`/`LATEST-ADDR`, not `EXECUTE`/`CATCH`.

### Verification plan

- New engine tests: `BANK@` against known banks (`SYSV`, `DICT`, `TIB`,
  `PAD`, …) returns the same `addr`/`size` `getAllBanks()`/`findBank()`
  already report; an unknown tag throws; two same-tag banks (once
  something creates one, e.g. a future `DATA` asset) resolves to the
  *first*-created one, matching `findBank`'s documented semantics, not
  silently picking an arbitrary one.
- Live, via WebMCP: `BANK@ DICT .` etc., cross-checked against
  `read_banks`'s existing output for the same bank.
- Confirm `read_banks` (WebMCP tool, host-side) is unaffected — it
  already reads `getAllBanks()` directly and needs no change.

### Scope cuts, explicit

- No name-based lookup (`BANK@` resolves by tag only, first match —
  same as `findBank(tag)`'s existing one-argument semantics today).
- No `size`/`name`/`flags` returned — `BANK@` pushes `addr` only,
  matching every other `SOMETHING@` word's one-value convention. A
  separate bank-inspection word can add any of these later if a real
  need shows up.
- No shared-bank / cross-arena access control of any kind — decided
  directly, not deferred: full mutual accessibility across arenas is
  the intended v1 model, not a gap. A future security-focused variant
  could add real enforcement (e.g. a separate `ArrayBuffer` for shared
  banks); explicitly out of scope for this design.
- No arena-resident bank table (the rejected direction, reasoning
  above) — API-mediated only.
- Not implemented ahead of an actual need. This scoping exists so the
  shape is right *when* a need appears (multi-arena landing, or a Forth
  program wanting to dynamically discover another bank's extent),
  matching this project's standing "minimum real mechanism, don't build
  ahead of a concrete need" discipline (`CLAUDE.md`).

## 11. Arena-resident memory map (`MMAP`) — done, M19 (mirror only — see below)

Grew out of two threads from the same conversation (2026-08-05): a
question about whether preserving live system state is as simple as
copying out the arena's used bytes (it mostly is, but `BankTable` being
host-side TS was flagged as a real gap — you can't reconstruct bank
layout from raw bytes alone), and a separate observation that this
project's `DIRTY` bank flag can't actually work as designed, because
Forth's `@`/`!` gives no write-interception point to hook it from. Both
threads converge on the same fix: make the bank table itself arena-
resident, so it's just more bytes both a snapshot and Forth source can
read directly, and replace change-detection (`DIRTY`, which needs
write-interception this engine deliberately doesn't have) with a
cheaper, real primitive — atomic exclusion during flush.

**This directly reopens §10's "API-mediated, not an arena-resident
table" call for `BANK@`, not something layered cleanly on top of it.**
That section chose a primitive specifically because "`BankTable` is
plain host-side TS, not arena-backed data... inventing a wire format
[had] no other consumer." Portability, Forth-side bank creation, and
the persistence-snapshot gap are exactly the "other consumer" that
tips the balance now — worth being honest that this walks back a
decision from days earlier, not that it was wrong then.

### A genuine precedent, found not assumed: this was the original plan

Checked directly against `rebel-rom/docs/MEMORY-MODEL.md` §3.2, not
assumed: the bank table living inside the arena, not as a host object,
was **the original design** — Phase 3 deliberately simplified away from
it, and said so explicitly at the time: *"the table itself is a plain
C++ object owned by the kernel (`CBankTable`)... rather than data
living inside the arena **as originally sketched here** — simpler for
now, and nothing stops moving it into the arena later (**Phase 11**) if
Forth ever needs to inspect it via raw address arithmetic rather than a
primitive calling into `CBankTable`'s API."* Phase 11 — the Forth
executor — is exactly what doesn't exist on that side yet and what
Rebel-Sim exists to design ahead of (`CLAUDE.md`). This isn't new
complexity being invented; it's returning to the original sketch now
that the thing it was waiting for (a real Forth side needing raw
address access) has arrived, here first.

### Also checked: `rebel-rom`'s bank table isn't arena-resident either, today

Confirmed by reading `rebel-rom/src/membank.h` directly: `CBankTable`'s
`CBank m_Banks[BANK_TABLE_MAX_BANKS]` is a plain member array on the
`CBankTable` object itself, living outside the memory range
`Initialize(pArenaBase, pArenaSize)` claims as the arena. So both real
implementations independently duplicate "host owns a bank descriptor
array" today — a TS array here, a C++ array there — which is exactly
the kind of duplication `CLAUDE.md`'s "single source-of-truth artifact"
goal says to flag rather than let drift. `MMAP` replaces both
independent copies with one shared, portable contract instead of adding
a third form on top.

### Also checked: `DIRTY` is genuinely inert on the `rebel-rom` side, not just here

`rebel-rom/src/membank.h`: `BankFlagDirty = 1 << 3 // reserved - still
inert`. Grepped `rebel-rom/src/*.cpp`/`*.h` for `BankFlagDirty` and any
flag-setting call — zero real usage anywhere, confirmed not assumed.
This directly contradicts `rebel-rom/docs/STORAGE.md` §6's own text
("closing a project writes back only the banks marked dirty... Phase 9
is what finally wires that flag up to do something") — a real,
pre-existing doc/code mismatch on that side, found while checking this,
worth fixing there independently of anything here.

### Design: `MMAP` as bank 0

`MMAP` becomes the very first bank created — at absolute arena base 0,
ahead of even `SYSV` (today's first bank). Every other bank's base
offset shifts down by `MMAP`'s own fixed size as a direct consequence;
harmless, since addresses are always per-arena offsets
(`FORTH-ARCHITECTURE.md`) and nothing in this codebase hardcodes a
bank's absolute base — but worth naming, since `SYSV` no longer sitting
at address 0 could otherwise surprise.

A small header, mirroring `Sysvars.initHeader()`'s existing
magic-plus-version pattern (`sysvars.ts`) rather than inventing a new
convention: magic `'M','M'`, a version byte, a reserved byte, then two
cells — **next-free offset** and **slot count in use** — the arena-
resident equivalent of `BankTable`'s private `nextFree` /
`CBankTable`'s `m_nNextOffset`/`m_nCount`. This is what actually makes
Forth-side bank creation possible: a word creating a bank reads the
next-free cell to know where to place it, writes a descriptor, then
advances that same cell — no host round-trip needed for either step.

Followed by a **fixed 64 slots** — matching `rebel-rom`'s existing
`BANK_TABLE_MAX_BANKS = 64` exactly, not a separately-chosen number, so
the two sides start aligned rather than needing reconciliation later.
64 also already doubles as a soft cap on simultaneously-loaded project
assets (`docs/STORAGE.md`'s one-file-per-bank model), so it's a real
constraint either side would hit at the same point.

### Slot layout — proposed here, not finalized, pending `rebel-rom`-side input

Each slot: `tag` (4 bytes) + `name` (8 bytes) + `base` (4-byte cell) +
`size` (4-byte cell) + `flags` (4-byte cell) = 24 bytes, cell-aligned.
Matches this project's actually-*built* `Bank` shape (`banks.ts`:
`{tag, name, base, size}`, raw byte `size`) rather than
`MEMORY-MODEL.md` §3.2's older `size_class`-only sketch — `CBank`
itself already stores a raw `size_t m_nSize` too (`GetSize()`), so raw
bytes is what both sides actually implemented, `size_class` was only
ever the size *requested* at creation time.

**Deliberately not finalized as a byte-for-byte spec here.** `CBank`'s
real `tag`/`name` accessors return null-terminated C strings
(`GetTag()`/`GetName()`) via manual `char[]` fields, not a pre-agreed
fixed wire format — a native C++ struct's own layout/padding isn't
automatically wire-compatible with a hand-specified byte scheme just
because the field sizes match on paper. Whoever implements this on the
`rebel-rom` side needs to make that call for real (almost certainly an
explicit serialize/deserialize into this exact byte layout, not
treating `CBank` as directly memory-mapped) — which is exactly why this
gets written up in `rebel-rom/CHANGES.md` too, not decided unilaterally
here and presented as settled.

### `ACTIVE`, not `DIRTY` — atomicity instead of change-detection

One new flag bit, `ACTIVE` (`1 << 4`, next free after `rebel-rom`'s
existing `RESIDENT`(0)/`EXTERNAL`(1)/`SWAPPABLE`(2)/`DIRTY`(3) — those
four stay exactly as reserved/inert as they are today on both sides;
nothing here wires them up). Default on, same as `RESIDENT`.

This is a real, concrete need in Rebel-Sim specifically, not a
speculative addition: `storage.ts`'s `saveAsset()` is genuinely
`async`, while the interpreter keeps stepping on `requestAnimationFrame`
ticks between `await`s — a save spanning one of those awaits could
observe a half-written bank if Forth resumes and mutates it mid-flush.
A single-bit flag flip is atomic at the memory level (one aligned
write), so "the host skips inactive banks when flushing, Forth flips a
bank inactive before a multi-step mutation and flips it back on after"
is a cheap, real guarantee.

`ACTIVE` isn't standing in for what `DIRTY` was supposed to do — it's
replacing the need for it. Change-detection (does this bank differ from
what's on disk) stays unsolved on purpose, matching what both sides
already do in practice (`storage.ts`'s `saveAsset()` already "always
persists whatever bank you hand it" — see §10's earlier note); `ACTIVE`
just makes that safe under concurrency instead of trying to make
persistence smarter.

### No host validation, by design — same stance as arena isolation

Extending the same "confirmed non-goal, not an oversight" position §10
already settled for cross-arena access: if Forth writes a bad
descriptor into `MMAP` — overlapping `base`/`size`, a corrupted
next-free cursor, a duplicate `name` — nothing stops it or detects it.
The host reads whatever's actually there. Bank *lookup* and bank
*creation* both become "trust `MMAP`" operations, uniformly; deciding
this on purpose here rather than discovering it as a gap later.

### Follow-on, not resolved in this scoping pass: `BANK@` and `Machine.banks`

Once `MMAP` is real, `BANK@` (M18) no longer needs to call into a host
`BankTable` — it could become a plain Forth definition walking `MMAP`'s
slots via `@`/`C@`, the same "native primitive only where actually
needed" precedent `WORDS`/`SEE` already set (M12). Likewise,
`Machine.banks`/`BankTable` (TS-side) might become a read-only cache
derived from `MMAP`, or go away in favor of always reading `MMAP`
directly. Left open — downstream of `MMAP` existing at all, not a
prerequisite for scoping it.

### What shipped (M19)

A new module, `mmap.ts`, holding `MemoryMap` (the arena-byte accessor —
`initHeader()`/`getNextFree()`/`getSlotCount()`/`addBank()`/`getSlot()`/
`getAllSlots()`) and the wire-format constants (`MMAP_TAG`,
`MMAP_MAX_SLOTS = 64`, `MMAP_SIZE`). `BankTable`'s constructor
(`banks.ts`) reserves `MMAP`'s fixed space first, writes its header, and
registers + mirrors itself into its own slot 0, before any caller ever
gets to run — the self-referential bootstrap resolved exactly as
sketched above. Every subsequent `createBank()` call (`banks.ts`) mirrors
its result into the next free `MMAP` slot and advances `MMAP`'s own
next-free cell, in addition to (not instead of) the existing host-side
`banks` array — `findBank()`/`getAllBanks()` are unchanged, still read
that array directly, exactly matching the "mirror only, not yet the
source of truth" scope this section always described. `Bank` gained a
real `flags` field (`BankFlagResident`/`BankFlagExternal`/
`BankFlagSwappable`/`BankFlagDirty`/`BankFlagActive` — the first four
matching `rebel-rom`'s real `TBankFlags` bit-for-bit, `ACTIVE` the new
Rebel-Sim-first addition), defaulting to `RESIDENT | ACTIVE`, resolving
the "nothing real to return yet" scope-cut §10 left open for it.
`createBank()` also gained an optional fourth `flags` parameter,
matching `CBankTable::CreateBank`'s own `nFlags = BankFlagResident`
default-parameter shape.

**A real implementation bug worth recording:** the first pass had
`mmap.ts` importing `BANK_NAME_LEN` from `banks.ts` while `banks.ts`
imports `MemoryMap` from `mmap.ts` — a circular ES module dependency
that left `BANK_NAME_LEN` `undefined` at `mmap.ts`'s module-init time,
silently corrupting every slot-offset computation downstream (surfaced
as a baffling "MMAP is full (64 slots)" thrown on the *ninth* bank
ever created). Fixed by hardcoding the matching value (`8`) directly in
`mmap.ts` with a comment explaining why, rather than importing it —
`mmap.ts` needed the number, not any actual behavior from `banks.ts`.

**Forth-side bank creation and rewriting `BANK@`/`Machine.banks` to
read `MMAP` directly are still real follow-on work, not done here** —
see the section above; nothing about M19 changes that boundary.

### Verification

- Engine tests, `mmap.test.ts` (new, 8 tests) + two existing tests
  updated for `MMAP` always being bank 0 (`banks.test.ts`'s
  `getAllBanks` test, `stack.test.ts`'s hand-rolled tiny arena needing
  room for `MMAP`'s own fixed overhead now): `MMAP` created
  automatically as bank 0 at base 0; it registers itself in its own
  slot 0 correctly; `getNextFree()` tracks the real allocation cursor
  as banks are created; every created bank mirrors into `MMAP` in
  creation order, matching `getAllBanks()` field-for-field; a
  caller-supplied `flags` value is respected and mirrored; the table
  throws once all 64 slots are used; every bank `Machine` itself
  creates (including `MMAP`) ends up correctly mirrored; a slot is
  readable directly via raw `@` from Forth source and matches what
  `BANK@` resolves for the same bank.
- Live, via WebMCP: `read_banks` after a fresh `Machine` shows `MMAP`
  as bank 0 at `0x0000`, sized `1.51 kB`, with every other bank's base
  shifted accordingly (`SYSV` now at `0x060C`, matching `MMAP_SIZE`
  exactly); a raw Forth `@` walk of `MMAP`'s `DICT` slot
  (`108 12 + @`/`108 16 + @`) printed `13836 65536`, matching
  `read_banks`' own `DICT` row exactly — proving the mirrored data is
  correct, read purely from arena bytes, no host round-trip. Zero
  console errors.
- Full engine (208 tests) + app (10 tests) suites and `npm run build`
  green, zero regressions.

### Scope cuts, explicit

- No host validation of Forth-written `MMAP` data, of any kind —
  decided directly, not deferred, same reasoning as arena isolation.
  (Moot for M19 specifically — only the host writes `MMAP` today.)
- No change-detection / real `DIRTY` implementation — superseded by
  `ACTIVE`, not built alongside it.
- No change to `RESIDENT`/`EXTERNAL`/`SWAPPABLE` semantics on either
  side.
- No rewrite of `BANK@` or `Machine.banks` to read `MMAP` — real
  follow-on work, not required to land `MMAP` itself.
- No Forth-visible bank-creation word — `MMAP` is written by the host
  only, for now; nothing yet lets Forth source create a bank.
- Exact slot byte layout not finalized as a cross-target contract —
  what Rebel-Sim actually built is documented above and mirrored into
  `rebel-rom/CHANGES.md`, but still needs that side's real agreement
  once `rebel-rom` picks this up.

## 12. `BANK@` reads `MMAP` directly — done, M20

### Motivation

§11 landed `MMAP` as a mirror only — `BANK@` (M18) still calls
`ctx.banks.findBank(tag)`, the host-side TS array, even though the
exact same data now also sits in arena bytes. This is the smaller,
more contained half of §11's "Follow-on, not resolved" note (the
other, larger half — letting Forth source *create* a bank — needs real
allocation/validation design decisions and stays separately scoped,
not touched here). This is purely a **read-path swap**: same observable
behavior, different implementation underneath.

### Design

- `MemoryMap` (`mmap.ts`) gains one new method:
  `findBankAddr(tag: string): number | undefined` — walks `getSlot(i)`
  for `i` in `0..slotCount`, returns the first slot's `base` whose
  `tag` matches, `undefined` if none. Mirrors `findBank(tag)`'s exact
  "first match, in creation order" semantics, since `MMAP`'s slots are
  written in that same creation order (M19's own test coverage already
  confirms this).
- `primitives.ts`'s case 99 (`BANK@`) changes its one lookup line from
  `ctx.banks.findBank(tag)` to `ctx.banks.mmap.findBankAddr(tag)` —
  everything else about `BANK@` (parsing via `nextInputToken()`,
  uppercasing, the `? unknown bank: <TAG>` error, not being
  `IMMEDIATE`) stays exactly as it is.
- `PrimitiveContext`'s shape doesn't change — `banks: BankTable` was
  already there (M18); this only changes what `BANK@`'s single call
  site does with it (`ctx.banks.mmap` instead of `ctx.banks` directly).
- No change to `BankTable.findBank()`/`getAllBanks()` themselves — they
  keep reading the host array. This scoping is specifically about
  `BANK@`, not a blanket migration of every `BankTable` consumer
  (`storage.ts`, the app's `read_banks` WebMCP tool included).

### Why this is safe, not just probably-fine

`MMAP` is a verified-correct mirror of `BankTable`'s own array — M19's
test suite already confirms every host-created bank ends up in `MMAP`,
in the same order, with matching fields. Since `BANK@`'s current
behavior already *is* "first bank of that tag, in creation order," and
`MMAP`'s slots are written in that exact same order, `findBankAddr()`
and `findBank()` are guaranteed to return equivalent results for every
bank that exists today. `BANK@ SYSV` returns the identical address
either way — the entire, unmodified `bank-access.test.ts` suite passing
against the new lookup path is the actual proof of that, not just an
argument for it.

### Verification

- `bank-access.test.ts`'s existing 7 tests all passed completely
  unmodified, exactly as predicted — the primary evidence this was a
  safe migration, not a behavior rewrite.
- New tests, `mmap.test.ts`: `findBankAddr()` resolves a known tag to
  the same base `findBank()` reports; returns `undefined` (not a
  throw) for an unknown tag; resolves the first-created bank when a
  tag repeats, matching `findBank(tag)`'s own semantics; and a direct
  check that `BANK@ SYSV`'s result equals `findBankAddr('SYSV')`,
  confirming the primitive is actually using the new path, not just
  coincidentally agreeing with it.
- Live, via WebMCP: `BANK@ SYSV . BANK@ DICT . BANK@ PAD .` printed
  `1548 13836 84796`, matching `read_banks`' own rows exactly;
  `BANK@ NOPE` still printed `? unknown bank: NOPE`, unchanged. Zero
  console errors.
- Full engine (212 tests) + app (10 tests) suites and `npm run build`
  green, zero regressions.

### Scope cuts, explicit

- No Forth-side bank creation — the separate, larger follow-on named
  in §11, not touched here.
- No change to `findBank()`/`getAllBanks()` or any other `BankTable`
  consumer — they keep reading the host array; this is `BANK@`-specific.
- No removal of `BankTable`'s own `banks` array or `findBank()` method
  — still real, still used elsewhere. `MMAP` isn't replacing
  `BankTable`, just becoming `BANK@`'s particular read path.
- No `PrimitiveContext` shape change — no new field, no API churn
  beyond `BANK@`'s single call site.

## 13. Forth-side bank creation (`CREATE-BANK`) — done, M21

### Motivation

The second, larger half of §11's original "Follow-on, not resolved"
note, and the harder-to-walk-back half: §11's own design already
committed to "no host round-trip needed" for creation, not just
lookup — *"a word creating a bank reads the next-free cell to know
where to place it, writes a descriptor, then advances that same cell
— no host round-trip needed for either step."* This section makes that
concrete rather than reopening whether it's the right call.

### Design

One new primitive, **`CREATE-BANK ( size "tag" -- addr )`** — pops
`size`, parses the next input token (same `nextInputToken()` mechanism
`BANK@`/`'`/`CREATE` already use), uppercases it, and calls
`ctx.banks.mmap.addBank(tag, tag, base, size, flags)` directly —
**the exact same `MemoryMap.addBank()` method `BankTable.createBank()`
already calls internally (M19)**, just invoked straight from a
primitive instead of through the host. `base` is read fresh via
`mmap.getNextFree()` immediately before the call; `flags` defaults to
`RESIDENT | ACTIVE`, matching every other bank's default. Not
`IMMEDIATE`, same reasoning as `BANK@`/`'` — consumes its input-cursor
token at runtime.

**Name equals tag, truncated to 8 bytes — no auto-serial scheme, no
uniqueness check.** `BankTable`'s own `generateSerialName()` counter is
private, host-side bookkeeping a primitive bypassing `BankTable`
entirely has no business reaching into — inventing a *second*,
independent serial counter for `MMAP`'s own header would let two
counters produce colliding names by construction, worse than not
having one. Using the tag itself sidesteps the problem rather than
solving it cleverly: it costs nothing (`MMAP` doesn't enforce name
uniqueness today either, since nothing has needed
`findBankByName()`-style access to `MMAP` yet) and stays honest about
what's actually guaranteed.

**No out-of-space check beyond `MMAP`'s own existing 64-slot cap.**
`BankTable.createBank()` checks `nextFree + size > arena.sizeBytes`
before allocating; this primitive doesn't duplicate that check. Same
precedent M19's own `BankTable` constructor already relies on
("`DataView` already enforces this for free... relied on deliberately,
not duplicated"): a bank "created" past the arena's real end will
`RangeError` the moment something actually reads or writes into it,
not at creation time. Consistent with "no host validation," not a gap.

### The real consequence, named plainly: Forth-created banks are invisible to every host-array reader

`BankTable.getAllBanks()`/`findBank()` — and everything built on top of
them: `storage.ts`'s project save/load, the app's `read_banks` WebMCP
tool, the inspector panel — only ever see banks the *host* created,
because `CREATE-BANK` never touches `BankTable`'s own array, only
`MMAP`. A bank Forth creates is real, addressable, and correctly
findable via `BANK@` (M20, reads `MMAP` directly) and any raw `@`/`!`
walk of `MMAP` — but genuinely doesn't exist as far as `getAllBanks()`
is concerned. This is the direct, structural cost of the "no host
round-trip" design, not an oversight: making the host aware would mean
either polling `MMAP` for changes every tick (real overhead, real
staleness-window questions) or giving up on "no host round-trip"
entirely. Left as-is, named honestly rather than glossed over — a
future consumer that needs the inspector panel to show Forth-created
banks too would need `getAllBanks()` (or a new, separate read path) to
start reading `MMAP` instead of the host array, which is real,
separate follow-on work of its own.

### Implementation sketch

- `rebel-opcodes.json`: one new primitive, `CREATE-BANK`, next free
  token (100).
- `primitives.ts`: one case — pop `size`, parse+uppercase the tag,
  `ctx.banks.mmap.addBank(tag, tag, ctx.banks.mmap.getNextFree(), size,
  BankFlagResident | BankFlagActive)`, push the returned base. No
  `PrimitiveContext` shape change — `banks: BankTable` (M18) already
  covers reaching `.mmap`.
- No `inner.ts` change — synchronous, same category as `BANK@`.

### Verification

- New engine tests, `mmap.test.ts`: a bank created via `CREATE-BANK` is
  immediately findable via `BANK@` for the same tag, at the same
  address; it lands exactly at `MMAP`'s prior next-free offset, and
  advances that cell by exactly its size; its memory is actually usable
  (`@`/`!` round-trips at the returned address); it names itself after
  its (possibly-truncated) tag; the table throws once all 64 slots are
  used, same as any other `addBank()` caller; **and, explicitly, that
  it does *not* appear in `getAllBanks()`/`findBank()`** — a test
  asserting the documented gap exists, not just hoping it doesn't
  regress silently.
- Live, via WebMCP: `4096 CREATE-BANK DAT1 . BANK@ DAT1 .` printed
  `84924 84924` (both agreeing, at `MMAP`'s real next-free offset);
  `1234 BANK@ DAT1 ! BANK@ DAT1 @ .` printed `1234` — the created
  bank's memory is genuinely usable, not just a descriptor; `read_banks`
  (host-side) confirmed to *not* list `DAT1`, and the inspector panel
  screenshot confirms the same, cross-checking the documented gap live,
  not just in the test suite. Zero console errors.
- Full engine (218 tests) + app (10 tests) suites and `npm run build`
  green, zero regressions.

### A real gotcha, found while testing, not just theorized

A tag longer than 4 characters (the fixed field width every real tag
in this codebase already respects by convention — `SYSV`, `DICT`,
`DATA`, …) silently truncates on write, but `BANK@`'s own lookup
compares the *full*, untruncated token against a slot's (always ≤4
char) stored tag. So `4096 CREATE-BANK MYDATA` creates a bank whose
stored tag is `MYDA`, findable only via `BANK@ MYDA`, never
`BANK@ MYDATA` — confirmed directly while writing this milestone's own
tests. Not a new inconsistency `CREATE-BANK` introduces (`BANK@` has
always compared full strings, untruncated, against real tags that
were always ≤4 characters by convention, never enforced by code) —
just the first time anything could actually *create* a tag violating
that convention, surfacing a sharp edge that was latent before. Left
as-is, matching "no host validation": `CREATE-BANK` doesn't reject or
warn on an oversized tag any more than it validates anything else.

### Scope cuts, explicit

- No name uniqueness, no auto-serial naming — name always equals the
  (truncated) tag.
- No out-of-space validation — relies on `DataView`'s own
  bounds-checking at first real access, not creation time.
- No change to `BankTable`/`getAllBanks()`/`storage.ts`/`read_banks` to
  make them `MMAP`-aware — the visibility gap above is accepted, not
  fixed here.
- No Forth-level word to *delete* or *resize* a bank — creation only,
  matching the "arena grows monotonically, nothing is ever freed"
  model this codebase already has everywhere else.

## 14. `BankTable` reads — and allocates — through `MMAP`, no cached state anywhere — done, M22

### Motivation, and a real bug found while checking it

The originally-requested piece: `getAllBanks()`/`findBank()`/
`findBankByName()` (`banks.ts`) still read `BankTable`'s own private
`banks: Bank[]` array, so a bank `CREATE-BANK` (M21) creates — real,
addressable, correctly findable via `BANK@` — stays invisible to
`storage.ts`, the app's `read_banks` WebMCP tool, and the inspector
panel. §13 named this plainly as an accepted consequence, not a gap.

**Checked, not assumed, while scoping this: it's worse than a
visibility gap.** `BankTable.createBank()` computes a new bank's `base`
from its own private `nextFree` field, which `CREATE-BANK` never
touches — `CREATE-BANK` advances `MMAP`'s *own* next-free cell
directly, independently. Reproduced live: `64 CREATE-BANK FTAG`
creates a bank at base `84924`; a subsequent
`banks.createBank('DATA', 64, 'HOSTBANK')` places its bank at the
*same* base, `84924` — a real overlap, not a display omission.

### Revised design, per direct correction: `ACTIVE` is occupancy, not a cache to reconcile — so don't cache anything at all

An intermediate version of this section proposed consolidating to one
`nextFree` cursor cell in `MMAP`'s header. **Corrected directly:**
`ACTIVE` isn't a flush-safety detail — it's *the* per-slot occupancy
bit, full stop: `ACTIVE=1` means "this slot, as configured, is a real
bank in use"; `ACTIVE=0` means "not in use," available to be handed
out again. Async-flush-safety (this section's own earlier framing for
why `ACTIVE` existed at all, M19) is explicitly **not a concern right
now** — nothing implements flush logic yet, and this design doesn't
hedge against it.

Taken to its actual conclusion, that means **no cursor cell is needed
at all**, not even one: both "which slot is free" and "what memory
address is free" are fully derivable by scanning the 64 fixed slots
and checking each one's own `ACTIVE` bit — so nothing needs to be
cached, and nothing cached can ever drift from what the slots
themselves say. This removes the bug above by removing the entire
class it belongs to, not by finding a smarter way to keep two cursors
in sync.

- **`MMAP`'s header shrinks to just magic + version** (4 bytes) — the
  `nextFree`/`slotCount` cells this section (and M19) previously had
  are deleted, not repurposed. `MMAP_SIZE` becomes `4 + 64×24 = 1540`
  bytes (down from 1548) — every other bank's base shifts down by 8
  bytes as a direct, harmless consequence, same as any other `MMAP`
  size change (`FORTH-ARCHITECTURE.md`'s per-arena-offset rule).
- **Allocation** (`MemoryMap` gains one method, `allocate(tag, name,
  size, flags)`, replacing `addBank()`): scans all 64 slots for the
  first with `ACTIVE` off (an available slot — always finds a
  never-used one today, since nothing ever deactivates a real bank
  yet); separately scans all 64 slots for `max(base + size)` over
  every currently-`ACTIVE` one, giving the new bank's `base` fresh,
  never cached; writes the descriptor into the chosen slot with
  `ACTIVE` off, **then flips `ACTIVE` on last** — "prepare it, then
  switch it on," exactly as directed. Returns the new `base`.
- **Enumeration** (`getAllSlots()`, `findBankAddr()`): walk all 64
  fixed slots, filtered to `ACTIVE` — not a `slotCount`-bounded range,
  since that concept no longer exists.
- The `BankFlag*` constants (`banks.ts`) move to `mmap.ts` — `mmap.ts`
  now needs to check `ACTIVE` natively as part of its own occupancy
  model, not just carry an opaque caller-supplied bit. `banks.ts`
  re-exports them from `mmap.ts` for `index.ts`/`primitives.ts`'s
  existing public surface, so nothing importing `BankFlagActive` etc.
  from `banks.ts` today needs to change. (This also avoids repeating
  the exact circular-import bug M19 already hit once — `mmap.ts`
  importing back from `banks.ts` — by not creating the dependency in
  that direction at all this time.)
- `BankTable.createBank()` calls `this.mmap.allocate(tag, bankName,
  size, flags)` directly for `base` — `this.nextFree`/`this.banks`
  (the private array) are both removed.
- `getAllBanks()`/`findBank()`/`findBankByName()` all read
  `this.mmap.getAllSlots()` — no transform needed, `MMapSlot` and
  `Bank` are already structurally identical (M19).
- `this.nextSerial` (the auto-serial-name counter) stays exactly as it
  is, private/host-side — `CREATE-BANK` never generates an
  auto-serial name (name always equals tag, M21's own scope cut), so
  it has no exposure to the class of bug this section fixes.
- A useful side effect, not a separate feature: `createBank()`'s
  existing name-uniqueness pre-check (`findBankByName()`) now also
  catches a collision against a *Forth-created* bank's name.
- **`BankTable.createBank()` drops its `arena.sizeBytes` out-of-space
  check.** Once host- and Forth-side creation share the exact same
  underlying `allocate()`, keeping host-only validation would be a new
  asymmetry, not a removed one — `CREATE-BANK` (M21) already set the
  "no out-of-space validation, `DataView`'s own bounds-checking fires
  at first real access" precedent; this unifies both creators on it
  rather than special-casing the host path.

### Real behavioral changes, named explicitly

- **Object identity is no longer stable.** `getAllBanks()`/`findBank()`/
  `findBankByName()` currently return the *same* object reference
  across repeated calls (a cached private array). Once backed by
  `MMAP`, each call decodes fresh objects from arena bytes. Breaks
  three existing `.toBe()` reference-identity assertions in
  `banks.test.ts` — real test-suite changes to `.toEqual()`.
- **`MemoryMap`'s public API changes, not just grows**: `getNextFree()`
  and `getSlotCount()` are deleted, not deprecated — seven existing
  assertions across `mmap.test.ts` reference them directly and need
  rewriting against the new `allocate()`-based shape, not just
  extending with new cases.
- **Fixes the overlap bug** above as a direct, load-bearing
  consequence.
- **`storage.ts`/`read_banks`/the inspector panel start seeing
  Forth-created banks** — closes §13's documented gap. Whether a
  Forth-created bank should be `saveAsset()`-able once visible to
  `storage.ts` is a real, separate question this section doesn't
  answer.
- **Host-side bank creation loses its explicit "arena out of space"
  error** — deferred to first real access instead, like Forth-side
  creation already was (M21). A behavior change for `storage.ts`'s
  `openProject()` specifically (a corrupt/oversized project asset file
  no longer fails at load time).
- Performance remains a non-issue: even scanning all 64 slots twice
  per allocation (once for a free slot, once for the base) is a few
  hundred cheap `DataView` reads — not a hot-path concern, and
  `getAllBanks()`/allocation are already documented as
  host-orchestrated, occasional operations, never interpreter-loop
  code.

### Implementation sketch

- `mmap.ts`: `BankFlag*` constants move in from `banks.ts`. `initHeader()`
  shrinks to magic+version only. `getNextFree()`/`getSlotCount()`
  removed. New `allocate(tag, name, size, flags): number` (find free
  slot, compute base, write, activate last) replaces `addBank()`.
  `getAllSlots()`/`findBankAddr()` change from `slotCount`-bounded to
  `MMAP_MAX_SLOTS`-bounded-and-`ACTIVE`-filtered iteration. `MMAP_SIZE`
  recomputed for the smaller header.
- `banks.ts`: re-exports `BankFlag*` from `mmap.ts` (no call-site churn
  elsewhere). `createBank()`/`getAllBanks()`/`findBank()`/
  `findBankByName()` all delegate to `mmap`. `this.banks`/`this.nextFree`
  fields removed; `this.nextSerial` untouched. Bootstrap (`MMAP`
  registering itself as bank 0) becomes a call into `mmap`'s own
  self-registration, still base-0-special-cased since there's nothing
  to scan yet at that point.
- `primitives.ts`: `CREATE-BANK`'s case (100) simplifies to one call,
  `ctx.banks.mmap.allocate(tag, tag, size, flags)` — no more separate
  `getNextFree()` + `addBank()` steps.
- No `PrimitiveContext`/`repl.ts` change — `BANK@`/`CREATE-BANK`
  (M20/M21) already go through `ctx.banks.mmap`, just call different
  methods on it now.

### A second real bug, found while implementing, not just the one found while scoping

`MemoryMap.allocate()` unconditionally forces `ACTIVE` into what it
*writes*, but an early version of `BankTable.createBank()` built its
returned `Bank` object from the raw `flags` parameter the caller
passed in, not from what `allocate()` actually persisted. For any
caller supplying `flags` without `ACTIVE` already set — exactly what
the existing "respects a caller-supplied flags value" test does,
passing `BankFlagExternal` alone — `bank.flags` (2) and
`mmap.getSlot(i).flags` (18, `EXTERNAL | ACTIVE`) silently disagreed.
Caught immediately by that pre-existing test, not discovered later.
Fixed by having `allocate()` return the actual stored `MMapSlot`
(`MMapSlot` and `Bank` being structurally identical makes this a
direct return, no transform) instead of just a `base: number`, so
`createBank()` (and `CREATE-BANK`) build their result from what's
really in `MMAP`, never from an assumption about it.

### Verification

- Regression check, the actual bug reproduced while scoping this:
  `CREATE-BANK` then `createBank()` confirmed to **not** overlap
  anymore (`node -e` against the built `dist/`, not just the test
  suite) — the exact repro that motivated this section, re-run and
  confirmed fixed.
- `banks.test.ts`'s three `.toBe()` assertions updated to `.toEqual()`.
- `mmap.test.ts`'s seven `getNextFree()`/`getSlotCount()` references
  rewritten against `allocate()`'s new shape — e.g. asserting each
  successive `createBank()`/`CREATE-BANK` call's `base` starts exactly
  where the previous one's `base+size` ended, derived from real bank
  objects, not a cursor cell.
- `mmap.test.ts`'s M21 test "is invisible to
  `BankTable.getAllBanks()`/`findBank()`" **inverted** — now asserts a
  Forth-created bank *does* appear in both, with the exact expected
  descriptor.
- New tests: `createBank()`'s uniqueness check throws on a name
  collision against a Forth-created bank; the "caller-supplied flags"
  test now asserts `ACTIVE` is present in both the returned `Bank` and
  the mirrored slot (this is the test that caught the second bug
  above).
- Live, via WebMCP: fresh `Machine`'s `read_banks` showed `MMAP` at
  `1540` bytes (down from `1548`, matching the smaller header) with
  every other bank's base shifted down by exactly 8 bytes;
  `4096 CREATE-BANK DAT1 .` printed `84916`; a follow-up `read_banks`
  and inspector-panel screenshot both showed `DAT1 DAT1 84916 4096`
  right alongside every host-created bank — the visibility gap from
  §13 is genuinely closed, not just asserted in a test. Zero console
  errors.
- Full engine (219 tests) + app (10 tests) suites and `npm run build`
  green.

### Scope cuts, explicit

- No async-flush-safety design — explicitly out of scope for this
  pass, per direct instruction; `ACTIVE` is purely occupancy here.
  Revisit the flush-vs-reclaim interaction only once flush logic is
  actually being built, not now.
- No change to `nextSerial`/auto-serial naming — unaffected.
- Whether `storage.ts` should be able to `saveAsset()` a Forth-created
  bank — real, separate, open question, not decided here.
- No merging of the `MMapSlot`/`Bank` types even though they're
  structurally identical today — kept as separate, independently
  named types.
- No Forth-level word to explicitly deactivate/"free" a bank — this
  section makes the *allocator* reuse-aware, but nothing yet sets
  `ACTIVE` to 0 on a real bank; that's still separate, unbuilt work.

## 15. A batch of low-level primitives — `XOR`, `.S`, `2SWAP`/`2OVER`, `CELLS`/`CELL+`, `FILL`/`CMOVE`, `SPACE`/`BL`, `WITHIN`, `PICK`/`ROLL` — done, M23

### Motivation

A review of the current primitive table (`rebel-opcodes.json`, tokens
1-100) against what M8's `CORE-VOCABULARY.md` §9 already flagged as
"STANDARD-for-now, native for now" (§3's rationale: no `LOAD`
subsystem exists inside `packages/engine` for these to be loaded from
Forth source instead — `system.fth` is loaded by `packages/app` only,
"nothing in packages/engine knows this file exists," so that rationale
still applies unchanged today) turned up a real, mechanical gap: 13
words in the same category as the ones §9 already shipped, genuinely
missing rather than deliberately deferred. Same categorization logic
applies to every word below — each is CORE (needs raw stack/memory
access no combination of existing words can reach) or STANDARD-for-now
(derivable once a real loader exists, shipped native today for the
same "nowhere to load it from yet" reason as `NIP`/`TUCK`/etc.).

### The words

| Token | Word | Stack effect | Category | Notes |
|---|---|---|---|---|
| 101 | `XOR` | `( a b -- a^b )` | CORE | Same shape as `AND`(15)/`OR`(16) — a real bitwise op §9 never shipped, not stylistic. |
| 102 | `.S` | `( -- )` | STANDARD-for-now | Non-destructive stack print, bottom-to-top, current `BASE`, matching `.`'s (18) digit-formatting exactly. |
| 103 | `2SWAP` | `( a b c d -- c d a b )` | STANDARD-for-now | Swaps the top two cell-pairs. |
| 104 | `2OVER` | `( a b c d -- a b c d a b )` | STANDARD-for-now | Copies the second-from-top pair to the top, generalizing `OVER`(4) the way `2DUP`/`2DROP`(71/72) generalized `DUP`/`DROP`. |
| 105 | `CELLS` | `( n -- n*4 )` | STANDARD-for-now | `n * CELL_SIZE`. |
| 106 | `CELL+` | `( addr -- addr+4 )` | STANDARD-for-now | `addr + CELL_SIZE`. Together, `CELLS`/`CELL+` remove the manual `4 *`/`4 +` every cell-address computation in `system.fth`/user code currently spells out by hand. |
| 107 | `FILL` | `( addr len char -- )` | CORE | Classic ANS signature. Fills `len` bytes starting at `addr` with `char`'s low 8 bits, looped `arena.writeByte`. First real use: zeroing a freshly `CREATE-BANK`'d region, which today needs a hand-written loop. |
| 108 | `CMOVE` | `( addr1 addr2 len -- )` | CORE | Copies `len` bytes `addr1`→`addr2`, low-to-high. Like real Forth's `CMOVE` (not `CMOVE>`), overlapping ranges where `addr2 < addr1 < addr2+len` corrupt data — a documented footgun, not a bug, matching the `>R`/`R>` imbalance precedent (§5/token 37's note). |
| 109 | `BL` | `( -- 32 )` | STANDARD-for-now | Pushes the ASCII space code — CORE-VOCABULARY.md §12 already flagged this by name as "cheap enough to add ... if used often enough elsewhere," and it now is (`WORDS` in `system.fth` still spells out a bare `32 EMIT`). |
| 110 | `SPACE` | `( -- )` | STANDARD-for-now | `BL EMIT` as one word — same §12 note, the other half of it. |
| 111 | `WITHIN` | `( n lo hi -- flag )` | STANDARD-for-now | `TRUE` if `lo <= n < hi`. **Deliberately the plain signed version, not full ANS `WITHIN`** — the real ANS spec defines this with modular/wraparound semantics (true even when `hi < lo`, treating the range as circular) so that unsigned callers get well-defined behavior at the word boundary; this project already has a separate `U<`(92) for the one place unsigned comparison was actually needed, and no current caller needs wraparound ranges. Diverging on purpose and documenting it, same precedent as `S"`'s addr/len choice (§8). |
| 112 | `PICK` | `( xu ... x1 x0 u -- xu ... x1 x0 xu )` | CORE | Generalizes `OVER` (`1 PICK` = `OVER`, `0 PICK` = `DUP`) to arbitrary depth — `s.peek(n)` after popping `u`, already exactly what `DataStack.peek(depthFromTop)` computes. |
| 113 | `ROLL` | `( xu ... x1 x0 u -- xu-1 ... x1 x0 xu )` | CORE | Generalizes `ROT` (`2 ROLL` = `ROT`) — pops `u`, then the item `u` cells down, shifting everything above it down by one and pushing the rolled item on top. Needs an explicit pop-into-array/reorder/push-back loop (`DataStack` has no splice-at-depth primitive) — the one word in this batch that isn't a handful of lines. |

### Implementation sketch

- `rebel-opcodes.json`: 13 new entries appended to `"primitives"`,
  tokens 101-113, one-line `note` each mirroring the table above (same
  style as tokens 71-92's §9 batch).
- `primitives.ts`: 13 new `case` arms in the same switch, inserted
  after case 100 (`CREATE-BANK`). `XOR` sits naturally next to
  `AND`/`OR`/`INVERT` (15-17) in reading order even though its token
  number is 101 — token IDs are allocation order, not logical grouping,
  same as `<>`(89) already being nowhere near `=`(11). `FILL`/`CMOVE`
  import nothing new — `ctx.arena.writeByte`/`readByte` are already
  imported via `ctx.arena` (see `C@`/`C!`, tokens 34/35). `CELLS`/
  `CELL+` need `CELL_SIZE` added to the existing `from './arena.js'`
  import (`alignCell` is already pulled from there). `.S` reuses `.`'s
  (case 18) own digit-formatting loop (`v.toString(ctx.getBase())`),
  applied to `[...s.toArray()].reverse()` (`toArray()` is top-to-bottom
  per `stack.ts`'s own doc comment; classic `.S` prints bottom-to-top,
  deepest first) instead of a single popped value, and never pops.
- No `dictionary.ts`/`inner.ts`/`repl.ts` changes — every one of these
  13 is a plain stack-effect primitive, none needs compile-time
  (`IMMEDIATE`) behavior or inner-interpreter special-casing the way
  `EXECUTE`/`ACCEPT`/`(DOES>)` do.
- `system.fth`'s own `WORDS` definition is a natural, optional
  follow-up cleanup (`32 EMIT` → `SPACE`) once this ships — not part
  of this batch, since it's a pure readability win with zero behavior
  change, and this project doesn't bundle unrelated cleanup into a
  scoped change (top-level "Calibrating scope" rule in `CLAUDE.md`).

### A real cross-target consequence, named up front

`CORE-VOCABULARY.md` §13 and `FORTH-ARCHITECTURE.md` §0 both require
new tokens to go into the canonical opcode source-of-truth *before*
any target implements them — the exact failure mode that single
source-of-truth artifact (still unbuilt, `CLAUDE.md`'s own listed gap)
exists to prevent. Same situation `BRANCH`/`0BRANCH`/`DOVAR`/`DODOES`
were in at M8: `rebel-opcodes.json` remains the only place these 13
token IDs are assigned, `rebel-rom` has no Forth executor yet to
reconcile against (per `HAL.md`), so there's nothing to keep in sync
today — but the numbering here (101-113) is a real commitment once
`rebel-rom`'s own Forth phase exists, not a free-to-renumber
implementation detail.

### Scope cuts, explicit

- No `CMOVE>` (the overlap-safe, high-to-low counterpart) — not adding
  a word for a problem (overlapping-region copies) nothing in this
  codebase does yet; add it the day something actually needs it, same
  "don't build ahead" discipline as `LEAVE` (§9/CORE-VOCABULARY.md
  §11).
- No `LSHIFT`/`RSHIFT` (general bit shifts) — `2*`/`2/`(87/88) already
  cover the single-bit case every current use needs; a general shift
  is a real future candidate but not scoped here since nothing asked
  for it yet.
- `WITHIN`'s signed-only, non-wraparound semantics (see table) — a
  deliberate divergence from full ANS `WITHIN`, not an oversight.
- No change to `system.fth` in this pass (see implementation sketch).
- No new bank, sysvar, or HAL surface — this is a pure `switch`-arm
  addition, the smallest-blast-radius category of change this codebase
  makes.

### Verification — done

- New file `low-level-batch.test.ts` (the existing file organization
  splits by topic, e.g. `stack-arith.test.ts` for the M8 §9 batch — a
  new topic file matched that precedent better than folding into
  `primitives.ts`'s own untested-directly switch), same `toArray()`
  top-first assertion style as `stack-arith.test.ts`: one case per
  word plus the edge cases named in the plan — `0 ROLL`/`0 PICK`/
  `1 PICK` against `DUP`/`OVER`'s known results, `1 ROLL`/`2 ROLL`
  against `SWAP`/`ROT`, `FILL`+readback on a freshly `CREATE-BANK`'d
  region, `CMOVE` copying into a second offset of the same bank,
  `WITHIN` at both boundaries, `.S` against both a 3-item stack
  (confirms non-destructive via a follow-up `stack.toArray()` check)
  and an empty stack (prints nothing, doesn't throw).
- Full engine suite: 232 passed (219 + 13), zero changes to any
  existing test. App suite (10 tests) and both workspace builds
  unaffected — no `repl.ts`/`dictionary.ts`/`inner.ts` change was
  needed (§'s own implementation sketch predicted this correctly:
  `repl.ts`'s boot-registration loop already walks
  `opcodes.primitives` generically, and none of these 13 are
  `immediate`/`compileOnly`).
- Live, via WebMCP (`type`/`read_screen`/`read_stack`, dev server
  restarted with `.angular` cache cleared first, per the standard
  Vite pre-bundling staleness precedent): `6 3 XOR .` → `5`;
  `1 2 3 .S` → printed `1 2 3` with `read_stack` confirming `3 2 1`
  still on the stack afterward (genuinely non-destructive, not just
  asserted in a test); `5 CELLS .` → `20`, `100 CELL+ .` → `104`;
  `WITHIN` at `n=5,10,-1` against `[0,10)` → `TRUE`/`FALSE`/`FALSE`
  (hi exclusive, lo inclusive, confirmed exactly as scoped);
  `1 2 1 ROLL .S` / `1 2 3 2 ROLL .S` → `2 1` / `2 3 1`, matching
  `SWAP`/`ROT`; `BL EMIT 42 EMIT SPACE 43 EMIT` → printed a leading
  space, `*`, a space, `+` (` * +`, exactly the four emitted
  characters); a `CREATE-BANK`+`FILL`(8 bytes)+`CMOVE`(4 bytes to
  offset+32)+`C@` readback sequence confirmed byte-exact — offset 0
  and offset 32 both read `42` (filled/copied), offset 40 read `0`
  (untouched, confirming `CMOVE` didn't overrun). Zero console errors
  throughout. One self-inflicted `? DSTK stack underflow` along the
  way, from a miscounted manual byte-walk in the live test line
  itself (not a primitive bug) — confirmed the interpreter recovered
  cleanly (empty stack, no corruption), a useful incidental check.

## 16. `BASE`, `HEX`, `DECIMAL` — radix control from Forth source — done, M24

### Motivation

`FORTH.BASE` (`rebel-opcodes.json`'s sysvar table) already exists and
already does real work — `parseNumber` (`repl.ts`) reads it for input
radix, `.`/`.S` (tokens 18/102) read it for output — but nothing lets
Forth source itself inspect or change it. Today the only way to
switch radix is `ctx.sysvars.setBase()` from TypeScript; there's no
Forth-level `BASE`, `HEX`, or `DECIMAL`, the exact gap `LATEST-ADDR`
(token 95, §8) closed for `LATEST` when `VOCABULARY`/`USE` needed
direct sysvar-cell access.

### The words

| Token | Word | Stack effect | Category | Notes |
|---|---|---|---|---|
| 114 | `BASE` | `( -- addr )` | CORE | Pushes the arena address of the `FORTH.BASE` sysvar cell — a real Forth **variable**, not a read-only value the way `HERE`/`LATEST` are (tokens 59/60). Read with `BASE @`, write with `n BASE !`, matching real Forth's own `BASE` exactly (not `LATEST-ADDR`'s split-name pattern — `BASE` doesn't need a separate value-reading word the way `LATEST`/`LATEST-ADDR` do, since nothing already claimed the bare name `BASE` for something else). |
| 115 | `HEX` | `( -- )` | STANDARD-for-now | Sets `BASE` to 16. Trivially `16 BASE !` once token 114 exists — genuinely derivable, shipped native for the same reason M23's whole batch was (`DEVELOPING.md` §15): consistent with every other STANDARD-for-now word in this codebase, and testable directly against a bare `Machine` the way `system.fth`-defined words (loaded by `packages/app` only) aren't. |
| 116 | `DECIMAL` | `( -- )` | STANDARD-for-now | Sets `BASE` to 10. Same reasoning as `HEX`. |

### Implementation sketch

- `rebel-opcodes.json`: 3 new entries, tokens 114-116.
- `primitives.ts`: `case 114` pushes
  `ctx.sysvars.fieldOffset('FORTH', 'BASE')` — identical shape to
  `LATEST-ADDR`'s existing case 95, `fieldOffset` already public and
  already doc-commented for exactly this reuse ("the same way real
  Forth systems usually treat HERE/LATEST/STATE/BASE as ordinary
  variables," `sysvars.ts`). `case 115`/`case 116` call
  `ctx.sysvars.setBase(16)`/`setBase(10)` directly — `Sysvars` already
  has this exact method, currently only called from `repl.ts`'s own
  constructor (`this.sysvars.setBase(10)` at boot).
- No `dictionary.ts`/`inner.ts`/`repl.ts` change — same as every M23
  word, none of these three need `IMMEDIATE`/`COMPILE_ONLY` or
  inner-interpreter special-casing.

### A real, existing consequence this doesn't change

`parseNumber` (`repl.ts`) has no leading-radix-prefix syntax (no
`$FF`/`0x`/`#`-style override) — the *only* way a numeric token gets
parsed as hex is the current `BASE` value at parse time, for every
token on the line, not a per-number override. `HEX`/`DECIMAL` make
this switch reachable from Forth source, but don't change that
behavior — worth knowing before relying on it (e.g. `HEX DEAD DECIMAL`
parses `DEAD` as hex correctly, but `HEX DEAD 10 +` also parses the
literal `10` as hex-16, not decimal-ten, matching real Forth's own
documented `BASE`-affects-every-token-uniformly behavior).

### Scope cuts, explicit

- No `OCTAL`/`BINARY` — not ANS `CORE`, no current caller needs them;
  add the day something does, same "don't build ahead" discipline as
  everywhere else.
- No `STATE`-address word — `STATE` (`FORTH` group, same as `BASE`)
  has the identical "real Forth treats it as a variable" gap, but
  nothing has asked for direct `STATE @`/`STATE !` access yet; flagged
  here as the next candidate if `fieldOffset`'s reuse pattern comes up
  again, not scoped now.
- No `system.fth` change — `HEX`/`DECIMAL` could instead be defined
  there once `BASE` (token 114) exists (`: HEX 16 BASE ! ;`), matching
  the `WORDS`/`SEE`/`HIDE` precedent (M12-M14) of composing in Forth
  once the primitive it needs exists. Deliberately not done — shipping
  all three as primitives keeps them engine-testable against a bare
  `Machine`, consistent with M23's own choice for the exact same
  "genuinely derivable, native for now" category of word.

### Verification — done

- A new `describe` block appended to `low-level-batch.test.ts` (not a
  separate file — same topic-file organization, radix control is
  small enough to sit alongside the M23 batch without confusing the
  two milestones, each still individually traceable via its own test
  names/comments): `BASE @` reads `10` fresh; `HEX`/`DECIMAL` flip it
  to `16`/back to `10`; `16 BASE !` proves `BASE` is a real writable
  variable, not private `HEX`/`DECIMAL` state; `.` after `HEX` prints
  hex digits. **One test written wrong on the first pass, caught
  immediately by the suite, not shipped**: `HEX 255 .` was meant to
  show hex output but `255`'s own digits are all valid hex digits, so
  it got parsed *as* hex under the just-switched `BASE` (`597`
  decimal) and printed back out as `255` — a real demonstration of
  §16's own documented "every subsequent token, not just non-numeric
  ones" gotcha, encountered firsthand while writing the test for it.
  Fixed by reordering to `255 HEX .` (the literal parses while still
  decimal, only the *printing* happens under the new base) — the
  originally-intended assertion (`ff`) now correct for the right
  reason. Also added: `HEX 10 DECIMAL` leaves `16` on the stack, not
  `10` — the gotcha itself, asserted directly, not just narrated.
- Full engine suite: 237 passed (232 + 5). App suite (10) and both
  builds unaffected.
- Live, via WebMCP: `BASE @ .` → `10`; `255 HEX .` → `ff`;
  `DECIMAL BASE @ .` → `10`; `16 BASE ! FF .` → `ff` (confirms `BASE
  !` and `HEX` are genuinely the same mechanism, not two independent
  code paths that happen to agree). Zero console errors.

## 17. `CURSEN`/`CURSDIS` — a visible, inverse-video text cursor — done, M25

### Motivation

`CURSOR-X`/`CURSOR-Y` (`CORE` group) already exist on both targets —
but checked directly against real code on both sides
(`screenmodule.cpp`'s `SetCursor`/`AdvanceCursor`, `screen.ts`'s
same-named methods) confirms neither has ever rendered a *visible*
cursor. They're pure write-position trackers for `EMIT`/`AT-XY`. This
is genuinely new ground, not a HAL gap or a cross-target fact to
reconcile against.

**Layer decision, reasoned through, not guessed:** not HAL, not pure
Forth — the `Screen` class (`screen.ts`), same tier as `CLS`/`AT-XY`/
`INK`/`PAPER` already live at. `Screen.writeChar()` is the one
choke-point every content-writing path (`EMIT`, `CHAR!`, and any
future bitblt primitive) already funnels through before calling
`ScreenHal.blitGlyph()` — putting cursor-awareness there would be
wrong for a different reason (below), but the *general* principle —
one shared place above the HAL, not duplicated into every write site
or into every future HAL backend — is why this is a `Screen`-level
feature. `HAL.md`'s `blitGlyph`/`clearScreen` stay exactly as they are
today, zero interface change.

**Why `writeChar()` itself must NOT auto-invert, though — worked
through by tracing `EMIT`'s real call sequence
(`screen.ts:138-156`):** `EMIT` calls
`writeChar(cursorCol, cursorRow, code)` *while the cursor sysvars
still point at that exact cell*, then calls `advanceCursor()`
afterward. If `writeChar` auto-inverted "whichever cell currently
equals `CURSOR-X`/`Y`," it would invert the character the user is
*actively typing*, not the cell the cursor is about to occupy — wrong
behavior, not just an edge case. The correct terminal-style split:
content writes (`writeChar`) always use their real, given ink/paper,
never invert; a *separate* cursor-redraw step runs only when the
cursor's position changes (`setCursor`) or its visibility toggles
(`CURSEN`/`CURSDIS`) — and because `setCursor` is already the single
place both `advanceCursor()` and `EMIT`'s `CR`/`LF` handling and the
`AT-XY` primitive route through, hooking it there covers every
cursor-movement path for free, with no change needed at any of those
call sites.

**Restoring the cell the cursor moves away from costs nothing new —
confirmed against real code, not assumed:** `CHAR` only ever stores
the character code (`screen.ts`'s `arena.writeByte` in `writeChar`),
never per-cell color — so "un-invert the old cell" is just
`readChar(oldCol, oldRow)` re-blitted with the *current* global
`INK`/`PAPER`, nothing to remember or restore. `rebel-rom` itself
relies on exactly this same fact already:
`CScreenModule::Redraw()` (`screenmodule.h:119-122`, private,
called from `AttachArena()`) repaints every cell purely from
`m_pCharBank`'s stored bytes — real, existing precedent for
"redrawing from `CHAR` content alone is always correct," not a new
assumption this design introduces.

### The words

| Token | Word | Stack effect | Notes |
|---|---|---|---|
| 117 | `CURSEN` | `( -- )` | Turns the cursor on: sets `SCREEN.CURSOR-VISIBLE` `TRUE`, immediately redraws the current cursor cell inverted. |
| 118 | `CURSDIS` | `( -- )` | Turns it off: sets `SCREEN.CURSOR-VISIBLE` `FALSE`, immediately redraws the current cell normal. |

No dedicated query word — `SCREEN.CURSOR-VISIBLE` is a real sysvar
cell, already reachable from pure Forth via the existing
`BANK@ SYSV <offset> + @` mechanism (`BANK@`'s own note,
`rebel-opcodes.json`) without adding anything new for it, the same
free side-benefit `LATEST-ADDR`/`BASE` get from living in the sysvar
table instead of a private field.

### New sysvar: `SCREEN.CURSOR-VISIBLE`

Offset 32 in the `SCREEN` group (`INK`/`PAPER` end at 28-32; next free
slot). **The reverse of this group's usual direction, same situation
`CORE.ARENA-SIZE` (M19) was in**: checked directly against
`rebel-rom/src/sysvars.h`'s real `TScreenSysVars` — it has no such
field either, since no cursor rendering exists there yet — so this is
a genuine cross-target candidate proposed from the Rebel-Sim side, not
a Rebel-Sim-only addition. `HAL boolean convention` (`TRUE=-1`,
`FALSE=0`) applies, defaults to `FALSE` at boot — the feature is fully
opt-in; nothing visually changes for any existing Forth source unless
`CURSEN` is actually called.

### Implementation sketch

- `rebel-opcodes.json`: `SCREEN.CURSOR-VISIBLE` sysvar field (offset
  32), two new primitive entries, tokens 117-118.
- `screen.ts`:
  - New private `redrawCursorAt(col, row, inverted): void` — guarded
    by the existing private `inBounds()` check (out-of-range cursor
    silently doesn't render, matching `CHAR!`'s existing
    silent-no-op-on-out-of-range precedent, not a special case);
    reads `readChar(col, row)`, computes `ink`/`paper` (swapped if
    `inverted`), calls `this.hal.blitGlyph(...)` **directly** — not
    `writeChar()` — since nothing about the cell's actual content
    changes, only how this one blit call renders it; re-storing the
    same byte back into `CHAR` via `writeChar` would be harmless but
    semantically wrong (a redraw is not a write).
  - New private `isCursorVisible(): boolean` — reads
    `SCREEN.CURSOR-VISIBLE` from `sysvars`.
  - `setCursor(col, row)` gains the redraw hook: capture the *old*
    `(getCursorCol(), getCursorRow())` before overwriting the sysvars;
    after writing the new position, if `isCursorVisible()`,
    `redrawCursorAt(oldCol, oldRow, false)` then
    `redrawCursorAt(col, row, true)`. Zero extra cost when the cursor
    is off (the common case today) — the `isCursorVisible()` check
    short-circuits before either redraw call.
  - New public `showCursor(): void` / `hideCursor(): void` — set the
    sysvar, then `redrawCursorAt(getCursorCol(), getCursorRow(),
    <true|false>)` once at the current position (not routed through
    `setCursor`, since the position itself isn't changing — would
    otherwise do one redundant extra blit).
  - **A real ordering bug found while tracing `cls()`, not
    assumed — fixed as part of this change, not a separate pass:**
    `cls()` currently calls `setCursor(0, 0)` *before*
    `hal.clearScreen()` (`screen.ts:160-165`). Under the new
    `setCursor` hook, that would draw the inverted cursor at `(0,0)`
    and then immediately paint over it with `clearScreen()`'s
    full-framebuffer paper fill — cursor invisible right after `CLS`
    until the next cursor movement. Fix: reorder `cls()` to
    `hal.clearScreen()` *then* `setCursor(0, 0)`, so the redraw (if
    the cursor is visible) happens after the screen is actually
    clear. No behavior change for the `CURSOR-VISIBLE=FALSE` case
    (today's default) — `clearScreen()`/`setCursor()`'s own effects
    don't depend on their relative order when there's no redraw hook
    firing.
- `primitives.ts`: two `case` arms, `ctx.screen.showCursor()` /
  `ctx.screen.hideCursor()`. No `dictionary.ts`/`inner.ts`/`repl.ts`
  change — plain stack-effect-free primitives, same shape as `CLS`.

### Explicitly out of scope here

- **Blinking** — the user asked for enable/disable + static inverse
  video, not animation. A timed toggle would need to be driven from
  `packages/app`'s existing `requestAnimationFrame` render loop (the
  one place periodic redraw already happens, per `PORTING-WEB.md`'s
  "don't run the interpreter's hot loop, do drive rendering via rAF"
  rule) — not the engine, not Forth, since neither has any notion of
  wall-clock time today. Real, separate follow-on if wanted later.
- **Cat's split cursor** — named explicitly by the user as *not* this;
  a single `CURSOR-X`/`CURSOR-Y`-anchored cursor only.
- **Attribute file (per-cell `INK`/`PAPER`)** — a related but
  genuinely bigger, separate feature. Not needed for this design:
  cursor redraw only ever needs the *current global* `INK`/`PAPER`
  (see "restoring... costs nothing new" above), because no per-cell
  color exists to restore. **Named dependency for later**: if a
  per-cell attribute bank is ever added, `redrawCursorAt`'s "read
  `CHAR`, reapply *global* ink/paper" logic would need to instead
  pull the per-cell stored color for a non-cursor cell — a real
  future coupling between the two features, not decided now.
  `rebel-rom`'s own `SCREEN-MODULE.md` (§7) already frames
  palette/attribute modes as configurable-later, truecolor-as-default,
  so there's no existing cross-target fact to reconcile against
  either.
- No wiring `CURSEN` into `packages/app`'s boot sequence or the
  on-screen REPL (`repl.ts`'s `startRepl`) — whether the REPL prompt
  should show a live cursor while typing is a real, separate UX
  decision (same "primitive first, policy wired up separately" split
  M8/M9 already used), not decided by scoping the primitive itself.

### Verification — done

- A new `describe` block in `screen.test.ts`, using the exact
  `spyHal()`/`toHaveBeenCalledWith` technique the existing `CHAR!`/
  `EMIT`/`CLS` tests already use: `CURSEN` redraws the current cell
  inverted; moving the cursor (`AT-XY`) while visible restores the old
  cell and inverts the new one (asserted as two ordered
  `toHaveBeenNthCalledWith` calls); `CURSDIS` restores normal; an
  out-of-range `AT-XY` while visible doesn't throw; `CLS` shows the
  cursor at `(0,0)` *after* the framebuffer clear (the last `blitGlyph`
  call in the sequence), not painted over — the exact ordering bug
  this change also fixed, verified directly rather than just
  asserted-by-construction; a fresh `Machine` triggers zero extra
  `blitGlyph` calls when the cursor is never enabled (the "opt-in,
  zero overhead" claim, checked, not assumed).
- **One test written wrong on the first pass, caught immediately by
  the suite, not shipped**: a "typing a character draws it normally,
  not inverted" test assumed exactly two `blitGlyph` calls (content
  write, then inverted redraw at the new position). Actual: three —
  `EMIT`'s content write, then `setCursor`'s own "restore the old
  cell" redraw (which re-reads `CHAR` at the *old* position — now
  holding the just-typed character, not a space — and redraws it
  normally, a harmless duplicate blit exactly as this section's
  implementation sketch predicted), then the real inverted redraw at
  the new position. Confirmed against the built `dist/` via a
  throwaway `node -e` script before fixing the test, not guessed from
  the failure message. Fixed by asserting all three calls in order —
  the predicted redundancy became a real, checked test case instead
  of an assumption.
- Full engine suite: 244 passed (237 + 7). App suite (10) and both
  builds unaffected — no `dictionary.ts`/`inner.ts`/`repl.ts` change.
- Live, via WebMCP + screenshots (this genuinely needed visual
  confirmation — `read_screen`'s plain-text dump can't show a color
  change): `CLS 5 5 AT-XY CURSEN` showed a solid green block at
  column 5 (a space cell with `INK`/`PAPER` swapped, boot defaults
  green-on-black — a swapped blank cell renders as a solid block,
  exactly as expected) with nothing else on screen to confuse it.
  Confirmed the cursor block reliably tracks the REPL's own live
  typing position (it's driven by the same `CURSOR-X`/`Y` the
  `ACCEPT` echo already advances) by reading `CURSOR-X`/`Y` directly
  via `BANK@ SYSV 16 + @`/`BANK@ SYSV 20 + @` (`CORE`'s `baseOffset`
  16 plus each field's own offset) and cross-checking against where
  the block actually rendered — matched exactly once the REPL's own
  prompt-redraw cycle was accounted for (an early screenshot looked
  "wrong" until this cross-check showed it was actually correct — the
  block was always exactly where `ACCEPT`'s echo cursor legitimately
  was, not a bug, just an easy position to misjudge from a screenshot
  alone). `CURSDIS` removed the block cleanly on the next prompt.
  Zero console errors throughout.

## 18. Wiring `CURSEN` into the interactive REPL — done, M26

### Motivation

§17 shipped the mechanism but deliberately didn't wire it up — named
explicitly as a separate, undecided UX question ("whether the REPL
prompt should show a live cursor while typing"). Left as-is, the
on-screen REPL still booted with no visible cursor at all, unusable in
practice without a human remembering to type `CURSEN` first.

**Not as simple as defaulting the sysvar — checked, not assumed.**
`SCREEN.CURSOR-VISIBLE` defaulting to `TRUE` at boot would flip
`isCursorVisible()`'s answer, but nothing would actually *draw*
anything: the redraw only fires from inside `setCursor()`/
`showCursor()`/`hideCursor()`, never from the sysvar write itself, so
a bare default would sit invisible until the very first cursor
movement (the first keystroke) — not the "visible from the first
prompt" behavior actually wanted. And doing it in `Machine`'s
constructor (the only place that default would naturally go) would
affect *every* `new Machine()` caller — all 240+ engine tests,
`mmap.test.ts`, `low-level-batch.test.ts`, anything using
`interpret()`/`beginLine()` programmatically — not just the
interactive REPL, breaking §17's own "opt-in, zero overhead unless
enabled" contract and its own test asserting exactly that.

**The right entry point, confirmed from `repl.ts`'s own header
comment:** `startRepl()` is explicitly "a self-contained,
never-completing on-screen REPL," a different entry point from
`beginLine()`/`interpret()` ("feeding a line programmatically (tests,
mainly)") — the two share one session slot but are conceptually
distinct call sites. A single `this.screen.showCursor()` call at the
top of `startRepl()` (before the generator that drives the actual
prompt loop is even created) shows the cursor immediately, at
`(0, 0)`, before the first `'> '` is even emitted — then the very
first `emitString('> ')` call naturally moves and redraws it, via the
same `setCursor()` hook §17 already built, to right after the prompt.
Zero changes to `replLoop()` itself, `app.ts`, or any programmatic
caller.

### Implementation

- `repl.ts`: one line, `this.screen.showCursor();`, added at the top
  of `startRepl()`.

### Verification

- Two new tests in `screen.test.ts`'s existing cursor `describe`
  block: `startRepl()` shows the cursor immediately (asserted via
  `spyHal`, one inverted `blitGlyph` call at `(0,0)` — the prompt
  hasn't even been emitted yet at that point, confirming this doesn't
  wait for the first `step()`); a plain `interpret()` session never
  shows a cursor (confirms §17's opt-in contract survives this change
  — checked directly, not just assumed from "I only touched
  `startRepl()`").
- Full engine suite: 246 passed (244 + 2), all pre-existing tests
  unchanged — direct confirmation that scoping this to `startRepl()`
  really did leave every programmatic caller untouched. App suite (10)
  and both builds unaffected.
- Live, via WebMCP + screenshots: a fresh page load now shows the
  cursor block immediately after the very first `>` prompt, with no
  keystroke needed — the actual gap this section closes, confirmed
  visually, not just by a passing test. Typing `2 3 +` and pressing
  enter showed the block correctly move to the next prompt line
  afterward. Zero console errors.

## 19. Cross-repo heads-up gap, found and closed

M23 ( §15, low-level primitives)/M24 (§16, `BASE`/`HEX`/`DECIMAL`)/M25
(§17, visible cursor) all shipped without a corresponding
`rebel-rom/CHANGES.md` entry, unlike `MMAP` (§11-§14), which got one
at every stage. Checked, not assumed, before deciding what (if
anything) needed backfilling: M23/M24 are pure primitive-token
additions with no real C++ analog to reconcile against yet
(`rebel-rom`'s Forth executor doesn't exist — *every* token in
`rebel-opcodes.json` is equally something a future Phase 11 would need
to mirror wholesale, not a specific fork-point decision the way
`MMAP`'s memory-layout choice was) — nothing added there. M25's new
`SCREEN.CURSOR-VISIBLE` sysvar is different in kind: a real
`TScreenSysVars` layout proposal, explicitly flagged in its own scoping
section as "the reverse of this group's usual direction... a genuine
cross-target candidate," the same category of fact `CORE.ARENA-SIZE`
(M19) was in — and that one *did* get a `CHANGES.md` mention at the
time. A matching entry for the cursor design was added to
`rebel-rom/CHANGES.md` to close this gap (untracked file in that sibling
repo, not committed there, same as every prior entry — a heads-up for
whoever picks up `rebel-rom`'s own Forth phase, not a coordinated
cross-repo commit).

## 20. A real bank-naming collision bug, found while reviewing storage — done, M27

### The bug, found by reviewing, not assumed

Asked to review whether `CREATE-BANK` (Forth-side, M21) gets the same
storage treatment as host-created banks. The read side was already
fine (M22 made `getAllBanks()`/`findBank()`/`saveAsset()`/
`openProject()` uniform regardless of a bank's origin) — but tracing
`CREATE-BANK`'s primitive (case 100) turned up a real, reproducible
bug: it calls `ctx.banks.mmap.allocate()` directly, bypassing the
name-uniqueness check `BankTable.createBank()` enforces for every
other creation path. Since `CREATE-BANK` always named a bank after its
own tag, two Forth-created banks sharing a tag always collided on
name too. Reproduced directly against the built engine before writing
anything:

```
64 CREATE-BANK DATA   → addr 84916, name "DATA"
64 CREATE-BANK DATA   → addr 84980, name "DATA"   -- same name!
```

Two concrete, reproduced storage-layer failures followed from this:
`saveAsset()` writes to `${name}.${ext}` — both banks target the exact
same file, so the second save silently overwrites the first's data,
no error, no warning. `openProject()` calls the *checked*
`BankTable.createBank()` when reconstructing banks from disk — a name
collision there throws `bank name ... already exists` and **aborts the
whole project load**, not just skipping the one bad file the way every
other malformed-asset case (short read, bad extension, oversized
payload) is handled gracefully. Both reproduced end-to-end against a
real in-memory `StorageHal`, not just inferred from reading the code.

### Design arc — two false starts, worth recording

**First proposal: give `CREATE-BANK` its own uniqueness check,
throwing on collision.** Rejected — the user's counter-proposal was
better: don't fail, just make the name unique, the same way any
*host*-side `createBank()` call already does when it doesn't care
about a stable name (`BankTable`'s private `nextSerial`
counter/`generateSerialName()`, mirroring `CBankTable::
GenerateSerialName`).

**Second proposal: expose `generateSerialName()` publicly so the
primitive could call it.** Rejected on sight — "just make something
internal public" doesn't make the counter *shared*, it just gives one
more caller access to the same private field, and `CREATE-BANK` still
couldn't reach it anyway (M21's whole point was zero host round-trip
— reaching into `BankTable` at all would undo that).

**Third proposal: back the counter with a sysvar (`FORTH.NEXT-BANK`),
with `BankTable` gaining an `attachSysvars()` method to bridge the
boot-order gap** (`Sysvars` doesn't exist until *after* `BankTable`
has already created the `SYSV` bank itself — a real chicken-and-egg
problem, confirmed by reading `repl.ts`'s actual constructor order,
not assumed). Worked, but the user called it correctly: **too
convoluted** — an attach lifecycle, a dual-mode counter (private
field pre-attach, sysvar post-attach), and a seed-the-sysvar-from-the-
private-counter step, all just to solve a boot-ordering problem that
has a much simpler answer.

**What actually shipped: put it in `MMAP`'s own header.** `MemoryMap`
is constructed and fully usable from the *very first line* of
`BankTable`'s constructor — before `Sysvars` exists at all, before
`SYSV` itself is even registered. No chicken-and-egg problem, no
attach step, no dual-mode counter: `BankTable`'s own fallback and
`CREATE-BANK`'s primitive both just call the same
`MemoryMap.nextBankSerial()` method directly.

### The header grows: 4 bytes → 16

```
offset 0-1: magic ('M','M')
offset 2:   version
offset 3:   reserved
offset 4:   NEXT-BANK   — the shared bank-naming counter (this fix)
offset 8:   ARENA-SIZE  — moved out of the old CORE.ARENA-SIZE sysvar
offset 12:  ARENA-ID    — reserved, always 0 today
```

**Worth naming explicitly: this isn't the same kind of state M22
removed.** M22's `nextFree`/`slotCount` cursor cells were *derivable*
by scanning existing slots — genuinely redundant cached state that
could drift, so M22 deleted them outright. A bank-naming serial is
different in kind: it has to persist monotonically across the table's
whole lifetime (never repeat, even once bank deactivation exists),
which scanning current occupancy alone can't give you. Necessary
persistent state, not a redundant cache — the same reasoning that
already justified keeping `nextSerial` as a real field before this
change, just relocated to be arena-resident and genuinely shared.

**`ARENA-SIZE` moved out of `CORE`, on the same principle the user
named directly**: it's arena/bank-table bookkeeping, not
Forth-interpreter-observable state the way `CURSOR-X`/`BASE`/`STATE`
are — it belongs with `MMAP`, not mixed into `SYSV`. Checked blast
radius before moving it, not assumed: only one test read it
(`bank-access.test.ts`), and `app.ts`'s inspector panel already reads
`arena.sizeBytes` directly, never the sysvar — safe, low-risk move.
Still reachable from Forth exactly the same way, just through a
different bank: `BANK@ MMAP 8 + @` instead of
`BANK@ SYSV <core-offset> + @`.

**`ARENA-ID` is reserved, not built** — the user's own call: "for
future multi-arena bookkeeping, like a counter on the arena creation
side... right now 0 is ok as well." No consumer anywhere today
(checked — first time the concept appears in this codebase at all).
Written as `0` by `initHeader()`, documented as inert, same precedent
as `RESIDENT`/`EXTERNAL`/`SWAPPABLE`/`DIRTY`'s reserved bank flags —
add real meaning the day multi-arena support actually needs it, not
before.

### Implementation

- `mmap.ts`: `HEADER_SIZE` 4→16. `initHeader()` also writes
  `NEXT-BANK=0`, `ARENA-SIZE=this.arena.sizeBytes` (already available —
  `MemoryMap` holds its own `Arena` reference, no new parameter
  needed), `ARENA-ID=0`. New `nextBankSerial(): number` — reads
  `NEXT-BANK`, writes it back incremented, returns the pre-increment
  value (matches the old private field's exact `nextSerial++`
  semantics).
- `banks.ts`: `BankTable`'s private `nextSerial` field removed
  entirely. `generateSerialName()` becomes one line:
  `String(this.mmap.nextBankSerial()).padStart(BANK_NAME_LEN, '0')`.
- `primitives.ts`: `CREATE-BANK` (case 100) builds its name the same
  way, calling `ctx.banks.mmap.nextBankSerial()` directly — still zero
  `BankTable` round-trip, M21's design goal intact.
- `repl.ts`: the `CORE.ARENA-SIZE` sysvar write deleted — `MMAP`'s own
  `initHeader()` (already running as part of `new BankTable(this.arena)`
  a few lines earlier) covers it now.
- `rebel-opcodes.json`: `CORE.ARENA-SIZE` field removed from
  `sysvarGroups`.

### Verification

- Five pre-existing tests broke exactly as predicted while scoping
  this (checked against real code before writing anything, not
  guessed from a test-runner error afterward): `bank-access.test.ts`'s
  `CORE.ARENA-SIZE` test (sysvar gone — rewritten to read `MMAP`'s
  header instead); `mmap.test.ts`'s raw-`@`-read test (hardcoded old
  `HEADER_SIZE=4` in its own slot-address formula — updated to `16`);
  three `CREATE-BANK` naming tests whose premise was "name equals tag"
  — inverted, same pattern M22 already used once for a different test
  in this same file.
- Two new tests added, not just fixes: one confirms the counter is
  genuinely shared by *interleaving* host-side and Forth-side creation
  (`createBank()`, `CREATE-BANK`, `createBank()` again) and checking
  all three names are sequential and distinct — proves real sharing,
  not two counters that happen not to collide by accident of nothing
  else calling one of them. The other is an end-to-end `storage.test.ts`
  case reproducing the *original* bug scenario (two same-tag
  `CREATE-BANK` banks) all the way through `saveAsset()`/
  `openProject()`, confirming both survive as distinct files with
  their original byte content intact — the real motivating failure,
  fixed, not just a unit assertion on `MemoryMap` in isolation.
- Full engine suite: 248 passed (246 + 2 new, 5 rewritten). App suite
  (10) and both builds unaffected.
- Live, via WebMCP: fresh `Machine`'s `read_banks` showed `MMAP` at
  `1552` bytes (up from `1540`, the exact `+12` the two new header
  cells account for), every other bank's base shifted down by exactly
  12 — and, confirming the new mechanism reproduces old behavior
  exactly, `SYSV`/`DSTK`/`RSTK`/`DICT`/`CHAR`/`KMAP` still show
  `00000000` through `00000005`, byte-identical to before this change.
  `64 CREATE-BANK DATA` typed twice in a row produced `00000006` and
  `00000007` — no collision, continuing the exact same sequence the
  boot-time banks used. Zero console errors.

### Scope cuts, explicit

- `ARENA-ID` stays `0`/reserved — no semantics decided, per the user's
  own call.
- No change to `openProject()`'s error handling (still aborts the
  whole load on a name collision) — the realistic trigger for that is
  gone now that names can't collide, so the defensive hardening
  discussed earlier (skip the one bad file instead of aborting) is no
  longer motivated by a live bug; revisit only if a real trigger
  resurfaces.
- `MMAP`'s slot byte layout is still not a finalized cross-target
  contract (`DEVELOPING.md` §11/§14's existing note) — this change
  grows the *header*, not the slot layout, same open question either
  way.

## 21. `SP@`/`SP!`/`SP0`, `RP@`/`RP!`/`RP0` — the stack pointer becomes a real sysvar, not a private field — done, M28

### Motivation

Asked (a Forth-tutorial question): why no `SP0`/`SP@`? Checked, not
assumed: `FORTH.SP0`/`RP0` are already reserved in `rebel-opcodes.json`
(offsets 0/4 of the `FORTH` sysvar group) but never written —
`"reserved (M1-M3 hardcode the DSTk/RSTK bank size instead)"`. The real
state lives somewhere else entirely: `DataStack` (`stack.ts:16`) keeps
its own `private sp: number`, mutated directly by `push`/`pop`/`peek`/
`clear`, with no arena address at all.

That's the same shape of problem M27 (§20) fixed for the bank-naming
counter — an internal field standing in for what should be the one
real place this state lives — except here the correct fix isn't a new
arena location, it's routing through the mechanism that already
exists for exactly this: `Sysvars`. `HERE`/`LATEST`/`BASE`/`STATE`
already work this way — `repl.ts`/`primitives.ts` never cache a copy,
they call `sysvars.get(...)`/`.set(...)` every time, and `Screen`/
`Keyboard` both take a `Sysvars` reference in their constructor rather
than mirroring sysvar-owned state locally. `DataStack` is the one
piece of engine state that never got that treatment — this closes that
gap, not just adds three new words.

### Design

**Two sysvar fields per stack, not one.** `SP0`/`RP0` (already
reserved) hold the *base* — the constant address the stack's `sp`
equals when empty, written once at construction and never mutated
again. Two new fields, `SP`/`RP` (offsets 24/28 in the `FORTH` group —
next free after `STATE` at 20), hold the *live* pointer — read and
written on every single `push`/`pop`/`peek`/`clear`, replacing
`stack.ts`'s private field outright rather than shadowing it.

**`DataStack` takes a `Sysvars` reference and two field names, not a
bank alone.** `Sysvars` already exists well before either stack is
constructed (`repl.ts:159` vs. `196`-`197` — no ordering problem, the
same fact that ruled out M27's rejected `attachSysvars()` detour
applies here too, except this time there's no chicken-and-egg problem
to begin with).

```ts
export class DataStack {
  constructor(
    private readonly arena: Arena,
    private readonly bank: Bank,
    private readonly sysvars: Sysvars,
    private readonly baseField: 'SP0' | 'RP0',
    private readonly liveField: 'SP' | 'RP',
  ) {
    const empty = bank.base + bank.size;
    sysvars.setUnsigned('FORTH', baseField, empty);
    sysvars.setUnsigned('FORTH', liveField, empty);
  }

  private get sp(): number {
    return this.sysvars.getUnsigned('FORTH', this.liveField);
  }
  private set sp(value: number) {
    this.sysvars.setUnsigned('FORTH', this.liveField, value);
  }

  // depth/push/pop/peek/clear: unchanged bodies, `this.sp` now a
  // sysvar-backed accessor instead of a field — every call site reads
  // as before, nothing about the bounds-checking logic changes.
}
```

A private getter/setter pair named `sp` keeps every existing call site
in `push`/`pop`/`peek`/`depth`/`clear` textually unchanged — the fix is
entirely in where the four bytes actually live, not in the stack's own
logic.

**`repl.ts:196`-`197`** becomes:

```ts
this.stack = new DataStack(this.arena, dstkBank, this.sysvars, 'SP0', 'SP');
this.rstack = new DataStack(this.arena, rstkBank, this.sysvars, 'RP0', 'RP');
```

### The words

| Token | Word | Stack effect | Notes |
|---|---|---|---|
| 119 | `SP0` | `( -- a-addr )` | Pushes `FORTH.SP0` — the constant empty-stack address. |
| 120 | `SP@` | `( -- a-addr )` | Pushes `FORTH.SP` — the live pointer, i.e. the address of the current top-of-stack cell (or `SP0` if empty), matching the standard Forth contract (the value *before* `SP@`'s own push). |
| 121 | `SP!` | `( a-addr -- )` | Pops an address, writes it straight into `FORTH.SP` — the standard `SP0 SP!` stack-reset idiom, and the general mechanism `THROW`/`CATCH` would eventually build on. |
| 122 | `RP0` | `( -- a-addr )` | Same as `SP0`, for the return stack. |
| 123 | `RP@` | `( -- a-addr )` | Same as `SP@`, for the return stack. |
| 124 | `RP!` | `( a-addr -- )` | Same as `SP!`, for the return stack. **Real, not theoretical, danger**: the return stack holds live return addresses for every word currently executing (`inner.ts`) — an `RP!` to a wrong address mid-execution corrupts the call chain exactly the way clobbering a native call stack would. Standard Forth semantics, not a bug to guard against here; same "authentic risk, no host-side validation" stance `MMAP` already takes (§11) for raw writes. |

`SP@`/`SP!`/`RP@`/`RP!` all implemented generically over `ctx.stack`/
`ctx.rstack` — `case 120` reads `s.getPointer()` (a new public method
mirroring the private getter above, `push`/`pop` stay as they are),
`case 123` reads `ctx.rstack.getPointer()`; symmetric for `case 121`/
`124` with a new `setPointer(addr)`.

### Implementation sketch

- `stack.ts`: `DataStack` constructor gains `sysvars`/`baseField`/
  `liveField` params; private `sp` field replaced by a private
  getter/setter over `sysvars.getUnsigned`/`setUnsigned('FORTH', ...)`;
  new public `getPointer()`/`setPointer(addr)` (thin wrappers over the
  same getter/setter, the only way `primitives.ts` reaches the value —
  keeps `sp` itself private, same encapsulation as today).
- `rebel-opcodes.json`: `FORTH` group gains `SP`/`RP` fields (offsets
  24/28); 6 new primitive entries, tokens 119-124.
- `primitives.ts`: 6 new cases, each a couple of lines — `SP0`/`RP0`
  push `sysvars.getUnsigned('FORTH', 'SP0'/'RP0')` directly (no need to
  route through `DataStack` for the constant); `SP@`/`RP@`/`SP!`/`RP!`
  call the new `getPointer()`/`setPointer()`.
- `repl.ts:196`-`197`: the two `DataStack` constructions gain the new
  arguments, as above.
- `stack.test.ts`'s `newStack()` helper (constructs a bare `DataStack`
  for unit tests) needs a `Sysvars` instance too — a small, local
  `SYSV` bank + `new Sysvars(...)`, matching how other unit-test files
  already build a minimal `Sysvars` when they need one in isolation
  from a full `Machine`.

### A real hot-path cost, worth naming rather than hand-waving

Every `push`/`pop`/`peek` now does one `DataView` read/write through
`Sysvars.getUnsigned`/`setUnsigned` where it used to be a plain JS
field access — the same order of magnitude as the cell read/write
`push`/`pop` already do against the stack's own bank (arena access is
already the dominant cost in this loop, not JS field access), so no
expected observable slowdown, but not verified with a benchmark before
this lands — worth a sanity check against `inner.ts`'s existing test
suite timing, not a formal perf test, if the full suite's wall time
visibly moves after implementing.

### Scope cuts, explicit

- No `THROW`/`CATCH` — `SP!`/`RP!` are the mechanism a future exception
  system would use, not the system itself. Flagged as a natural next
  candidate, not scoped now.
- No bounds-checking on `SP!`/`RP!` beyond what already exists — a
  address written via `SP!` that lands outside `DSTK`'s bank isn't
  caught until the next `push`/`pop`/`peek` bounds-checks against it
  and throws. Same "authentic risk" stance as `RP!`'s note above.
- `SP0`/`RP0` stay read-only in practice (nothing stops `SP0 !`
  overwriting the constant via raw memory access, same as `HERE`/
  `LATEST` today) — no dedicated immutability enforcement, consistent
  with how every other "variable-shaped" sysvar in this codebase
  already behaves.

### Verification — done

- `stack.test.ts`: existing suite untouched in behavior — the four
  original tests (LIFO push/pop, depth/toArray, underflow, overflow)
  pass unmodified against the new `Sysvars`-backed accessor, plus its
  `makeStack()` helper now builds a real `SYSV` bank + `Sysvars`
  instance. New `describe` block: `SP0`/`SP` both equal `bank.base +
  bank.size` at construction; `getPointer()` moves by exactly one cell
  per push/pop and matches the address the top cell actually lives at
  (read back via a raw `arena.readCell`); `SP0` never moves while `SP`
  does; `setPointer()` given a saved `getPointer()` value restores
  depth exactly (the reset idiom); two `DataStack` instances sharing
  one `Sysvars` (distinct `SP0`/`SP` vs. `RP0`/`RP` field names) stay
  fully independent.
- New `describe` block appended to `low-level-batch.test.ts` (same home
  as §15/§16, not a separate file): `SP0` equals `SP@` on a freshly-
  emptied stack; `SP@` decreases by 4 per push; `SP@ ... SP!`
  round-trips depth to zero; `SP0 SP!` empties the stack directly;
  `RP@ RP0 -` inside a running colon word is negative (return stack
  genuinely holds a live return address mid-call, not just at the top
  level); `RP0`/`RP@` stay equal at the top level regardless of how
  much the *data* stack grows (the two pointers are genuinely
  independent, not aliased).
- Full engine suite: 259 passed (248 + 11 new). App suite (10) and both
  builds green. One `app.spec.ts` failure seen on the first run
  (`stackAtPause` empty at a breakpoint pause) turned out to be
  pre-existing flakiness, not a regression — confirmed by running the
  suite unchanged (`git stash`) and getting the same intermittent
  failure pattern across repeated runs on both old and new code.
- Live, via WebMCP: `SP0 .` → `9744` (= `DSTK`'s `base + size` from
  `read_banks`, `5648 + 4096`); `SP@ .` on an empty stack also `9744`;
  `1 2 3 SP@ . .S` → `9732` then `1 2 3` (confirms `SP@` reflects the
  live depth mid-line, and doesn't disturb the stack it's inspecting);
  `SP0 SP! .S` after that empties it (`.S` prints nothing); a defined
  word `: DEPTH-INSIDE RP@ RP0 - . ;` prints `-4` when called — the
  inner interpreter's own top-level return-address sentinel, real and
  observable through `RP@`/`RP0`, not simulated. Zero console errors.
  One genuine gotcha reproduced live, same shape as M24's `HEX 255 .`
  one: `SP0 SP@ = .` typed as a single line prints `0` (FALSE), not
  `-1` — `SP@` executes *after* `SP0`'s own push has already moved the
  live pointer down by one cell, so the two aren't comparing the same
  moment in time. Not a bug — `SP@`'s whole point is reading the
  pointer live, and a line with two stack-pointer words in sequence
  will always see it move between them, same as any other stack word.
