# Rebel-Sim Build Plan

## Context

`FORTH-ARCHITECTURE.md` and `PORTING-WEB.md` specify what Rebel-Sim must
be; nothing has been built yet. This document tracks the actual build
roadmap so future sessions (human or agent) know what's done, what's
next, and why the early decisions were made the way they were. Decisions
below were made explicitly with Oliver on 2026-07-29 rather than assumed.

**Key decisions locked in:**
- **First milestone**: a minimal working REPL — real engine, plain-text
  I/O, no canvas/bitmap-font, no keyboard queue, no storage yet. Prove the
  core mechanism (arena → banks → sysvars → token-threaded dispatch) end
  to end before adding browser-presentation layers.
- **Workspace shape**: npm workspaces, two packages — `packages/engine`
  (plain TypeScript, zero Angular deps) and `packages/app` (Angular
  shell). The package boundary itself enforces
  `PORTING-WEB.md` §1's "engine doesn't know Angular exists" rule, rather
  than relying on folder-convention discipline.
- **Execution model**: interpreter runs on the main thread for now, via
  `NgZone.runOutsideAngular()`. Web Worker migration is a later, separate
  decision once something concrete needs real preemption — not designed
  in from day one.
- **Opcode/sysvar source of truth**: `FORTH-ARCHITECTURE.md` §0 expects
  one generated artifact shared with the Rebel-ROM repo; that repo isn't
  available here. We define our own provisional source-of-truth file in
  this repo now, clearly marked as provisional/to-reconcile, so work
  isn't blocked waiting on cross-repo coordination.

## Roadmap (milestones beyond the current one, for context)

1. **M1 — Minimal working REPL** *(this plan's focus, detailed below)*
2. **M2 — Colon-definitions & dictionary**: `DICT` bank, dictionary header
   layout (§6), `:`/`;`/`IMMEDIATE`, real return-stack usage, a proper
   compiler/interpreter STATE split.
3. **M3 — Screen**: `CHAR` bank, canvas framebuffer, bitmap-font blitting,
   `hal_emit`/`hal_plot_char`/`hal_draw_*` (§7).
4. **M4 — Keyboard**: raw event capture → non-blocking ring buffer →
   keymap translation, blocking `KEY` word layered on top (§7, `PORTING-WEB.md` §4).
5. **M5 — Storage**: OPFS-backed projects/carts model, `SCRS` bank,
   `hal_block_read`/`write` (§7, `PORTING-WEB.md` §5).
6. **M6 — PWA packaging**: manifest, service worker precache,
   `navigator.storage.persist()` (`PORTING-WEB.md` §7).
7. Later/open: multi-arena isolation, `hal_error`/exception model,
   Web Worker migration — see `FORTH-ARCHITECTURE.md` §9 and
   `PORTING-WEB.md` §9 for the full open-decisions list.

Each milestone gets its own detailed plan when it starts; only M1 is
detailed now.

---

## M1 — Minimal Working REPL — **done** (2026-07-29)

Implemented as `packages/engine` (`Arena`, `BankTable`, `Sysvars`,
`DataStack`, `executePrimitive`, `Machine`) + `packages/app` (single
terminal-style Angular component). 20 primitives, `SYSV`+`DSTK` banks,
line-based outer interpreter, no dictionary/colon-definitions yet (M2).
15 engine unit tests + 3 app tests pass; verified live in a headless
Chromium browser (`2 3 + .` → `5`, `5 DUP + .` → `10`, `1 2 SWAP` →
stack `1 2`), no console errors. Original plan below, kept for record.

**Goal:** type `2 3 + .` into a browser page, see `5` printed. That proves
the arena/bank/sysvar/token-threading mechanism for real, with the
smallest possible browser-presentation layer (plain text, no canvas).

### 1. Workspace scaffolding

- npm workspaces root `package.json` (`workspaces: ["packages/*"]`).
- `packages/engine`: plain TypeScript library, own `package.json` +
  `tsconfig.json`, no Angular/DOM dependency. Built with `tsc` (or `tsup`/
  `vite` in library mode — decide when scaffolding, keep it simple).
- `packages/app`: generated via `ng new` (standalone components,
  current Angular CLI defaults — v22 is installed locally), depending on
  `packages/engine` as a workspace dependency.
- Root-level scripts to build/test both packages; confirm Angular 22's
  default unit-test runner when scaffolding (don't assume Karma vs.
  Vitest — check what `ng new` sets up) and mirror that choice for the
  engine package if reasonable, otherwise use Vitest for the engine since
  it needs no browser/DOM shimming.

### 2. Engine core (`packages/engine`)

- **`arena.ts`** — `ArrayBuffer` + `DataView` wrapper exposing
  `readCell(offset)`/`writeCell(offset, value)`/`readByte`/`writeByte`,
  the *only* place `DataView` methods are called directly, always with
  `littleEndian: true` (§2). Cap addressable region at 2^32 bytes (§1).
- **`banks.ts`** — bank table: `createBank(tag, name, sizeClass)` /
  `findBank(tag, name)`, each bank recording base offset + size within
  the arena, never relocated once created (§3). For M1, only the banks
  actually used get created: `SYSV`, `DSTK`. (`DICT`/`RSTK`/`CHAR` arrive
  in M2/M3 when something needs them — no point standing up unused banks
  now.)
- **`rebel-opcodes.json`** (or `.ts`) — the provisional source-of-truth
  file per §0, scoped to what M1 needs: primitive token IDs (`DOCOL = 0`,
  then the ~15–20 primitives below), the `FORTH` sysvar group's offsets
  (`SP0`, `HERE`, `BASE`, `STATE` — `RP0`/`LATEST` unused until M2 but
  fine to reserve now), and the two bank tags in use. Header comment
  states plainly: *provisional, authored in Rebel-Sim, needs reconciling
  against Rebel-ROM's actual layout once that's available* — not
  presented as if it were the real cross-repo artifact.
- **`sysvars.ts`** — thin accessors over the `SYSV` bank using the
  offsets from the generated table (`getBase()`, `getState()`, etc.),
  mirroring `docs/SYSVARS.md`'s grouped-offset shape at the scale M1
  needs.
- **`stack.ts`** — data stack push/pop against the `DSTK` bank, growing
  down, bounds-checked against `SP0` (§3).
- **`primitives.ts`** — the inner interpreter: a `switch` on token ID
  (§5) implementing arithmetic (`+ - * / MOD`), stack ops
  (`DUP DROP SWAP OVER ROT`), comparison (`= < > 0=`), logic
  (`AND OR INVERT`), and I/O (`. EMIT CR` — for M1, `EMIT`/`.` write to a
  simple output-string buffer the engine exposes, not a real `hal_emit`
  yet, since there's no `CHAR`/`SCRN` bank until M3). No `DOCOL`/colon-word
  case yet — M1 has no compiler, so every token dispatches straight to a
  primitive; that branch of §5's dispatch rule is proven in M2.
- **`repl.ts`** — the outer interpreter: given a line of text, whitespace-
  tokenize, and for each token either parse it as a number (push literal)
  or look it up by name in a small primitive name→token-ID table and
  execute it immediately. No dictionary search yet (no user-defined words
  until M2) — just the fixed primitive table.
- Boolean convention (`TRUE = -1`) honored anywhere a primitive produces
  a flag (`= < > 0=`), per §7, even though no HAL call exists yet — get
  the convention right at the first point flags are produced, not
  retrofitted in M3+.

### 3. Angular shell (`packages/app`)

- One component: a text input (line-at-a-time, not a raw-keydown queue —
  that's M4's job) feeding `repl.ts`, and a scrollback `<pre>`/list
  rendering the engine's output buffer plus the current stack contents
  (handy for debugging the engine itself).
- Interpreter calls wrapped in `NgZone.runOutsideAngular()`; only the
  result (new output lines, new stack snapshot) crosses back into the
  zone to trigger a render. Real payoff shows up later once the loop runs
  many primitives per keystroke, but establish the pattern now so it's
  not a retrofit.
- No canvas, no bitmap font, no PWA manifest work yet — explicitly out of
  scope for M1 per the milestone goal above.

### 4. Tests

- Engine: unit tests per primitive (stack effects), a few multi-word
  expressions end-to-end through `repl.ts` (`"2 3 + ."` → output `"5 "`),
  an endianness round-trip test (write via `writeCell`, read raw bytes,
  confirm little-endian byte order) since that's the one bug class the
  docs call out as silently working "in isolation" and breaking later.
- App: minimal — confirm the component wires input → engine → output
  without needing full Angular TestBed ceremony beyond what's necessary.

### Verification

- `npm run build` (or per-package equivalent) succeeds for both packages.
- `npm test` runs engine unit tests headless (fast, no browser).
- `ng serve` in `packages/app` boots to a page where typing
  `2 3 + .` and submitting shows `5` in the output pane, and `DUP` /
  `SWAP` / a few others behave correctly — actually run this in a browser
  before calling M1 done, per this repo's own "test the golden path in a
  browser" standard.

### Explicitly deferred out of M1 (don't build ahead)

Colon-definitions, dictionary/`DICT` bank, real return-stack usage,
canvas/`CHAR` bank, bitmap fonts, keyboard queue, storage, PWA packaging,
multi-arena, Web Worker migration, `hal_error`/exceptions. All real, all
scheduled in the roadmap above, none needed to prove M1's goal.

---

## M2 — Colon-Definitions & Dictionary — **done** (2026-07-29)

**Goal:** `: SQUARE DUP * ; 5 SQUARE .` → `25`, with a *real* dictionary
and a *real* DOCOL/return-stack threaded call, not a shortcut.

**What shipped:**
- `dictionary.ts` — the §6 header layout byte-for-byte (4-byte link
  pointer / 1-byte flags+length / zero-padded name / 4-byte-aligned Code
  Field), `writeHeader`, `findWord` (chain walk, skips `HIDDEN`,
  most-recent-wins on shadowing), `markLatestImmediate`, `compileCell`,
  and `begin`/`end`/`abortDefinition` for the `:`/`;` lifecycle.
- `inner.ts` — the real §5 DOCOL branch: `executeXT` threads through a
  DOCOL word's parameter field via an explicit IP register and the real
  `RSTK` bank (not JS call recursion), so call depth is bounded by RSTK
  size and hits `StackOverflowError` like any other bank. `EXIT`/`LIT`
  are primitive token IDs but special-cased in the loop (they need to
  mutate IP, which a plain stack-effect primitive can't touch).
- `repl.ts` — `Machine` now boot-registers every primitive as a *real*
  dictionary entry (uniform search path for primitives and user words —
  no more parallel name→token-ID table), adds `DICT`+`RSTK` banks, and
  `interpret()` is now a proper STATE-driven compile/interpret loop with
  lookahead tokenization (so `:` can consume the following token as a
  name). A compile-time error rolls the partial definition back
  (`abortDefinition`) so a REPL typo doesn't corrupt the dictionary.
- **Deliberate scope cut:** `:`/`;`/`IMMEDIATE` are handled as compiler
  syntax in `repl.ts`, not as real dictionary words — they need direct
  access to compiler state (`HERE`/`LATEST`/`STATE`) that a plain
  primitive's interface doesn't expose. `RECURSE` / self-reference inside
  a definition isn't supported (a word is `HIDDEN` until `;`, so it can't
  find itself) — noted, not needed to prove the mechanism.
- 9 new tests (colon-definitions, nested user-word calls, shadowing,
  `IMMEDIATE`-at-compile-time semantics, `:`/`;` misuse errors, rollback
  after a compile error, 31-char name limit, 50-deep nested-call chain
  through the real RSTK) — 24 engine tests total, all passing. Verified
  live in a headless browser: nested colon-definitions, `EMIT`/`CR` from
  a compiled body, and confirmed the dictionary stays usable immediately
  after a bad definition (no corruption), no console errors.
