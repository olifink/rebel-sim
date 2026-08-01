# Rebel-Sim: Breakpoint / Debugging Design

Status: Draft, nothing implemented yet. Scoped for Rebel-Sim's next
milestone (tentatively **M10**, see `PLAN.md`'s roadmap list). Written
after M9 (remote channel / WebMCP) shipped, informed by direct reading
of `inner.ts`/`repl.ts`/`app.ts` as they exist today, not invented from
the spec docs alone.

Scope: **word-level breakpoints only** — pause execution right before a
user-defined (`:`-compiled) word's body runs, not before individual
primitive tokens inside it. Chosen deliberately over token/address-level
breakpoints for both target reasons: easier to reason about ("break
when `SQUARE` runs," not "break at DICT offset 0x4110"), and
meaningfully smaller to build. Single-stepping and conditional
breakpoints are explicitly out of scope for this pass — see "Explicit
scope cuts" below.

## 1. Why this is engine-level, not Forth-level

Unlike stack/bank/dictionary introspection (a separate, still-open
thread — see `PLAN.md`'s M9 write-up and the brainstorm that preceded
this doc), breakpoints can't be built as plain Forth words layered on
top of existing primitives. Pausing mid-execution and resuming later
with the interpreter's own state (stack, return stack, IP) fully intact
requires reaching into the inner interpreter's suspend/resume mechanism
directly — there's no `@`/`!`-mediated sysvar that could express "stop
here," the same way there's no way to write `KEY`'s blocking behavior
in Forth itself. This is squarely a HAL/engine-mechanism concern
(`FORTH-ARCHITECTURE.md`'s Forth-vs-HAL split), not a portable-behavior
one.

## 2. The mechanism already in place, and why it's the right hook

M7 made `Inner.executeXT`/`threadFrom` generators specifically so
execution can suspend mid-word-body and resume later — the mechanism
blocking `KEY` already needs (`inner.ts:43-55`). Every step yields a
`StepSignal`: `'progress'` after a completed step, or `'blocked'` while
waiting on the bound `Channel`. `Machine.step(budget)` (`repl.ts:235`)
drives the session generator and translates those yields into a
`StepStatus` (`'idle' | 'blocked' | 'more-to-run'`) the host (currently
`App.startPump`'s per-frame `tick()`, `app.ts:353`) polls.

Breakpoints are a third suspend condition, exactly the same shape as
`'blocked'`, added at the one place where a call into a compiled word's
body actually happens: `threadFrom`'s `DOCOL`/`DODOES_TOKEN` branches
(`inner.ts:195-203`), plus `executeXT`'s own top-level `DOCOL` branch
(`inner.ts:141-146`) for the case where the very first word interpreted
on a line is itself breakpointed (not reached via `threadFrom` at all).
Both sites currently do:

```ts
} else if (slotCode === DOCOL) {
  this.rstack.push(ip);
  ip = slotXt + CELL;
  yield 'progress';
}
```

Becomes (both sites, extracted into a shared check):

```ts
} else if (slotCode === DOCOL) {
  if (this.breakpoints.has(slotXt)) {
    yield 'breakpoint';
  }
  this.rstack.push(ip);
  ip = slotXt + CELL;
  yield 'progress';
}
```

This is deliberately *not* an `if/else` — `yield 'breakpoint'` doesn't
return or branch, it just pauses. When `step()` calls `.next()` again to
resume, execution picks up right after the `yield` and proceeds into
the word exactly as if the check had never fired. No extra "already
broke here, don't re-break" flag is needed: the check only runs once
per *call* to that word (each iteration of `threadFrom`'s loop reaches
the `DOCOL` branch fresh), so recursive calls or repeated calls inside
a loop correctly re-break every time — which is the behavior you want
from a breakpoint. `DODOES_TOKEN`'s branch (`CREATE...DOES>` words)
needs the identical check for the same reason: it's another way a
compiled body gets threaded into.

**Why the breakpoint set is a plain runtime `Set<number>` of `cfa`
addresses, not a dictionary header flag:** the header's flags byte is
already fully packed — `FLAG_IMMEDIATE` (0x80) / `FLAG_HIDDEN` (0x40) /
`FLAG_COMPILE_ONLY` (0x20) / a 5-bit name-length field (0x1f) leaves
zero spare bits (`dictionary.ts:23-26`). Even if a bit were free, the
header layout is a fixed cross-target contract
(`FORTH-ARCHITECTURE.md` §6) — growing it to carry a debug-only,
session-local flag would be the wrong trade. A `Set<number>` on
`Machine`, resolved from word name to `cfa` once at set-time via the
existing `findWord()` (`dictionary.ts:107`), costs nothing structural
and is trivially cleared per-session.

## 3. `Machine`/`repl.ts` changes

- `StepSignal` (`inner.ts:86`) gains `'breakpoint'`:
  `export type StepSignal = 'progress' | 'blocked' | 'breakpoint';`
- `Inner` gains a `breakpoints: Set<number>` field (of `cfa` addresses)
  and the two check sites above. `Machine` owns the actual `Set`
  instance (constructed alongside `this.inner`) so it can expose
  mutation methods without `Inner` needing dictionary-lookup logic of
  its own.
- `Machine` gains:
  - `setBreakpoint(name: string): void` — `findWord()`, throw if not
    found (matches existing "throw loudly on bad input" convention,
    e.g. `nextInputToken()`), add its `cfa` to the set.
  - `clearBreakpoint(name: string): void` — same lookup, remove.
  - `listBreakpoints(): string[]` — reverse-map the `Set`'s addresses
    back to names via `listDictionaryEntries()` (already built, M8),
    filtered to ones whose `cfa` is in the set.
  - No new "am I paused" field needed — `StepStatus` already conveys it
    (see next point), and the stack/rstack/dictionary are readable
    through the exact same surface M8's inspector panel and M9's
    WebMCP reads already use. What word is currently paused-at *is*
    new information worth exposing directly (see §5) rather than
    forcing a caller to reconstruct it from the return stack.
- `StepStatus` (`repl.ts:104`) gains `'breakpoint'`; `step()`'s loop
  (`repl.ts:240-249`) gains one more branch alongside its existing
  `if (value === 'blocked') return 'blocked';`:
  ```ts
  if (value === 'breakpoint') return 'breakpoint';
  ```
- **Resuming is just calling `step()` again** — same as `'blocked'`.
  No separate `resume()`/`continue()` method on `Machine` itself; the
  "continue" affordance lives one layer up, in whatever's driving the
  pump (see §4), because `Machine` has no concept of *when* a caller
  wants to resume — it only reports that it's currently paused.

## 4. App-side change (this is the part that's easy to miss)

`App.startPump`'s `tick()` currently **ignores** `step()`'s return value
entirely (`app.ts:353`) — it just calls `step()` every animation frame,
forever, regardless of status. That's fine for `'blocked'` (cheap
no-op until the channel has data) but would silently break breakpoints:
without a change here, a breakpoint would yield once, `step()` would
return `'breakpoint'` to a caller that isn't looking, and the very next
`requestAnimationFrame` tick would call `step()` again — resuming
*immediately*, faster than any human or agent could observe the pause.
A breakpoint that doesn't actually hold still isn't a breakpoint.

Required change: `tick()` must check the returned `StepStatus` and, on
`'breakpoint'`, stop calling `machine.step()` on subsequent frames
until something external clears a "paused" flag — mirroring how
`'blocked'` already relies on something external (a keystroke, a
`RemoteChannel.push()`) to eventually make `hasData()` true, except
here the "something external" is an explicit resume action, not a data
arrival. Concretely: `App` gains a `pausedAtBreakpoint` signal; `tick()`
skips its `machine.step()` call while set; a new WebMCP `debug_continue`
tool (see §5) just clears the signal, letting the *next* frame's
`step()` call proceed — which resumes the generator past the
`yield 'breakpoint'` exactly as described in §2. `App` doesn't drive
`step()` directly from the tool call; it only flips the flag the pump
already polls, keeping the single "one place drives step()" invariant
the pump loop already relies on for rendering cadence.

## 5. WebMCP tool surface (extends M9's six)

Following the same naming/shape convention `app.ts`'s
`registerWebMcpTools()` already established:

| tool | input | behavior |
|---|---|---|
| `debug_set_breakpoint` | `{word: string}`, required | `machine.setBreakpoint(word)`; error text if the word doesn't exist |
| `debug_clear_breakpoint` | `{word: string}`, required | `machine.clearBreakpoint(word)` |
| `debug_list_breakpoints` | none | `machine.listBreakpoints().join(' ') \|\| '(none)'` |
| `debug_status` | none | `'running'` normally; `'paused at <word>'` while `pausedAtBreakpoint` is set — the word name resolved from the return stack's current top frame via the same reverse-lookup `listBreakpoints()` uses |
| `debug_continue` | none | clears `App.pausedAtBreakpoint`, letting the pump's next frame resume execution; error text if not currently paused |

Deliberately *not* adding `debug_step`/`debug_step_into` yet (see scope
cuts) even though `Machine.step(budget)` already accepts an arbitrary
budget and a `step(1)` call is almost a single-step for free — the
"almost" is doing real work: a budget of 1 counts *any* one yield
(including a `'progress'` from a primitive like `DUP`), not "one word
call," so a naive `step(1)`-based single-stepper would behave
inconsistently between primitive-dense and DOCOL-body-dense code. Worth
a real design pass of its own if/when it's actually needed, not a
same-milestone add-on.

## 6. Explicit scope cuts (flagged, not silently built)

- **No token/address-level breakpoints.** Only whole compiled-word
  entry points. Breaking partway through a word's body would need
  either a finer breakpoint key (an `(xt, ip-offset)` pair) or a
  separate "step N tokens and stop" primitive — neither is built here.
- **No conditional breakpoints** (`BREAK FOO IF <condition>`). A
  breakpoint fires unconditionally every time the word is entered.
- **No single-stepping** (see §5's `debug_step` note above) — continue
  is the only resume affordance this milestone ships.
- **No persistence.** Breakpoints live in a session-local `Set` on
  `Machine`, gone on reload — matching `RemoteChannel`'s own
  no-persistence precedent (M9) and the fact that breakpoints are a
  debugging aid, not project state (`docs/STORAGE.md`'s project/asset
  model has no natural slot for "debugger state" and shouldn't grow one
  for this).
- **No breaking on primitive tokens** (e.g., "break before every
  `EMIT`"). Only `DOCOL`/`DODOES`-coded (user-defined) words. Primitives
  are one-shot native actions with no interesting paused-mid-execution
  state to inspect — there's nothing a breakpoint would let you see
  that reading the stack before/after already doesn't.
- ~~No UI affordance in the inspector panel~~ — **added** right after
  this milestone shipped, see §9 below. Still no call-stack/step view —
  that's the part still deferred, not the whole UI.

## 7. Cross-target portability note

The suspend/resume *mechanism* here (a JS generator's `yield`) is
Rebel-Sim-specific — it's the same kind of engine-mechanism divergence
M7's own doc comments already call out for blocking `KEY`. The
*behavioral contract* worth porting to Rebel-ROM eventually is: "a
compiled word can be marked to pause execution before its body runs,
resumable with the interpreter's own state (stack/return
stack/instruction pointer) fully intact." Rebel-ROM's execution loop
already has to model *some* cooperative-suspension mechanism of its own
(`PLAN.md`'s M7 entry: "faithful to both hardware targets' cooperative
execution"), but confirming what that actually looks like requires
reading Rebel-ROM's real source (a separate repo) — flagged here as a
genuine open question for whoever picks up Rebel-ROM's Phase-11-
equivalent debugging work, not assumed to already have an answer.

## 8. Verification plan (once built)

- `repl-loop.test.ts` (or a new `debug.test.ts`) gains cases: setting a
  breakpoint on a defined word and confirming `step()` returns
  `'breakpoint'` exactly once per call to that word, not per primitive
  inside it; confirming `step()` after a breakpoint resumes with the
  stack/rstack exactly as they were at the point of the call (no state
  loss across the yield); a recursive word breaking on every call, not
  just the first; clearing a breakpoint mid-session and confirming it
  no longer fires.
- App-level: confirm `tick()` genuinely stops advancing the REPL while
  `pausedAtBreakpoint` is set (the framebuffer/stack signals stop
  changing across several animation frames), and resumes correctly once
  `debug_continue` fires.
- Live, via the Chrome DevTools MCP path already proven out for M9:
  `debug_set_breakpoint({word: "SQUARE"})`, call `type("5 SQUARE .\n")`,
  confirm `debug_status` reports paused, confirm `read_stack` shows the
  argument already pushed but no result yet, `debug_continue`, confirm
  `read_screen` then shows the completed result.

## 9. Inspector panel UI (added post-ship)

Built directly on top of everything above — no engine mechanism
changed, only what the app's inspector panel (`app.html`/`app.ts`)
shows and reacts to. One real engine addition first, though: a new
`breakable: boolean` field on `DictionaryEntry` (`dictionary.ts`),
computed by reading the entry's *current* Code Field (`DOCOL`/`DODOES`
→ `true`, anything else → `false`) at both `findWord` and
`listDictionaryEntries` call time — not cached at definition time,
since a `CREATE`d word's Code Field is rewritten to `DODOES` by
`DOES>` after the fact, so a stale snapshot would be wrong for exactly
the words that matter most. `Machine.setBreakpoint` was tightened to
throw on a non-`breakable` word (a primitive, `CONSTANT`, or plain
`CREATE`/`VARIABLE`) rather than silently accepting a breakpoint that
`Inner.checkBreakpoint` could never actually fire for — a real gap from
the original implementation pass, closed once this UI needed to know
"which words are even worth offering as clickable" and made it obvious
the engine itself should reject the same case, not just the UI.

**App-side:** `pausedWord: Signal<string | undefined>` replaced the
plain `pausedAtBreakpoint: boolean` field from §4 — `undefined` while
running, the paused word's name once set, driving both `tick()`'s pump
gate and the template directly (no separate boolean to keep in sync).
`breakpointWords: Signal<ReadonlySet<string>>` is polled/diffed in
`tick()` exactly like `dictionaryWords`/`bankTable` already were — one
update path regardless of whether a breakpoint was armed from this UI
or from a WebMCP `debug_set_breakpoint` call, so the two never drift.
`resumeFromBreakpoint()` is the one method both the Continue button and
`debug_continue`'s `execute()` call — `zone.run()` is harmless to call
from either an already-in-zone click handler or an external WebMCP
callback outside it, so no special-casing was needed between the two
callers.

**Template:** a dedicated "breakpoints" inspector section (armed names,
red, click to clear) above the dictionary section; dictionary words
gain a `breakable`-gated `(click)` to toggle a breakpoint (only
`w.breakable` words get a pointer cursor/hover underline — non-breakable
ones are inert, matching the engine's own rejection); a red "paused at
WORD — Continue" banner in the console pane when `pausedWord()` is set.

**A real bug caught during testing, not just theorized:** the
breakpoints section and the dictionary section originally shared the
`.inspector-words` class for their word-list containers. Since the
breakpoints section renders first in the DOM, `querySelector('.inspector-words')`
in a test wanting the *dictionary* list silently matched the (usually
empty) breakpoints list instead — a real "define SQUARE, wait for it to
appear" test hung until this was caught and fixed by giving each
container its own class (`breakpoint-list`/`dictionary-list`). Worth
remembering: reusing a class name across sibling sections is exactly
the kind of thing that looks harmless until DOM order changes which
one `querySelector` actually finds.

**Verified both ways:** the app test suite (`app.spec.ts`) drives this
through `App`'s own `remoteChannel`/`resumeFromBreakpoint()` (jsdom has
no real `document.modelContext` to exercise the WebMCP tools through),
and separately live against the dev server via the Chrome DevTools MCP
path — clicked `SQUARE` in the dictionary list directly (`evaluate_script`
+ a real DOM `.click()`, not a tool call) to arm it, confirmed the
breakpoints section and dictionary highlighting both updated, drove a
breakpoint hit via the `type` tool, confirmed the pause banner and
stack state, clicked the on-page Continue button directly, confirmed
`25` printed and `debug_list_breakpoints` still reported `SQUARE`
armed (clearing and pausing are independent — resuming doesn't disarm
a breakpoint, and clicking a primitive like `DUP` correctly did nothing).
