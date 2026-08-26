import {
  Component,
  NgZone,
  Injector,
  signal,
  computed,
  ViewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  declareExperimentalWebMcpTool,
} from '@angular/core';
import { Machine, runStorageSelfTest, listDictionaryEntries, getPrimitiveNote, listSysvars, RemoteChannel, RemoteBoard, RemoteTerminal } from '@rebel-sim/engine';
import type { Bank, ByteSink, DictionaryEntry, StepStatus, SysvarEntry } from '@rebel-sim/engine';
import { CanvasScreenHal } from './canvas-screen-hal.js';
import { codeToUsage } from './browser-keymap.js';
import { createLocalStorageHalIfSupported } from './local-storage-storage-hal.js';
import { PERFORMANCE_TIMING_HAL } from './performance-timing-hal.js';
import { computePresentationSize } from './canvas-presenter.js';
import { buildZip } from './zip-writer.js';

// The real framebuffer resolution (matches repl.ts's DEFAULT_SCREEN_WIDTH/
// HEIGHT — the engine has no reason to expose these, they're boot-fixed
// per FORTH-ARCHITECTURE.md's current "no runtime mode change" state).
// 640x480, settled — see repl.ts's own constants for the M54 history.
const FRAMEBUFFER_WIDTH = 640;
const FRAMEBUFFER_HEIGHT = 480;
const TARGET_CSS_WIDTH = 1024; // ~2x at devicePixelRatio 1, same on-screen scale factor as before

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('screen') screenRef!: ElementRef<HTMLCanvasElement>;

  protected readonly stack = signal<number[]>([]);
  protected readonly returnStack = signal<number[]>([]);
  protected readonly dictionaryWords = signal<DictionaryEntry[]>([]);
  protected readonly bankTable = signal<readonly Bank[]>([]);
  // Left-side (.storage-panel) monitor, polled/diffed in tick() exactly
  // like bankTable — engine's listSysvars() (sysvars.ts) does the actual
  // group/field walk and live SYSV-bank reads, this is just its display
  // cache.
  protected readonly sysvarsTable = signal<SysvarEntry[]>([]);
  // Fixed for the lifetime of a Machine (Arena's size never changes after
  // construction) — set once alongside bankTable's initial value below,
  // not re-polled on every tick like bankTable itself is.
  protected readonly arenaSizeBytes = signal(0);
  protected readonly bankUsedBytes = computed(() =>
    this.bankTable().reduce((sum, b) => sum + b.size, 0),
  );
  protected readonly storageStatus = signal<string>('checking…');
  // The "project storage" panel — every project name currently saved
  // (Machine.storage.listProjects(), a plain localStorage scan), polled/
  // diffed in tick() exactly like bankTable/dictionaryWords below.
  protected readonly projectNames = signal<string[]>([]);

  // DEBUGGING.md (M10) UI: `undefined` while running; the paused
  // word's name once step() returns 'breakpoint'. Both the pump loop
  // (tick(), on a fresh breakpoint hit) and debug_continue's WebMCP
  // execute() write this through resumeFromBreakpoint()/directly — see
  // their call sites for why neither needs to special-case being
  // in/outside the Angular zone.
  protected readonly pausedWord = signal<string | undefined>(undefined);
  // Currently-armed breakpoint names — polled/diffed in tick() exactly
  // like dictionaryWords/bankTable below, so it stays correct whether a
  // breakpoint was armed from this UI (toggleBreakpoint) or from a
  // WebMCP debug_set_breakpoint call, without two separate update paths
  // to keep in sync.
  protected readonly breakpointWords = signal<ReadonlySet<string>>(new Set());
  protected readonly breakpointList = computed(() => Array.from(this.breakpointWords()).sort());

  // Web-only UI, no engine/spec involvement: the inspector and storage
  // panels are a HUD overlay (app.css — position: fixed, not a flex
  // sibling) rather than a layout column, so toggling this never shifts
  // the canvas — prep for eventually letting the canvas itself grow
  // into the space they used to reserve. Ctrl+`/Ctrl+\ (handleKeyEvent)
  // toggles it; defaults hidden now — the canvas is the thing to see
  // first, the HUD is opt-in.
  protected readonly monitorsVisible = signal(false);

  // Constructed in ngAfterViewInit — the engine's Screen.cls() (M3) runs
  // during Machine's own constructor and paints through the HAL
  // immediately, so the canvas must already exist before `new Machine()`.
  private machine!: Machine;

  // Set alongside this.machine in constructMachine() — was a local
  // variable there until TERMINAL (rebel-opcodes.json 147) needed to
  // reuse the exact same instance to render a connected board's output
  // onto the same offscreen canvas (its already-loaded FONT bank is what
  // makes that reuse possible — see connectToRemote()'s own comment).
  private canvasScreenHal?: CanvasScreenHal;

  // TERMINAL (147): the in-process simulated board a connected session
  // controls, and the terminal-role decoder rendering its output through
  // `canvasScreenHal` above. `undefined` until the first TERMINAL call;
  // persists across a Ctrl+Escape disconnect so reconnecting resumes the
  // same session rather than rebooting it (see connectToRemote()).
  private remoteBoard?: RemoteBoard;
  private remoteTerminal?: RemoteTerminal;
  // Whether tick()/handleKeyEvent currently route to the board instead of
  // this.machine — plain field, not a signal: purely internal routing
  // state, nothing in the template reads it (same category as pumping).
  private connectedToRemote = false;

  // M9 (WebMCP): fed by registered tools' execute() handlers, merged
  // with keyboard input via Machine's own CompositeChannel wiring
  // (repl.ts) — a human at the keyboard and a WebMCP caller share the
  // same session, neither displaces the other.
  private readonly remoteChannel = new RemoteChannel();

  // The engine draws into this offscreen, DOM-detached canvas at the
  // framebuffer's true 1:1 resolution — CanvasScreenHal never touches
  // the visible canvas directly. Presenting the two separately (rather
  // than displaying this one, scaled via CSS) is what fixes the uneven-
  // pixel-width rendering bug: see canvas-presenter.ts's header comment.
  private readonly offscreen = document.createElement('canvas');
  private offscreenCtx: CanvasRenderingContext2D | null = null;
  private presentCtx: CanvasRenderingContext2D | null = null;

  // Bound once so removeEventListener in ngOnDestroy actually matches.
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyEvent(e, true);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.handleKeyEvent(e, false);

  // Primitives run per animation frame while the REPL loop is active
  // (M7/M7a). M43 (spec/04-FORTH-CORE.md §5.2/§6.13): the outer
  // interpreter is genuinely self-hosted now — INTERPRET dispatches
  // every line via Forth-level WORD/FIND/NUMBER, and FIND's own
  // chain-walk is O(dictionary size) primitive-level steps (~170
  // entries once system.fth has loaded), not the roughly-one-step-per-
  // token the old native tokenizer cost — a several-token compiling
  // line (each token needs its own FIND) can need on the order of
  // 10^5 steps. Bumped well past that: step() returns the moment a line
  // actually finishes/blocks/breakpoints regardless of this ceiling
  // (repl.ts), so a short line costs nothing extra — what this budget
  // actually buys is a longer line finishing within *one*
  // requestAnimationFrame round-trip instead of several, which matters
  // because RAF itself, not raw compute, is the slow part in a
  // throttled/background-tab-like test environment.
  private static readonly STEP_BUDGET = 500_000;

  // True while a requestAnimationFrame chain is actively running. The
  // chain self-terminates (tick() below) once a frame finds nothing left
  // to do, so this also doubles as "is the chain currently stopped" —
  // wake() is the only thing allowed to restart it, from every call site
  // that can give step() something to do again.
  private pumping = false;

  constructor(
    private readonly zone: NgZone,
    private readonly injector: Injector,
  ) {}

  async ngAfterViewInit(): Promise<void> {
    this.offscreen.width = FRAMEBUFFER_WIDTH;
    this.offscreen.height = FRAMEBUFFER_HEIGHT;
    // getContext('2d') can be null in environments with no real canvas
    // backing (e.g. jsdom in unit tests) — degrade to the engine's
    // default no-op HAL rather than crashing; a real browser always has one.
    this.offscreenCtx = this.offscreen.getContext('2d');
    this.presentCtx = this.screenRef.nativeElement.getContext('2d');
    if (this.presentCtx) {
      this.presentCtx.imageSmoothingEnabled = false;
    }
    this.applyPresentationSize();
    window.addEventListener('resize', this.onResize);

    // constructMachine() is synchronous and deliberately runs before this
    // method's first `await` — everything through the keyboard-listener
    // registration below needs to happen in that same synchronous
    // prefix, or a caller awaiting whenStable() (real app bootstrap
    // included) could observe a view whose keyboard isn't wired up yet:
    // most of what follows an `await` runs via zone.runOutsideAngular,
    // which is invisible to NgZone's stability tracking by design.
    this.constructMachine();
    this.screenRef.nativeElement.focus();
    this.registerWebMcpTools();

    // M5's end-to-end proof, mirroring CKernel::RunStorageSelfTest
    // (docs/STORAGE.md §8): round-trip a synthetic asset through the real
    // save/open path once at startup and surface PASS/FAIL, rather than
    // only ever finding out storage is broken the first time a real
    // project tries to use it. Synchronous now (localStorage, not OPFS)
    // — a plain try/catch, no .then()/.catch() needed. Page-load-only —
    // a storage hardware check, not part of a Forth-level COLD.
    const storageHal = createLocalStorageHalIfSupported();
    if (storageHal) {
      // PORTING-WEB.md §7: ask the browser not to casually evict a
      // user's project data the way ordinary origin storage can be
      // reclaimed under pressure — losing work because storage was
      // tight is a bad failure mode for a tool meant to feel like it
      // owns its own memory. Best-effort, and less clearly specified for
      // localStorage than it was for OPFS (persist()'s guarantee is
      // clearest for IndexedDB/Cache/OPFS's "box" storage), but harmless
      // to still ask.
      void navigator.storage?.persist?.();

      try {
        this.storageStatus.set(runStorageSelfTest(storageHal) ? 'OK' : 'FAILED');
      } catch (err) {
        this.storageStatus.set('ERROR');
        console.error('storage self-test threw', err);
      }
    } else {
      this.storageStatus.set('unavailable (no localStorage)');
    }

    // Raw keydown/keyup -> the engine's keyboard event queue (M4,
    // PORTING-WEB.md §4). M7a retired the DOM `<input>` this used to be
    // gated on ("only route when the input box isn't focused") — the
    // whole page is the simulated keyboard now, so every key routes
    // unconditionally. M9's remoteChannel merges in via Machine's own
    // CompositeChannel (repl.ts), not here — nothing to arbitrate at
    // this layer.
    this.zone.runOutsideAngular(() => {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
    });

    await this.loadVocabularyAndStartRepl();
  }

  /** Clears every polled "last*" UI-diff snapshot (`tick()`'s own
   * change-detection guards) and the paused-breakpoint signal, ahead of
   * discarding `this.machine` for a freshly-constructed one — shared by
   * `tick()`'s `'cold'` and `'restart-project'` (M54) branches, both of
   * which replace the Machine outright rather than resuming it. Without
   * this, the fresh machine's first real state would be masked by a
   * stale comparison against the one that just got replaced. */
  private resetUiSnapshotsForReboot(): void {
    this.pumping = false;
    this.lastStackSnapshot = [];
    this.lastRStackSnapshot = [];
    this.lastLatestAddr = -1;
    this.lastBankCount = 0;
    this.lastBreakpointWords = new Set();
    this.lastProjectNames = [];
    this.lastSysvarsSnapshot = [];
    this.zone.run(() => this.pausedWord.set(undefined));
  }

  /** Constructs a fresh `Machine` and publishes its initial bank/arena
   * signals — the synchronous half of booting. Split out from
   * `performBoot()` so `ngAfterViewInit` can run this (and everything
   * else that doesn't need the system vocabulary yet) before its own
   * first `await`; see that method's comment for why the ordering
   * matters. `bootProject` (M54): threaded straight into `Machine`'s own
   * option of the same name — set only by `tick()`'s `'restart-project'`
   * branch, when a resize-triggered restart needs the fresh `Machine` to
   * boot straight back into the project whose saved sizes triggered it,
   * rather than empty. */
  private constructMachine(bootProject?: string): void {
    const storageHal = createLocalStorageHalIfSupported();
    this.canvasScreenHal = this.offscreenCtx ? new CanvasScreenHal(this.offscreenCtx) : undefined;
    this.machine = new Machine({
      screenHal: this.canvasScreenHal,
      storageHal,
      timingHal: PERFORMANCE_TIMING_HAL,
      remoteChannel: this.remoteChannel,
      bootProject,
    });
    // M59: CanvasScreenHal reads glyph data from the arena's FONT bank
    // (FONT-BASE sysvar) on every blit, but it's constructed before the
    // Machine that owns that arena — attach() supplies the reference
    // now that one exists, before anything can possibly blitGlyph().
    this.canvasScreenHal?.attach(this.machine.arena, this.machine.sysvars);
    // Zone-wrapped (unlike the original inline ngAfterViewInit code) since
    // this also runs from tick()'s 'cold' branch, which is already
    // outside the Angular zone — signals set from there need an explicit
    // zone.run() to actually schedule change detection, the same
    // reasoning every other tick()-driven signal update already follows.
    this.zone.run(() => {
      this.bankTable.set(this.machine.banks.getAllBanks());
      this.arenaSizeBytes.set(this.machine.arena.sizeBytes);
      this.sysvarsTable.set(listSysvars(this.machine.sysvars));
    });
    this.lastBankCount = this.machine.banks.getAllBanks().length;
    this.lastSysvarsSnapshot = listSysvars(this.machine.sysvars).map((e) => e.value);
  }

  /** Loads the system vocabulary into the current `this.machine` and
   * starts its on-screen REPL. The async half of booting, shared between
   * `ngAfterViewInit` (after its synchronous prefix, see
   * `constructMachine()`'s comment) and `performBoot()` below. */
  private async loadVocabularyAndStartRepl(): Promise<void> {
    // DEVELOPING.md §6: the system vocabulary (WORDS, SEE, ...) is plain
    // Forth source, not native primitives — loaded once here, before the
    // REPL starts accepting input, so it's available from the very first
    // prompt. An interim host-text-file step, not the eventual
    // portable-screens answer (§4).
    // M59: the default font loads in parallel — independent fetches,
    // nothing here depends on font content — but both are awaited
    // before VERSION/startRepl() below, so no glyph is ever blitted
    // before real font bytes exist in the FONT bank (the same ordering
    // guarantee this method already gave system.fth).
    await Promise.all([this.loadSystemVocabulary(), this.loadDefaultFont()]);

    // M7a: the outer loop lives entirely in the engine now — prompt,
    // ACCEPT a line onto the screen, interpret, repeat, forever. The app
    // shell's only job is to keep calling step() so it can make progress.
    this.zone.runOutsideAngular(() => {
      // Startup banner (VERSION, primitives.ts case 143) — ordinary
      // interpret() call, not REPL-driven, so it never shows a prompt or
      // "ok" of its own; just the "Rebel Forth vMAJOR.MILESTONE.BUILD"
      // line, once, before the first real prompt appears below it.
      this.machine.interpret('VERSION');
      this.machine.startRepl();
      this.startPump();
    });
  }

  /** The entire boot sequence a `Machine` needs before it can usefully
   * run: construct it, load the system vocabulary, start the REPL.
   * Called from `tick()` whenever `step()` reports the `'cold'` status
   * (`COLD`, rebel-opcodes.json 132) — the Forth-to-host signal the
   * engine sends because a full reset can't happen in place (`Machine`'s
   * memory-holding fields are readonly, repl.ts) — or the `'restart-
   * project'` status (M54's resize-triggered restart, same reason, with
   * `bootProject` set so the fresh `Machine` reopens where the old one
   * left off instead of booting empty). The old `Machine`/session, if
   * any, is simply dropped — it holds no listeners or timers of its
   * own, so plain GC is enough; nothing here needs to explicitly tear it
   * down. Unlike `ngAfterViewInit`, this has no whenStable()-observing
   * caller to worry about, so `constructMachine()` and the async half
   * don't need to be kept either side of any particular `await`. */
  private async performBoot(bootProject?: string): Promise<void> {
    this.constructMachine(bootProject);
    await this.loadVocabularyAndStartRepl();
  }

  /** TERMINAL (rebel-opcodes.json 147, `tick()`'s `'terminal'` status):
   * connects this session to `this.remoteBoard` — building it (and its
   * `RemoteTerminal` decoder) the first time, or just resuming an
   * already-running one on a reconnect after Ctrl+Escape (see the class
   * field comments for why it persists). The two `ByteSink`s below close
   * over `this.remoteBoard`/`this.remoteTerminal` rather than local
   * variables — unlike the engine's own loopback test harness (which
   * closes over `let` variables only assigned *after* `new RemoteBoard()`
   * returns), reading `this.*` fields is safe the moment `board.start()`
   * runs below, since both fields are already assigned by then (ordinary
   * sequential statements, not nested inside either constructor's own
   * call stack) — no reentrancy hazard. */
  private async connectToRemote(): Promise<void> {
    if (!this.remoteBoard) {
      const boardSink: ByteSink = { writeBytes: (b) => this.remoteTerminal?.receiveBytes(b) };
      const terminalSink: ByteSink = { writeBytes: (b) => this.remoteBoard?.receiveBytes(b) };
      // Reuses this.canvasScreenHal — the SAME instance the local machine
      // already attached to its own arena/FONT bank. That's enough:
      // BoardScreenHal (remote-board.ts) never reads glyph pixels, only
      // forwards charCode numbers over the wire, so only the terminal
      // side's already-loaded font ever matters for rendering — no
      // separate Arena/FONT bank needed for the board (REMOTE-TERMINAL.md
      // §7's own suggestion, made unnecessary here by already having a
      // live local Machine with a real font loaded).
      this.remoteTerminal = new RemoteTerminal(terminalSink, 80, 60, this.canvasScreenHal);
      // ink 6 (yellow) on paper 1 (blue), Oliver's request — a
      // deliberately different color scheme from local's default
      // green-on-black, so the very first paint after connecting is its
      // own visual "you're on a different machine now" signal, before
      // any text says so.
      this.remoteBoard = new RemoteBoard(boardSink, { headless: true, screenCols: 80, screenRows: 60, ink: 6, paper: 1 });
      await this.loadSystemVocabulary(this.remoteBoard.machine);
      this.zone.runOutsideAngular(() => {
        this.remoteBoard!.machine.interpret('VERSION');
        this.remoteBoard!.machine.startRepl();
      });
      this.remoteBoard.start();
    }
    // Repaints the board's actual current CHAR-bank content onto the
    // shared canvas — essential on a reconnect (the canvas currently
    // shows whatever the local machine last drew while disconnected);
    // a harmless near-duplicate of the board's own just-ran boot cls()
    // on a fresh connect.
    this.remoteBoard!.machine.screen.redrawAll();
    this.connectedToRemote = true;
    this.wake();
  }

  /** Ctrl+Escape (`handleKeyEvent`): returns keyboard/rendering control to
   * the local machine. The board itself is left running, untouched — see
   * the class field comments for why (persists across disconnect). */
  private disconnectFromRemote(): void {
    this.connectedToRemote = false;
    // Restores the canvas to the local machine's own actual content,
    // undoing the board's last-drawn pixels left on the shared offscreen
    // canvas (same Screen.redrawAll() connectToRemote() uses, the other
    // direction).
    this.machine.screen.redrawAll();
    this.wake();
  }

  // Fetched relative to <base href> — public/system.fth is copied to
  // the build root by angular.json's assets glob, same as
  // manifest.webmanifest/favicon.ico already are, so this resolves
  // correctly under both local dev (base "/") and the GitHub Pages
  // deployment (base "/rebel-sim/", set via --base-href at build
  // time) — and is already offline-precached by the service worker
  // for free, alongside those same assets. A colon-definition can span
  // multiple interpret() calls just fine (STATE persists as a sysvar
  // across them), so feeding one line at a time needs no special
  // multi-line handling. Deliberately NOT wrapped in a try/catch the
  // way registerWebMcpTools() is — a broken system vocabulary is a bug
  // in *our* source, not a missing browser feature, and should fail
  // loudly rather than silently boot without WORDS/SEE.
  private async loadSystemVocabulary(machine: Machine = this.machine): Promise<void> {
    const response = await fetch('system.fth');
    if (!response.ok) {
      throw new Error(`failed to fetch system.fth: ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    this.zone.runOutsideAngular(() => {
      for (const line of text.split('\n')) {
        machine.interpret(line);
      }
    });
  }

  // M59: the default system font — same "fetched public asset, offline-
  // precached by the service worker for free" treatment as
  // loadSystemVocabulary()'s system.fth (see that method's own comment).
  // Not wrapped in try/catch, same reasoning: a missing/broken bundled
  // font is a bug in our own build, not a recoverable runtime condition,
  // and should fail loudly rather than silently boot with blank glyphs.
  // Writes straight into the arena at FONT-BASE (set by the engine at
  // Machine construction, repl.ts) — no Storage/project-asset framing
  // involved, this is the app's own bundled default, not a saved
  // project asset.
  private async loadDefaultFont(): Promise<void> {
    const response = await fetch('rebel.FNT');
    if (!response.ok) {
      throw new Error(`failed to fetch rebel.FNT: ${response.status} ${response.statusText}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const fontBase = this.machine.sysvars.get('FONT', 'FONT-BASE');
    for (let i = 0; i < bytes.length; i++) {
      this.machine.arena.writeByte(fontBase + i, bytes[i]);
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
  }

  // Bound once so removeEventListener actually matches. Recomputes the
  // visible canvas's backing resolution — devicePixelRatio can change at
  // runtime (dragging the window to a different-DPI display, browser
  // zoom), and `resize` fires for the common cases of that. Assigning
  // canvas.width/height inside applyPresentationSize() clears the visible
  // canvas back to transparent black (that's the DOM canvas spec, not a
  // bug) — wake() forces the idle-gated pump to run one more tick() so
  // its drawImage repaints the just-cleared canvas from the offscreen
  // framebuffer immediately, instead of leaving it black until the next
  // keystroke or other event happens to call wake() anyway.
  private readonly onResize = (): void => {
    this.applyPresentationSize();
    this.wake();
  };

  private applyPresentationSize(): void {
    const canvas = this.screenRef.nativeElement;
    const size = computePresentationSize(
      FRAMEBUFFER_WIDTH,
      FRAMEBUFFER_HEIGHT,
      TARGET_CSS_WIDTH,
      window.devicePixelRatio || 1,
    );
    canvas.width = size.backingWidth;
    canvas.height = size.backingHeight;
    // Only width is set inline — height is deliberately left for
    // app.css's aspect-ratio:4/3 to derive (a real bug, found and
    // fixed alongside the 640x480 experiment: setting both explicitly
    // meant max-width:100% clamping the width on a narrow viewport had
    // nothing to make height follow, visibly squashing the canvas
    // instead of scaling down uniformly — see .screen's own comment).
    canvas.style.width = `${size.cssWidth}px`;
    // Resizing a canvas resets its 2D context state, including
    // imageSmoothingEnabled — reapply it every time.
    if (this.presentCtx) {
      this.presentCtx.imageSmoothingEnabled = false;
    }
  }

  private handleKeyEvent(e: KeyboardEvent, pressed: boolean): void {
    if (pressed && e.repeat) {
      return; // auto-repeat isn't a new press edge (docs/KEYBOARD.md §1)
    }
    // Host UI shortcut (monitorsVisible), not a Forth keystroke — caught
    // and consumed here, before codeToUsage, so it never reaches the
    // emulated keyboard at all (checked on both keydown and keyup so
    // neither half of the chord leaks through if Ctrl happens to be
    // released before the letter key is). Either binding works — some
    // layouts make one of the two awkward to reach.
    if (e.ctrlKey && (e.code === 'Backquote' || e.code === 'Backslash')) {
      e.preventDefault();
      if (pressed) {
        this.toggleMonitors();
      }
      return;
    }
    // TERMINAL's escape chord (rebel-opcodes.json 147) — the classic
    // telnet/SSH "drop out of a remote session" convention. Only ever
    // disconnects; pressing it while not connected is a no-op. Checked on
    // both keydown/keyup, same reasoning as the monitor toggle above.
    if (e.ctrlKey && e.code === 'Escape') {
      e.preventDefault();
      if (pressed && this.connectedToRemote) {
        this.disconnectFromRemote();
      }
      return;
    }
    const usageCode = codeToUsage(e.code);
    if (usageCode === undefined) {
      return;
    }
    e.preventDefault();
    if (this.connectedToRemote) {
      this.remoteTerminal!.sendKeyEvent(usageCode, pressed);
    } else {
      this.machine.keyboard.pushRawEvent(usageCode, pressed);
    }
    this.wake();
  }

  // M9 (WebMCP): registers this page's tools via Angular's own
  // (experimental) WebMCP support — the real web-platform mechanism
  // (document.modelContext), not a bespoke server. Six tools: one write
  // (type) merging into the same session the keyboard feeds via
  // remoteChannel, five reads reusing exactly the introspection surface
  // already built for the inspector panel (Machine.stack/rstack,
  // listDictionaryEntries, Machine.banks, Screen.readRowText) — no new
  // engine-level introspection needed. declareExperimentalWebMcpTool
  // needs an explicit injector here since ngAfterViewInit isn't itself
  // an active injection context. Wrapped defensively: WebMCP is an
  // experimental browser feature (chrome://flags/#enable-webmcp-testing
  // as of this writing) — must degrade silently on browsers without it,
  // same as localStorage support above.
  private registerWebMcpTools(): void {
    // Deliberately NOT `const machine = this.machine` — COLD (§ tick())
    // can replace this.machine after tools are registered (registration
    // happens once, in ngAfterViewInit), so every closure below reads
    // `this.machine` fresh on each call instead of closing over whichever
    // Machine existed at registration time. remoteChannel is fine to
    // capture: it's host-level and outlives any one Machine.
    const remoteChannel = this.remoteChannel;
    const noArgsSchema = { type: 'object', properties: {}, required: [] } as const;

    // Each declareExperimentalWebMcpTool call is its own generic
    // instantiation (a distinct inputSchema per tool) — kept as
    // separate call sites rather than looped over a mixed-shape array,
    // which collapses TS's per-tool schema inference.
    this.safeRegisterWebMcpTool('type', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'type',
          description:
            'Type text into the running Rebel-Sim Forth REPL, as if typed on the keyboard. ' +
            'Include a trailing newline to submit the line. Executing a word (e.g. "5 SQUARE .") ' +
            'and defining one (e.g. ": SQUARE DUP * ;") both just work — send them as text.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Characters to type, in order.' } },
            required: ['text'],
          },
          execute: ({ text }) => {
            remoteChannel.push(text);
            this.wake();
            return `queued ${text.length} char(s)`;
          },
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('read_screen', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'read_screen',
          description: 'Read the current text screen buffer, one row per line.',
          inputSchema: noArgsSchema,
          execute: () => {
            const rows: string[] = [];
            for (let r = 0; r < this.machine.screen.rows; r++) {
              rows.push(this.machine.screen.readRowText(r));
            }
            return rows.join('\n');
          },
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('read_stack', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'read_stack',
          description: 'Read the data stack, top to bottom, space-separated.',
          inputSchema: noArgsSchema,
          execute: () => this.machine.stack.toArray().join(' ') || '(empty)',
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('read_return_stack', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'read_return_stack',
          description: 'Read the return stack, top to bottom, space-separated.',
          inputSchema: noArgsSchema,
          execute: () => this.machine.rstack.toArray().join(' ') || '(empty)',
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('read_dictionary', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'read_dictionary',
          description: 'List all defined word names, most-recently-defined first.',
          inputSchema: noArgsSchema,
          execute: () => listDictionaryEntries(this.machine).map((e) => e.name).join(' ') || '(empty)',
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('read_banks', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'read_banks',
          description: 'List memory banks (tag, name, base offset, size in bytes), one per line.',
          inputSchema: noArgsSchema,
          execute: () =>
            this.machine.banks
              .getAllBanks()
              .map((b) => `${b.tag} ${b.name} ${b.base} ${b.size}`)
              .join('\n'),
        },
        this.injector,
      ),
    );

    // DEBUGGING.md (M10): word-level breakpoints. set/clear/list are
    // thin wrappers over Machine's own methods (which already throw on
    // an unknown word — left to propagate as a real tool error rather
    // than swallowed into a string). debug_status/debug_continue read
    // and clear this.pausedAtBreakpoint, the flag startPump's tick()
    // checks each frame — continue doesn't drive step() itself, it just
    // un-pauses the pump so the *next* frame's own step() call resumes
    // past the breakpoint (keeping "one place drives step()" true).
    this.safeRegisterWebMcpTool('debug_set_breakpoint', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'debug_set_breakpoint',
          description: 'Pause execution right before the named word runs, every time it is entered.',
          inputSchema: {
            type: 'object',
            properties: { word: { type: 'string', description: 'Name of a defined word.' } },
            required: ['word'],
          },
          execute: ({ word }) => {
            this.machine.setBreakpoint(word);
            this.wake();
            return `breakpoint set on ${word.toUpperCase()}`;
          },
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('debug_clear_breakpoint', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'debug_clear_breakpoint',
          description: 'Remove a breakpoint set by debug_set_breakpoint.',
          inputSchema: {
            type: 'object',
            properties: { word: { type: 'string', description: 'Name of a defined word.' } },
            required: ['word'],
          },
          execute: ({ word }) => {
            this.machine.clearBreakpoint(word);
            this.wake();
            return `breakpoint cleared on ${word.toUpperCase()}`;
          },
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('debug_list_breakpoints', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'debug_list_breakpoints',
          description: 'List all currently-armed breakpoints.',
          inputSchema: noArgsSchema,
          execute: () => this.machine.listBreakpoints().join(' ') || '(none)',
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('debug_status', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'debug_status',
          description: 'Report whether the REPL is running normally or paused at a breakpoint.',
          inputSchema: noArgsSchema,
          execute: () => {
            const word = this.pausedWord();
            return word ? `paused at ${word}` : 'running';
          },
        },
        this.injector,
      ),
    );

    this.safeRegisterWebMcpTool('debug_continue', () =>
      declareExperimentalWebMcpTool(
        {
          name: 'debug_continue',
          description: 'Resume execution after a breakpoint pause.',
          inputSchema: noArgsSchema,
          execute: () => {
            if (this.pausedWord() === undefined) {
              throw new Error('not currently paused at a breakpoint');
            }
            this.resumeFromBreakpoint();
            return 'resumed';
          },
        },
        this.injector,
      ),
    );
  }

  // Ctrl+`/Ctrl+\ (handleKeyEvent) — called from outside the Angular
  // zone (the keydown listener is registered via runOutsideAngular),
  // so the write needs zone.run() to actually reach the DOM, same
  // reasoning as resumeFromBreakpoint() just below.
  private toggleMonitors(): void {
    this.zone.run(() => this.monitorsVisible.update((v) => !v));
  }

  // Shared by the debug_continue WebMCP tool and the inspector's
  // Continue button — one place, so the two never drift. Safe to call
  // from either a real Angular-zone context (the button's click
  // handler already is) or an external callback outside it (WebMCP's
  // execute()) — zone.run() is harmless to nest/call from anywhere,
  // it just guarantees change detection actually runs for this write.
  protected resumeFromBreakpoint(): void {
    this.zone.run(() => this.pausedWord.set(undefined));
    this.wake();
  }

  // DEBUGGING.md (M10) UI: clicking a breakable dictionary word arms/
  // disarms a breakpoint on it directly (no WebMCP round-trip needed).
  // Non-breakable entries (primitives, CONSTANTs, plain CREATE/VARIABLE
  // — DictionaryEntry.breakable, dictionary.ts) are inert here, matching
  // Machine.setBreakpoint's own rejection of them. breakpointWords isn't
  // written here — tick()'s poll/diff below picks the change up next
  // frame, the same single update path a WebMCP-set breakpoint uses.
  protected toggleBreakpoint(word: DictionaryEntry): void {
    if (!word.breakable) {
      return;
    }
    if (this.breakpointWords().has(word.name)) {
      this.machine.clearBreakpoint(word.name);
    } else {
      this.machine.setBreakpoint(word.name);
    }
    this.wake();
  }

  // Web-only monitor-panel sugar, not a portable engine concern
  // (dictionary.ts's own comment on getPrimitiveNote): the dictionary
  // list's hover tooltip. A primitive with a rebel-opcodes.json `note`
  // shows that instead of the breakpoint hint — strictly more useful
  // there, since primitives are never breakable anyway (the hint would
  // just say "no compiled body to break on"). Falls back to the
  // original breakpoint-oriented text for user-defined words (which
  // never have a note) and for primitives with no recorded note.
  protected wordTooltip(word: DictionaryEntry): string {
    const note = getPrimitiveNote(word.name);
    if (note) {
      return note;
    }
    return word.breakable ? 'click to toggle a breakpoint' : 'no compiled body to break on';
  }

  protected clearBreakpointByName(name: string): void {
    this.machine.clearBreakpoint(name);
  }

  // Inspector-panel display only — Bank itself stays plain decimal
  // numbers everywhere else (engine, WebMCP's read_banks, tests).
  protected formatBankAddr(addr: number): string {
    return '0x' + addr.toString(16).toUpperCase().padStart(4, '0');
  }

  protected formatBankSize(bytes: number): string {
    const unit = bytes >= 1024 * 1024 ? 1024 * 1024 : bytes >= 1024 ? 1024 : 1;
    const label = unit === 1024 * 1024 ? 'MB' : unit === 1024 ? 'kB' : 'B';
    const value = (bytes / unit).toFixed(2).replace(/\.?0+$/, '');
    return `${value} ${label}`;
  }

  // "project storage" panel — a native title-attribute tooltip listing
  // one saved project's banks, read directly off Storage.listProjectAssets()
  // (read-only, no arena/bank mutation) rather than cached — called from
  // the template on hover, cheap enough (a handful of small localStorage
  // reads) not to need its own polled signal the way the panel's own
  // project-name list does.
  protected projectBankTooltip(name: string): string {
    const assets = this.machine.storage.listProjectAssets(name);
    if (assets.length === 0) {
      return '(no banks found)';
    }
    return assets.map((a) => `${a.tag}/${a.name} (${this.formatBankSize(a.size)})`).join('\n');
  }

  // "project storage" panel, click on a project name — one ZIP, every
  // raw file the project actually has on disk (Storage.listProjectFiles(),
  // unfiltered — a faithful copy, not the engine's own filtered/parsed
  // bank view listProjectAssets() above uses). Files sit at the
  // archive's own top level, not nested under a <name>/ folder — the
  // ZIP's own filename (<name>.zip) already carries that, and a real
  // project's files (00000000.SYS, DICT.DCT, ...) are already uniquely
  // named within one project, so nothing collides without it.
  protected downloadProject(name: string): void {
    const files = this.machine.storage.listProjectFiles(name);
    const zipBytes = buildZip(files.map((f) => ({ filename: f.filename, bytes: f.bytes })));
    // .slice() first: Uint8Array's .buffer is typed ArrayBufferLike
    // (could theoretically be a SharedArrayBuffer) in current DOM libs,
    // which Blob's BlobPart type rejects — .slice() returns a fresh
    // Uint8Array TypeScript can see is backed by a real ArrayBuffer.
    const url = URL.createObjectURL(new Blob([zipBytes.slice().buffer], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // WebMCP is an experimental browser feature
  // (chrome://flags/#enable-webmcp-testing as of this writing) — must
  // degrade silently on browsers without it, same as localStorage
  // support above. Guards both a synchronous throw (NG0203-style) and
  // an async rejection from the returned Promise.
  private safeRegisterWebMcpTool(name: string, register: () => Promise<void>): void {
    try {
      register().catch((err: unknown) => {
        console.warn(`WebMCP tool "${name}" not registered (unsupported browser?)`, err);
      });
    } catch (err) {
      console.warn(`WebMCP tool "${name}" not registered (unsupported browser?)`, err);
    }
  }

  // Compared against each tick's stack snapshot so the Angular zone is
  // only entered when the inspector's stack readout actually needs to
  // change — NOT gated on step()'s status. A whole line can finish *and*
  // the REPL loop can re-block waiting on the next line's ACCEPT within
  // the same step() call (interpret, print ok/error, loop back, block on
  // the empty queue — all before this call returns), so the tick where
  // the stack actually changed can still report 'blocked'.
  private lastStackSnapshot: number[] = [];
  private lastRStackSnapshot: number[] = [];
  private lastLatestAddr = -1;
  private lastBankCount = 0;
  private lastBreakpointWords: ReadonlySet<string> = new Set();
  private lastProjectNames: string[] = [];
  private lastSysvarsSnapshot: number[] = [];

  // Restarts the requestAnimationFrame chain if tick() previously let it
  // die from having nothing to do. Idempotent — safe to call from any
  // event that *might* give step() something to do again, whether or not
  // the chain is actually stopped right now, and safe to call from
  // *inside* the Angular zone (toggleBreakpoint/resumeFromBreakpoint are
  // template click handlers, which run there) — runOutsideAngular here
  // is what keeps the whole reawakened chain off-zone, since zone.js
  // callbacks otherwise run in whatever zone scheduled them, and every
  // later tick() reschedules itself from inside its own prior call.
  private wake(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    this.zone.runOutsideAngular(() => requestAnimationFrame(this.tick));
  }

  private startPump(): void {
    this.wake();
  }

  // Must be called from outside the Angular zone (ngAfterViewInit's call
  // site already is) — requestAnimationFrame callbacks scheduled there
  // stay outside it too, which is the point: no change detection runs on
  // frames that don't need it. The engine draws into the offscreen
  // framebuffer canvas synchronously as primitives execute (the HAL,
  // M3); this pump is what actually presents it to the visible canvas,
  // once per frame, independent of the interpreter's own pace
  // (PORTING-WEB.md §6) — the decoupled render cadence that section
  // originally called for, finally wired up as a side effect of fixing
  // the uneven-pixel-width bug (canvas-presenter.ts).
  //
  // The chain is *not* unconditional: a frame that finds step() blocked
  // (or skipped — paused at a breakpoint) and none of the polled UI
  // signals changed lets the chain die instead of scheduling another
  // frame, rather than redrawing/diffing at 60Hz forever while the REPL
  // just sits at an idle prompt (the measured source of persistent
  // idle-tab CPU use). Every place that can make step() have something
  // to do again calls wake() to restart it: a keystroke (handleKeyEvent),
  // a WebMCP `type`/breakpoint call, and the Continue button/
  // debug_continue (resumeFromBreakpoint). SAVE/RESTORE/BSAVE/BLOAD are
  // now ordinary synchronous primitives (localStorage-backed storage,
  // not OPFS) — they run to completion inside a single step() call like
  // any other word, no separate suspend/resume phase to gate on here.
  private readonly tick = (): void => {
    // TERMINAL (147): while connected, the board's Machine is what gets
    // stepped/drawn each frame — the local machine is simply never
    // step()-ped during this time (freezing it needs no separate
    // mechanism, it falls out of this branch never reaching the body
    // below), so there's no risk of local and board output interleaving
    // on the shared canvas. See tickRemote()'s own comment for why no
    // monitor-panel diffing happens on this path.
    if (this.connectedToRemote) {
      this.tickRemote();
      return;
    }
    let status: StepStatus | undefined;
    try {
      if (this.pausedWord() === undefined) {
        status = this.machine.step(App.STEP_BUDGET);
        if (status === 'breakpoint') {
          const word = this.machine.pausedAtWord();
          this.zone.run(() => this.pausedWord.set(word));
        }
      }
    } catch (e) {
      // The on-screen REPL loop (replLoop) catches and prints ordinary
      // Forth errors itself and keeps running — reaching here means
      // something escaped that, a real engine bug rather than a user
      // mistake. Nothing left to drive the page with; surface it loudly.
      this.pumping = false;
      console.error('Rebel-Sim REPL loop crashed', e);
      return;
    }
    if (status === 'terminal') {
      // TERMINAL (rebel-opcodes.json 147): connecting is async (fetching
      // system.fth for the board the first time) — connectToRemote()
      // itself flips connectedToRemote and calls wake() once ready. This
      // tick() call itself is ending the RAF chain right here (no
      // trailing requestAnimationFrame below, same as the cold/restart-
      // project branches above) without ever having gone through the
      // normal "stop pumping" exit path further down — pumping must be
      // reset here for the same reason resetUiSnapshotsForReboot() resets
      // it for those two branches: wake()'s own "if not already pumping"
      // guard would otherwise treat the stale `true` left over from this
      // still-running frame as "a chain is already scheduled" and
      // silently skip rescheduling one, permanently starving the pump.
      this.pumping = false;
      void this.connectToRemote();
      return;
    }
    if (status === 'cold') {
      // COLD (rebel-opcodes.json 132): the engine itself made no state
      // change (inner.ts's dispatch() special-cases this token before
      // executePrimitive ever runs) — reconstructing the Machine is
      // entirely this host's job. The old Machine/session is abandoned
      // here, not resumed; performBoot() replaces this.machine and
      // restarts the pump once the fresh one is ready.
      this.resetUiSnapshotsForReboot();
      void this.performBoot();
      return;
    }
    if (status === 'restart-project') {
      // M54: a BANK-RESIZE (146) that was SAVEd left the running Machine
      // with a bank layout that no longer matches what's on disk —
      // RESTORE (128) detected the mismatch and, rather than patching
      // bytes into a Machine whose readonly fields can't actually move,
      // asked for the same "throw this one away" reboot COLD gets, this
      // time with pendingRestartProject() as bootProject so the fresh
      // Machine re-derives every bank's base/size from what was actually
      // saved and reopens straight back into it.
      const project = this.machine.pendingRestartProject();
      this.resetUiSnapshotsForReboot();
      void this.performBoot(project);
      return;
    }
    if (this.presentCtx) {
      const canvas = this.screenRef.nativeElement;
      this.presentCtx.drawImage(this.offscreen, 0, 0, canvas.width, canvas.height);
    }
    let changed = false;
    const current = this.machine.stack.toArray();
    if (!arraysEqual(current, this.lastStackSnapshot)) {
      this.lastStackSnapshot = current;
      this.zone.run(() => this.stack.set(current));
      changed = true;
    }
    const currentRStack = this.machine.rstack.toArray();
    if (!arraysEqual(currentRStack, this.lastRStackSnapshot)) {
      this.lastRStackSnapshot = currentRStack;
      this.zone.run(() => this.returnStack.set(currentRStack));
      changed = true;
    }
    // New definitions only ever append to LATEST — comparing the
    // address is a cheap enough guard to avoid re-walking the whole
    // dictionary chain (listDictionaryEntries) on every frame.
    const latestAddr = this.machine.sysvars.getLatest();
    if (latestAddr !== this.lastLatestAddr) {
      this.lastLatestAddr = latestAddr;
      const entries = listDictionaryEntries(this.machine);
      this.zone.run(() => this.dictionaryWords.set(entries));
      changed = true;
    }
    // Banks are effectively boot-fixed today (M8's vocabulary has no
    // way to create one at runtime), but diff by count anyway rather
    // than assuming that stays true, matching the other two guards.
    const bankCount = this.machine.banks.getAllBanks().length;
    if (bankCount !== this.lastBankCount) {
      this.lastBankCount = bankCount;
      const banks = this.machine.banks.getAllBanks();
      this.zone.run(() => this.bankTable.set(banks));
      changed = true;
    }
    // Left-side sysvars panel — every field changes constantly during
    // normal execution (SP/RP/CURSOR-X/Y move on nearly every word), so
    // this re-reads all of them every tick rather than trying to guard
    // on some cheaper proxy the way LATEST-address/bankCount do for
    // their own sections; the diff below is just against the flat value
    // list so an idle prompt still lets the pump die like everything else.
    const currentSysvars = listSysvars(this.machine.sysvars);
    const currentSysvarValues = currentSysvars.map((e) => e.value);
    if (!arraysEqual(currentSysvarValues, this.lastSysvarsSnapshot)) {
      this.lastSysvarsSnapshot = currentSysvarValues;
      this.zone.run(() => this.sysvarsTable.set(currentSysvars));
      changed = true;
    }
    // DEBUGGING.md (M10) UI: one diff-and-set path for breakpointWords
    // regardless of whether a breakpoint was armed from this UI
    // (toggleBreakpoint) or a WebMCP debug_set_breakpoint call — same
    // reasoning as the dictionary/bank guards above.
    const currentBreakpoints = new Set(this.machine.listBreakpoints());
    if (!setsEqual(currentBreakpoints, this.lastBreakpointWords)) {
      this.lastBreakpointWords = currentBreakpoints;
      this.zone.run(() => this.breakpointWords.set(currentBreakpoints));
      changed = true;
    }
    // "project storage" panel — only PROJECT/SAVE/BSAVE (all ordinary
    // primitives now, M33) can ever add a new name, but there's no
    // separate "storage changed" signal to gate on the way bankCount/
    // LATEST-address stand in for their own sections, so this just
    // re-scans every tick like the others — a plain localStorage prefix
    // scan, cheap enough not to need a real change signal.
    const currentProjects = this.machine.storage.listProjects();
    if (!arraysEqual(currentProjects, this.lastProjectNames)) {
      this.lastProjectNames = currentProjects;
      this.zone.run(() => this.projectNames.set(currentProjects));
      changed = true;
    }
    // 'more-to-run' means step() hit its budget mid-line and genuinely
    // needs another frame to keep making progress; every other status
    // (including having been skipped entirely while paused) means
    // step() itself has nothing pending until some other event calls
    // wake() — so only keep scheduling frames if something was actually
    // pending or actually changed.
    if (status !== 'more-to-run' && !changed) {
      this.pumping = false;
      return;
    }
    requestAnimationFrame(this.tick);
  };

  /** `tick()`'s connected-to-board counterpart (TERMINAL, 147). Much
   * smaller than the local body above: the board's `PLOT_CHAR`/`CLEAR`
   * frames already painted the shared `offscreen` canvas in real time
   * via `canvasScreenHal` (reused, `connectToRemote()`), so the one
   * shared `drawImage` present step is all the rendering this needs — no
   * separate render path. Deliberately doesn't diff/update the stack/
   * dictionary/banks/sysvars monitor panels (they keep showing the local
   * machine's last, frozen state while connected) — a named
   * simplification for this pass, not silently dropped. */
  private tickRemote(): void {
    let status: StepStatus | undefined;
    try {
      status = this.remoteBoard!.machine.step(App.STEP_BUDGET);
    } catch (e) {
      this.pumping = false;
      console.error('Rebel-Sim remote board crashed', e);
      return;
    }
    if (status === 'cold' || status === 'restart-project') {
      // Rebuilding just the board, not the local machine — same "throw
      // this one away" shape performBoot() uses for local COLD/RESTORE,
      // scoped to the board only. 'restart-project' can't actually occur
      // in practice today (the board has no storageHal, so RESTORE never
      // finds a saved-size mismatch to trigger it) but is handled the
      // same way defensively rather than left to fall through unhandled.
      this.remoteBoard = undefined;
      this.remoteTerminal = undefined;
      // Same reason the local 'terminal' branch above resets this before
      // its own async call — this frame's RAF chain ends right here, so
      // connectToRemote()'s later wake() needs a truthful `false` to
      // actually reschedule one instead of silently no-op-ing.
      this.pumping = false;
      void this.connectToRemote();
      return;
    }
    if (this.presentCtx) {
      const canvas = this.screenRef.nativeElement;
      this.presentCtx.drawImage(this.offscreen, 0, 0, canvas.width, canvas.height);
    }
    if (status !== 'more-to-run') {
      this.pumping = false;
      return;
    }
    requestAnimationFrame(this.tick);
  }
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}
