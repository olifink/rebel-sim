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

## 10. Forth-visible bank access (`BANK@`) — scoped, not yet built

`FORTH-ARCHITECTURE.md` §9 item 4 has flagged this as open since it was
written: whether the bank table needs to become arena-resident memory
Forth walks via raw address arithmetic, or whether an API-mediated
primitive (calling into the host bank table, the way `CBankTable::
FindBank` already exists in C++) is sufficient — "`docs/MEMORY-MODEL.md`
§3.2 explicitly left this as a 'revisit once Forth is actually
reading/writing through it' question." Raised directly (2026-08-02):
shared banks should probably be reachable the same way, by type — which
surfaced a real, previously-unflagged problem this section exists to
resolve before picking a mechanism, not after.

### The finding that shapes this design: memory-access isolation isn't enforced anywhere today

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
level once an address is computed. This isn't flagged anywhere in
`rebel-rom`'s own docs — a genuine gap surfaced by asking "should
shared banks be `BANK@`-reachable too," not a restatement of something
already tracked.

**Rebel-Sim already has a structural advantage here it isn't exploiting
yet.** Checked `arena.ts`: it does zero bounds-checking of its own — it
relies entirely on `DataView`, and (confirmed empirically, `node -e`)
`DataView` throws a real `RangeError` on any out-of-range offset,
positive or negative. So a Rebel-Sim arena already can't be corrupted
from *outside its own `ArrayBuffer`* — a guarantee bare-metal C++
cannot get for free. That boundary is around the *whole arena* today,
not per-bank — within one arena's buffer, `KMAP` is exactly as exposed
as `DICT` is, matching Rebel-ROM. But it points at a real option once
multi-arena lands here: put genuinely-shared banks in a **separate
`ArrayBuffer`** that a per-arena Forth program is never handed a raw
offset-space into at all — real enforcement, essentially for free, via
the same JS mechanism, rather than mirroring Rebel-ROM's "just more
flat address space" approach by default.

### Design direction: API-mediated, not an arena-resident table

Given the isolation gap above, an arena-resident bank table Forth walks
via raw `@`/`C@` (`FORTH-ARCHITECTURE.md` §9 item 4's first option) is
the wrong direction to build toward: once the table is just memory,
there's no interception point left for a future access-control decision
("which banks can this arena's Forth code reach," left unresolved
below) to hook into — the data being readable *is* the access. A
primitive is the right shape precisely because it's a checkpoint: today
it can just
answer "where's the bank with this tag," and later, once multi-arena
and shared-bank policy are actually decided, the same call site is
where "is the caller's arena allowed to see this bank" would get
checked, with zero redesign.

**`BANK@ ( "tag" -- addr size )`** — parses the next input token
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

**Descriptor kept minimal, on purpose:** just `addr`/`size`, not the
full `{tag, name, base, size, flags}` shape `Bank`
(`banks.ts`)/`BankDescriptor` (`membank.h`) already carry internally.
`name` needs no exposure yet — nothing in Forth source today needs to
disambiguate same-tag banks (the multiple-`DATA`-banks case is a
storage/project-loading concern that doesn't touch Forth source
directly). `flags` doesn't exist on Rebel-Sim's own `Bank` interface at
all today (no `RESIDENT`/`EXTERNAL`/`SWAPPABLE`/`DIRTY` — `SCRN` isn't
even an arena bank in Rebel-Sim, per `rebel-opcodes.json`'s own note),
so there's nothing real to return yet. Both are documented future
extensions (`BANK-NAME@`, a flags cell), not built ahead of an actual
need for them.

### Shared-bank access control: deliberately not resolved here

This section fixes the *shape* (a primitive, not raw address
arithmetic) specifically so a real access-control decision doesn't
require retrofitting the mechanism later — it does not make that
decision. Rebel-Sim has zero multi-arena support today (`Machine`'s
constructor creates exactly one `Arena`, unconditionally,
`HAL.md` §3), so there is currently nothing to distinguish "this
arena's own bank" from "a shared bank" — every bank `BANK@` could ever
find lives in the one arena that exists. `BANK@` as scoped here works
correctly and identically for that entire single-arena case with zero
access-control logic, and stays forward-compatible with adding it once
multi-arena is actually being built.

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
- No `flags` in the returned descriptor — nothing on the Rebel-Sim side
  has one yet.
- No shared-bank / cross-arena access-control policy decided — this
  section is preparation for that decision (the right mechanism shape),
  not the decision itself. Revisit once multi-arena is actually being
  built on the Rebel-Sim side, not before.
- No arena-resident bank table (the rejected direction, reasoning
  above) — API-mediated only.
- Not implemented ahead of an actual need. This scoping exists so the
  shape is right *when* a need appears (multi-arena landing, or a Forth
  program wanting to dynamically discover another bank's extent),
  matching this project's standing "minimum real mechanism, don't build
  ahead of a concrete need" discipline (`CLAUDE.md`).
