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
this document is currently working at. Expect this to grow across
several sessions as that infrastructure actually gets built, rather
than being written once and left alone.

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

## 7. `S"`/`."` — real interpret-time behavior (open, not yet built)

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
should be removed.

**A real, tested-behavior change, confirmed by checking, not
assumed:** `strings.test.ts`'s `'S" is compile-time only for now —
throws a clear error while interpreting'` asserts today's throw
outright and would need rewriting to assert the new dual-mode
behavior instead.

**Open, not resolved here:** where does the transient scratch text
live? Classic Forth has a dedicated `PAD` region for exactly this kind
of overwritten-on-next-use scratch text; this engine doesn't have one
yet — worth deciding whether that's a small reserved scratch area (a
new bank, or a corner of an existing one) before building this, not
assumed.
