# HAL.md — the hardware abstraction boundary, Rebel-Sim ↔ hardware targets

## 0. What this document is, and what "verified" means here

`FORTH-ARCHITECTURE.md` names an abstract HAL contract (`hal_emit`,
`hal_plot_char`, `hal_draw_*`, `hal_key_pressed?`, `hal_get_key`,
`hal_block_read`/`write`, `hal_millis`, `hal_error`) that any target
implements. This document is the concrete version: what Rebel-Sim's
engine actually defines as its host boundary today, cross-checked
directly against Rebel-ROM's real C++ source — not re-derived from
`FORTH-ARCHITECTURE.md`'s prose a second time, and not assumed from
memory. The project now has a local symlink, `rebel-rom/` (gitignored,
points at the sibling Pi 500 device-project checkout), making that
cross-check possible for the first time; before that, Rebel-ROM's
actual current source wasn't available in this checkout at all, and
any claim about it would have been secondhand.

**Read this alongside the reversed relationship it implies.**
Rebel-Sim is *ahead* on the interpreter: `packages/engine` has a
working token-threaded Forth engine (M1–M17, `PLAN.md`) with a real
dictionary, compiler, and 98 primitives (`rebel-opcodes.json`).
Rebel-ROM is *ahead* on the hardware substrate: Phases 3–9
(memory/banks, sysvars, screen, font,
execution loop/scheduler, keyboard, storage — `rebel-rom/PLAN.md`) are
implemented and hardware-verified, but **Phase 11, the Forth
executor, doesn't exist yet** — no `sysvars.cpp`-style implementation,
no doc marked "Status: implemented" for it, nothing in `rebel-rom/src`
resembling a dictionary or an inner interpreter. So: this document can
only cross-check the *substrate* Rebel-ROM has built (screen, storage,
keyboard, memory, timing, scheduling) against what Rebel-Sim's engine
expects from a host. It cannot yet cross-check Forth-level primitive
*behavior* — there's no C++ Forth engine on the other side to compare
against. That happens in the other direction later: Rebel-Sim's
already-built engine is meant to be the reference Phase 11 gets
implemented against, not the other way around.

**Keeping this in sync:** `rebel-rom` is a live, independently-evolving
sibling project reached via a symlink, not a vendored snapshot — treat
every fact below as dated to when it was checked (noted per section),
and re-verify against the real files before relying on something that
looks stale, the same discipline this project already applies to its
own milestones.

**`rebel-rom` is one target of several planned, not "the" hardware
side.** `CLAUDE.md`'s current three-way framing (Rebel-Sim /
Rebel-ROM / Rebel-Board) understates the real roadmap — worth
correcting there too, flagged rather than silently fixed since it's
this project's governing doc. As of this writing, the known family:

- **`rebel-rom`** (this symlink) — Circle/Arm bare-metal, the Pi
  400/500 family. The only one with real hardware-verified code today
  (Phases 3–9, §0 above).
- **Rebel Machine MkI** — custom-designed hardware: RP2350 (RISC-V),
  HSTX display output, SPI flash + RAM, with a **separate RP2040
  co-processor** handling the keyboard matrix and custom controls.
  Doesn't exist in code yet. The keyboard-matrix-to-usage-code
  translation happens entirely below the HAL, on the MkI's own
  firmware side — `Keyboard.pushRawEvent`'s existing
  `(usageCode, pressed)` signature already fits with no interface
  change needed (confirmed directly, §4 below).
- **Headless Rebel firmware** — RP2350 (Arm *and* RISC-V builds) /
  RP2040, driven over UART channels rather than a display+keyboard.
  Maps cleanly onto something Rebel-Sim already validated for an
  unrelated reason: `Channel` (§4) was built (M9) to let a
  non-keyboard, stream-shaped input source drive the same interpreter
  session with zero interpreter-level change — a UART-driven headless
  target is another instance of exactly that shape, not a new
  mechanism to invent.
- **Further out, unscoped:** ESP32-S2 and UEFI targets.

None of the newer targets have any code yet, so nothing above is
re-checked against them the way `rebel-rom` was — noted here so a
future pass knows to look, not because anything's been verified for
them.

---

## 1. Screen

**Rebel-Sim** splits this into two pieces, because the engine
(`packages/engine`) has zero DOM dependencies (`CLAUDE.md`):

- **`Screen`** (`packages/engine/src/screen.ts`) — engine-owned, no
  host involved. Owns the `CHAR` bank, cursor position (`CORE`
  sysvars), and character-level logic: `writeChar`/`readChar`,
  `setCursor`, `emit` (character stream in, handles `\r`/`\n`/wrap),
  `cls`. Wrap-only cursor behavior at the bottom row, no scroll
  (`screen.ts`'s own comment, confirmed against
  `rebel-rom/docs/SCREEN-MODULE.md` §7's identical rule).
- **`ScreenHal`** (same file) — host-supplied, the actual pixel
  boundary:
  ```ts
  export interface ScreenHal {
    blitGlyph(col: number, row: number, charCode: number, ink: number, paper: number): void;
    clearScreen(paper: number): void;
  }
  ```
  `NULL_SCREEN_HAL` is the test/headless default; the Angular app
  supplies a real canvas-backed one.

**Rebel-ROM** (`rebel-rom/src/screenmodule.h`) has *no* such split —
`CScreenModule` is one class that does both, because bare-metal C++
has direct hardware access and no sandboxing boundary to route around.
Its public surface covers both roles at once: `WriteChar`/`ReadChar`/
`SetCursor`/`Emit`/`Type`/`Cls`/`AdvanceCursor` (≈ Rebel-Sim's
`Screen`) plus `SetPixel`/`DrawLine`/`DrawRect`/`DrawRectOutline`/
`BlitGlyph`/`UpdateDisplay` (≈ Rebel-Sim's `ScreenHal`, and the
concrete referent of `FORTH-ARCHITECTURE.md`'s abstract `hal_plot`/
`hal_draw_*`/`hal_plot_char` names). The split isn't a divergence in
behavior, just in where the seam is drawn — Rebel-ROM doesn't need
one, Rebel-Sim structurally must have one.

**Sysvars — `SCREEN` group.** Checked directly against
`rebel-rom/src/screenmodule.h`'s `TScreenSysVars` (Phase 4/5,
`SYSVARS_SCREEN_OFFSET`):

| Field | Rebel-ROM (`TScreenSysVars`) | Rebel-Sim (`rebel-opcodes.json`) |
|---|---|---|
| Screen width/height | `nScreenWidth`/`nScreenHeight` (u16) | `SCREEN-WIDTH`/`SCREEN-HEIGHT` |
| Color depth | `nColorDepth` (u8) | **omitted** — canvas HAL is truecolor-only |
| Palette size | `nPaletteSize` (u16) | **omitted** — no palette-indirection mode |
| Char cell size | `nCharCellW`/`nCharCellH` (u8) | `CHAR-CELL-W`/`CHAR-CELL-H` |
| Char grid size | `nCharCols`/`nCharRows` (u16) | `CHAR-COLS`/`CHAR-ROWS` |
| Ink/paper | `nInk`/`nPaper` (u32) | `INK`/`PAPER` |

Field *order* matches exactly for every field Rebel-Sim actually has;
the two omissions were already flagged in `rebel-opcodes.json`'s own
notes before this check, not a new discovery — this confirms that
note was accurate, not just asserted. Byte *offsets* never match
1:1 regardless — Rebel-Sim pads every sysvar field to a full 4-byte
cell for engine uniformity (`rebel-opcodes.json`'s top-level note),
where Rebel-ROM packs tightly as a real C struct; only the group-level
map (which fields exist, in what order) is the actual cross-target
contract.

---

## 2. Storage

**Rebel-Sim** (`packages/engine/src/storage.ts`):

```ts
export interface StorageHal {
  ensureDir(path: string): void;
  listFiles(path: string): string[];
  readFile(path: string): Uint8Array | undefined;
  writeFile(path: string, bytes: Uint8Array): void;
}
```

**[Revised, M33]** Synchronous, not async — POSIX-style absolute paths
(`/PROJECTS/<name>/…`, `/CARTS/<name>.CRT`), backed by `localStorage` in
the real app (`PORTING-WEB.md` §5, base64-encoded payloads under one key
namespace), not OPFS as originally implemented. The original OPFS backend
was Promise-based, which forced `repl.ts`'s core execution model to grow
a dedicated `'storage'` suspend/resume `StepStatus` and made
`PROJECT`/`SAVE`/`RESTORE` special outer-loop-only syntax rather than
real dictionary words — a browser-platform artifact leaking into the
shared cross-target engine contract, not a genuine requirement (real
hardware's storage access has no async concept at all — see below).
Switching to `localStorage` removed that whole mechanism: `PROJECT`/
`SAVE`/`RESTORE` are ordinary primitives now, callable inside a
colon-definition or via `EXECUTE`, and two new ones, `BSAVE`/`BLOAD`
(single-bank save/load), needed no special mechanism to add. Persistence
still happens at project open/close time (now: `SAVE`/`RESTORE`/`BSAVE`/
`BLOAD` calls), never per-Forth-memory-access.

**Rebel-ROM** (`rebel-rom/src/storagemodule.h`, Phase 9): `CStorageModule`
— `LoadCart`/`SaveCart`/`EnsureLayout`/`LoadAssetFile`, backed by real
USB mass storage (FAT via Circle's `fatfs`). The two shapes match at
the concept level (project/cart directories, asset files by tag/
extension, `rebel-rom/docs/STORAGE.md` §4/§8's tag↔extension table is
the same table `storage.ts`'s `TAG_TO_EXTENSION` implements) but differ
in one real, verified way: **USB mass storage needs polling/mount-
detection state that a browser storage API (OPFS originally, localStorage
now, M33) doesn't.**

**Sysvars — `STORAGE` group.** Rebel-ROM's is real and populated
(`rebel-rom/src/storagemodule.cpp:58-59` binds
`TStorageSysVars` at `SYSVARS_STORAGE_OFFSET` and zeroes it on init):

```c
struct TStorageSysVars {
  u8 nMounted;     // 0/1 - USB storage currently mounted
  u8 nLastError;   // last f_mount() FRESULT when not FR_OK, else 0
  u8 nDeviceSeen;  // 0/1 - "umsd1" found via CDeviceNameService at least once
};
```

Rebel-Sim's `STORAGE` sysvar group is still fully reserved/empty
(`rebel-opcodes.json`) — checked, not assumed: `storage.ts` touches
`sysvars` **zero** times. This isn't a gap to close; it's a genuine
architectural difference. Browser storage (localStorage since M33,
originally OPFS) is available through the browser once granted — there's
no USB-hotplug-style attach/detach cycle to poll for, so
`nMounted`/`nDeviceSeen` have no Rebel-Sim referent. `nLastError` is the one field that *could* map to
something (`DEVELOPING.md` §9's now-shipped `ABORT`/`? <message>` path
is the closest current equivalent, but nothing wires a numeric error
code into a sysvar today — see §6 below).

---

## 3. Memory / Arenas

Raised directly (2026-08-02): Forth should generally be able to access
any bank in the arena it's running in; is there a "global" arena bank
in Rebel-ROM; and multi-arena systems probably need arena management
exposed to Forth. Checked against `rebel-rom/docs/MEMORY-MODEL.md`
(Phase 3, §3.7) rather than guessed:

**Rebel-ROM is ahead here too, not just on the general substrate**:
multi-arena is real and hardware-verified — `rebel-rom/src/arenatable.h`/
`.cpp`'s `CArenaTable`, wired into `kernel.cpp`, `Tab`-bound for a demo
toggle (`MEMORY-MODEL.md` §3.7, "Status: the mechanism is implemented…
but only as far as `CHAR`"). Up to 8 arenas (`MaxArenas`), lazily
created only when something actually asks for a second one, each capped
at just under 4 GiB (`MaxArenaSize` — forced by the fixed 32-bit cell,
`FORTH-ARCHITECTURE.md` §1). **Rebel-Sim has zero multi-arena support
today** — `Machine`'s constructor (`repl.ts:152`) creates exactly one
`Arena`, unconditionally — explicitly out of default scope per
`CLAUDE.md`'s "Calibrating scope" list.

**No "global" arena bank — confirmed, matches the instinct that one
would need to live outside any arena anyway.** Every Forth-visible
address is an offset from *its own* arena's base (`REBEL-ADDR 0` means
"offset 0 of my arena," never a designated global one, `MEMORY-MODEL.md`
§2) — there's no arena a shared bank could belong to instead. What
genuinely doesn't duplicate per arena — `SCRN` (singular framebuffer
hardware), `KMAP` (host/hardware keyboard-layout config, not
per-program state), primitive words (compiled code, zero arena-memory
cost) — lives *outside* any one arena's own `CBankTable`, held by "a
thin manager sitting above" all of them so bank names stay globally
unique across every arena (`MEMORY-MODEL.md` §3.7). `SYSV`/`DICT`/
`RSTK`/`DSTK` are meant to be genuinely per-arena-private once Phase 11
exists to give them real per-arena meaning; only `CHAR` actually is
so far. `CLAUDE.md`'s own architectural rules already state this exact
shared/singular-vs-per-arena split for `SCRN`/`KMAP` — this confirms
it against real code, not a new discovery.

**"Forth should access any bank in its current arena" is already true
today**, trivially, for Rebel-Sim's single-arena case: `@`/`!`
(`arena.ts`) are raw offset reads/writes with zero bank-boundary
enforcement, matching `MEMORY-MODEL.md`'s own explicit intent ("full
read/write, no bounds-checking safety net… it should feel like real,
physical, fully-accessible memory"). The actual open piece isn't
*access* (already unrestricted) but *discovery* — nothing lets Forth
source ask "what banks exist, and where" generically on either side
today. Same already-tracked open item as §5 below
(`FORTH-ARCHITECTURE.md` §9 item 4, a hypothetical `BANK@`), not a new
one.

**Arena management exposed to Forth is explicitly undecided on the
Rebel-ROM side too** — not a new gap surfaced here, a confirmed
existing one: `MEMORY-MODEL.md` §5 flags "Attach/visit UX" as open,
noting `Tab` is "only a placeholder demo binding, not a real decision
about the eventual Forth/UI-layer mechanism." What should actually
trigger switching once a real Forth executor exists on either side — a
dedicated Forth word, a monitor-mode/command-palette action — is the
exact question raised here, independently, before either side has
answered it. Worth resolving once, in a way both sides can use: likely
gated by whether a target actually supports multiple arenas at all (a
capability sysvar or compile-time flag, not assumed universal —
Rebel-Sim has none today, and single-chip targets like the MkI/headless
firmware may never need more than one).

---

## 4. Keyboard / input

**Rebel-Sim** splits input the same way Screen splits output, but
inverted — the host pushes raw events *in*, rather than the engine
calling *out*:

- **`Keyboard`** (`packages/engine/src/keyboard.ts`) — engine-owned.
  Host calls `pushRawEvent(usageCode, pressed)` (raw USB HID usage
  codes — the host translates DOM `keydown`/`keyup` before calling
  in, filtering auto-repeat via `KeyboardEvent.repeat`, since the
  engine has zero DOM dependencies). Internally: a 32-slot ring buffer
  of translated `KeyEvent`s, a `KMAP` bank (`u8[2][256]`,
  unshifted/shifted planes), the `MODIFIERS` sysvar. Non-blocking reads
  (`hasTranslatedEvent`/`readTranslatedChar`) back `KEY?`/`KEY`
  (`primitives.ts`).
- **`Channel`** (`packages/engine/src/channel.ts`) — the abstraction
  blocking `KEY` actually binds to (`hasData()`/`readByte()`), not
  `Keyboard` by name. `KeyboardChannel` wraps `Keyboard`;
  `RemoteChannel`/`CompositeChannel` (M9, WebMCP) let a second,
  programmatic input source share the same session with zero
  interpreter-level change.

**Rebel-ROM** (`rebel-rom/src/keyboardmodule.h`, Phase 8):
`CKeyboardModule` — `OnRawReport`/`PushEvent` (≈ `pushRawEvent`,
same raw-in/translated-out shape), `BuildDefaultKeymap`. Its `KEYBOARD`
sysvar group has one field Rebel-Sim's doesn't: `nKeyboardCount`
(attached-device count) — already flagged in `rebel-opcodes.json` as
omitted for the same browser-has-no-USB-hotplug-enumeration reason as
Storage's polling fields above, confirmed accurate by this check, not
new.

**No Rebel-ROM equivalent of `Channel` exists yet** — there's nothing
to compare it against, since Phase 11 (the thing that would actually
block reading from `CKeyboardModule`'s queue) hasn't been built. When
it is, `rebel-rom/docs/EXECUTION-LOOP.md` §2 already anticipates the
shape: "the Forth executor… blocks on the input queue when waiting for
a keystroke, exactly like any cooperative task waiting on a
synchronization primitive" — structurally the same idea `Channel`
formalizes, arrived at independently on both sides before this
document existed.

**Corrected (2026-08-02, from the project owner directly):**
`pushRawEvent(usageCode, pressed)`'s USB-HID-shaped signature is *not*
a seam the Rebel Machine MkI breaks. The keyboard-matrix-to-usage-code
translation happens entirely below the HAL, on the MkI's own firmware
side (RP2040 co-processor + whatever link joins it to the main
RP2350) — by the time an event reaches this interface, it's already
in the same `(usageCode, pressed)` shape `Keyboard` expects today, same
as Rebel-ROM's own DOM-keydown-to-usage-code translation happens below
this same interface on the browser side. No interface change needed
for that target; corrects the earlier (wrong) read in this section
that assumed the translation had to happen above the boundary.

**Open: `Channel` may need per-type configuration, not just data.**
Also raised directly (2026-08-02): future non-keyboard `Channel`
implementations — a LoRa radio link (frequency, spreading factor and
other radio parameters to set before it carries data at all), and
further out, "AI communication channels" (unspecified so far) — need
somewhere to hold *configuration*, not just the `hasData()`/`readByte()`
byte stream `Channel` already carries. Nothing here decides the shape
of that yet (a new per-type config block in a dedicated channel bank,
analogous to `KMAP`'s per-keyboard table, is the most obvious fit
given how every other configurable subsystem in this project already
works — sysvars for scalars, a dedicated bank for anything larger —
but not designed). No code exists for any non-`RemoteChannel` data
channel yet, so this is captured here as a real, named future need,
not designed ahead of it (`CLAUDE.md`'s scope discipline). Revisit
when a first concrete non-keyboard `Channel` is actually being built.

---

## 5. Proposed `SystemHal` — not yet built, flagged for later

Raised as a question, not decided: should there be a `SystemHal`
covering timing (`hal_sys_millis`/`ticks`), yield/scheduling
(`hal_sys_yield`), and generic memory-bank access? Checked against
real code on both sides before answering, rather than speccing an
interface nothing calls yet:

- **Yield/scheduling.** Real on Rebel-ROM's side:
  `m_Scheduler.Yield()`, called from `kernel.cpp`'s `Run()` loop
  (`rebel-rom/src/kernel.cpp:426`) — Circle's cooperative `CScheduler`,
  letting other kernel tasks (screen diagnostics, the LED task) run.
  But this is purely an internal host-loop concern between kernel
  tasks today — **no Forth word calls it**, because there's no Forth
  executor yet to call it from. `rebel-rom/docs/EXECUTION-LOOP.md` §5
  already documents the future constraint ("Phase 11 needs to have the
  Forth task `Yield()` periodically during long computations") as an
  *implementation* detail of the eventual C++ executor, not
  necessarily a Forth-source-visible primitive. Rebel-Sim's side has
  no separate concept to expose either — the generator-based
  `Inner.executeXT`/`step(budget)` mechanism (M7, `inner.ts`) *is* the
  cooperative yield point structurally, for free, with nothing else to
  call out to. **Verdict: not a HAL function on either side today** —
  worth a design note (the two loops cooperate at different layers,
  not via a shared interface), not an interface member.
- **Timing.** Real on Rebel-ROM's side: `CTimer` (`m_Timer`,
  `rebel-rom/src/kernel.h`), with `GetTicks()`/`GetClockTicks()`/
  `MsDelay()` (`rebel-rom/circle/include/circle/timer.h`) already
  driving the 60Hz tick loop. Confirmed unexposed to Forth on **both**
  sides — no `DELAY`-style word has shipped anywhere, and Rebel-Sim's
  own `performance.now()`/`Date.now()` only appear in test-harness code
  (`app.spec.ts`), never engine-facing. **Verdict: genuinely not yet
  needed** — the natural Rebel-Sim binding is `performance.now()`
  (`FORTH-ARCHITECTURE.md`'s own porting note already says so); revisit
  when an actual timing word is being built, not before.
- **Generic memory-bank access.** Real, internal C++ on Rebel-ROM's
  side (`rebel-rom/src/membank.cpp`/`arenatable.cpp`), matching
  Rebel-Sim's own `BankTable` (`packages/engine/src/banks.ts`) at the
  concept level — see §3 above for the fuller treatment (multi-arena
  status, why there's no "global" bank, why access is already
  unrestricted and *discovery* is the actual gap). Whether either one
  should be Forth-*callable* (a hypothetical `BANK@` walking the table
  via raw address arithmetic) is **already** an open, unresolved item —
  `FORTH-ARCHITECTURE.md` §9 item 4 — on both sides. This isn't a new
  gap `SystemHal` reveals; it's the same tracked question under a new
  name. **Verdict: don't duplicate the open item — resolve it there
  if/when it's resolved.**
- **Power management.** Nothing resembling this exists anywhere in the
  current Rebel-ROM source (no `CPowerManagement`, no sleep/low-power
  state, no display-dimming). Worth not conflating with "yield" —
  scheduling and power state are different concerns — and premature to
  scope until something concrete needs it (e.g. a screen-blank/idle
  word).

**Net: no `SystemHal` interface exists yet, deliberately.** If/when a
real need shows up (a timing word, a bank-introspection word), come
back to this section and promote the relevant piece to a real
interface then — not ahead of that need, matching this project's
standing scope discipline (`CLAUDE.md`'s "Calibrating scope";
`DEVELOPING.md` §9's identical reasoning for tabling `THROW`/`CATCH`).

---

## 6. Open questions

- Whether `nLastError`-style sysvar fields (Storage's is real and
  populated on the Rebel-ROM side; Rebel-Sim's `ABORT`, M17, doesn't
  write one anywhere) should ever be unified into one cross-subsystem
  error-reporting convention, or stay per-subsystem as Rebel-ROM
  already has them. Not decided — `DEVELOPING.md` §9 tabled the
  general version of this (`LAST-ERROR`) for the same "no consumer
  yet" reason.
- This document doesn't yet cover `FONT`/`SPRITE` groups (both
  `Reserved` on the Rebel-Sim side; Rebel-ROM's Phase 6/10 status for
  them wasn't checked in this pass) — add a section once either side
  actually needs cross-checking there.
- No attempt yet to reconcile primitive *token IDs* or dictionary
  header *flag bits* cross-target — meaningless before Phase 11 exists
  to compare against. `FORTH-ARCHITECTURE.md` §0's single-source-of-
  truth artifact (not yet built anywhere) is the eventual right place
  for that, not this document.
- **Per-channel-type configuration** (§4): a LoRa `Channel` needs
  frequency/spreading-factor/other radio parameters set somewhere
  before it carries data; future "AI communication channels" will
  presumably need their own, unspecified config too. No shape decided
  — likely a new dedicated bank (a `Channel` analog to `KMAP`'s
  per-keyboard table), but not designed. Revisit once a first concrete
  non-keyboard `Channel` is actually being built, not before.
- **Arena management exposed to Forth** (§3): open on both sides —
  Rebel-ROM's own docs flag "Attach/visit UX" as unresolved
  (`MEMORY-MODEL.md` §5), and Rebel-Sim has no multi-arena support at
  all yet to expose anything for. Likely a target-gated capability (a
  sysvar or compile-time flag saying whether >1 arena exists at all)
  rather than assumed-universal Forth words, but not designed. Revisit
  once either side actually builds a second arena a Forth program needs
  to address, not before.
