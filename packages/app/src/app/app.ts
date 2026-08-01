import {
  Component,
  NgZone,
  Injector,
  signal,
  ViewChild,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  declareExperimentalWebMcpTool,
} from '@angular/core';
import { Machine, runStorageSelfTest, listDictionaryEntries, RemoteChannel } from '@rebel-sim/engine';
import type { Bank, DictionaryEntry } from '@rebel-sim/engine';
import { CanvasScreenHal } from './canvas-screen-hal.js';
import { codeToUsage } from './browser-keymap.js';
import { createOpfsStorageHalIfSupported } from './opfs-storage-hal.js';
import { computePresentationSize } from './canvas-presenter.js';

// The real framebuffer resolution (matches repl.ts's DEFAULT_SCREEN_WIDTH/
// HEIGHT — the engine has no reason to expose these, they're boot-fixed
// per FORTH-ARCHITECTURE.md's current "no runtime mode change" state).
const FRAMEBUFFER_WIDTH = 320;
const FRAMEBUFFER_HEIGHT = 240;
const TARGET_CSS_WIDTH = 640; // ~2x at devicePixelRatio 1, same footprint as before

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
  protected readonly storageStatus = signal<string>('checking…');

  // Constructed in ngAfterViewInit — the engine's Screen.cls() (M3) runs
  // during Machine's own constructor and paints through the HAL
  // immediately, so the canvas must already exist before `new Machine()`.
  private machine!: Machine;

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
  // (M7/M7a). Generous enough that any line expressible today (no loop/
  // recursion words exist yet) finishes within a single frame, while
  // still bounding worst-case per-frame work if that ever changes.
  private static readonly STEP_BUDGET = 2000;

  // Guards against overlapping requestAnimationFrame chains.
  private pumping = false;

  // DEBUGGING.md (M10): set the instant step() returns 'breakpoint';
  // tick() then skips calling step() on every subsequent frame until a
  // debug_continue tool call clears it. Without this, a breakpoint
  // would resume on the very next animation frame (~16ms later) instead
  // of actually holding — step()'s return value is otherwise ignored
  // here, same as it always has been for 'blocked'/'more-to-run'.
  private pausedAtBreakpoint = false;

  constructor(
    private readonly zone: NgZone,
    private readonly injector: Injector,
  ) {}

  ngAfterViewInit(): void {
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

    const storageHal = createOpfsStorageHalIfSupported();
    this.machine = new Machine({
      screenHal: this.offscreenCtx ? new CanvasScreenHal(this.offscreenCtx) : undefined,
      storageHal,
      remoteChannel: this.remoteChannel,
    });
    this.screenRef.nativeElement.focus();
    this.bankTable.set(this.machine.banks.getAllBanks());
    this.lastBankCount = this.machine.banks.getAllBanks().length;
    this.registerWebMcpTools();

    // M5's end-to-end proof, mirroring CKernel::RunStorageSelfTest
    // (docs/STORAGE.md §8): round-trip a synthetic asset through the real
    // save/open path once at startup and surface PASS/FAIL, rather than
    // only ever finding out storage is broken the first time a real
    // project tries to use it.
    if (storageHal) {
      // PORTING-WEB.md §7: ask the browser not to casually evict a
      // user's project data (OPFS) the way ordinary origin storage can
      // be reclaimed under pressure — losing work because storage was
      // tight is a bad failure mode for a tool meant to feel like it
      // owns its own memory. Best-effort: the browser may still say no
      // (persist() resolves false), and there's nothing useful to do
      // about that beyond having asked.
      void navigator.storage?.persist?.();

      runStorageSelfTest(storageHal)
        .then((passed) => this.zone.run(() => this.storageStatus.set(passed ? 'OK' : 'FAILED')))
        .catch((err: unknown) => {
          this.zone.run(() => this.storageStatus.set('ERROR'));
          console.error('storage self-test threw', err);
        });
    } else {
      this.storageStatus.set('unavailable (no OPFS)');
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

    // M7a: the outer loop lives entirely in the engine now — prompt,
    // ACCEPT a line onto the screen, interpret, repeat, forever. The app
    // shell's only job is to keep calling step() so it can make progress.
    this.zone.runOutsideAngular(() => {
      this.machine.startRepl();
      this.startPump();
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.onResize);
  }

  // Bound once so removeEventListener actually matches. Recomputes the
  // visible canvas's backing resolution — devicePixelRatio can change at
  // runtime (dragging the window to a different-DPI display, browser
  // zoom), and `resize` fires for the common cases of that.
  private readonly onResize = (): void => this.applyPresentationSize();

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
    canvas.style.width = `${size.cssWidth}px`;
    canvas.style.height = `${size.cssHeight}px`;
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
    const usageCode = codeToUsage(e.code);
    if (usageCode === undefined) {
      return;
    }
    e.preventDefault();
    this.machine.keyboard.pushRawEvent(usageCode, pressed);
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
  // same as OPFS storage support above.
  private registerWebMcpTools(): void {
    const machine = this.machine;
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
            for (let r = 0; r < machine.screen.rows; r++) {
              rows.push(machine.screen.readRowText(r));
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
          execute: () => machine.stack.toArray().join(' ') || '(empty)',
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
          execute: () => machine.rstack.toArray().join(' ') || '(empty)',
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
          execute: () => listDictionaryEntries(machine).map((e) => e.name).join(' ') || '(empty)',
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
            machine.banks
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
            machine.setBreakpoint(word);
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
            machine.clearBreakpoint(word);
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
          execute: () => machine.listBreakpoints().join(' ') || '(none)',
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
          execute: () =>
            this.pausedAtBreakpoint ? `paused at ${machine.pausedAtWord() ?? '(unknown)'}` : 'running',
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
            if (!this.pausedAtBreakpoint) {
              throw new Error('not currently paused at a breakpoint');
            }
            this.pausedAtBreakpoint = false;
            return 'resumed';
          },
        },
        this.injector,
      ),
    );
  }

  // WebMCP is an experimental browser feature
  // (chrome://flags/#enable-webmcp-testing as of this writing) — must
  // degrade silently on browsers without it, same as OPFS storage
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
  // only entered when the stack-bar debug readout actually needs to
  // change — NOT gated on step()'s status. A whole line can finish *and*
  // the REPL loop can re-block waiting on the next prompt's ACCEPT
  // within the same step() call (interpret, loop back, draw "> ", block
  // on the empty queue — all before this call returns), so the tick
  // where the stack actually changed can still report 'blocked'.
  private lastStackSnapshot: number[] = [];
  private lastRStackSnapshot: number[] = [];
  private lastLatestAddr = -1;
  private lastBankCount = 0;

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
  private startPump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;

    const tick = (): void => {
      try {
        if (!this.pausedAtBreakpoint) {
          const status = this.machine.step(App.STEP_BUDGET);
          if (status === 'breakpoint') {
            this.pausedAtBreakpoint = true;
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
      if (this.presentCtx) {
        const canvas = this.screenRef.nativeElement;
        this.presentCtx.drawImage(this.offscreen, 0, 0, canvas.width, canvas.height);
      }
      const current = this.machine.stack.toArray();
      if (!arraysEqual(current, this.lastStackSnapshot)) {
        this.lastStackSnapshot = current;
        this.zone.run(() => this.stack.set(current));
      }
      const currentRStack = this.machine.rstack.toArray();
      if (!arraysEqual(currentRStack, this.lastRStackSnapshot)) {
        this.lastRStackSnapshot = currentRStack;
        this.zone.run(() => this.returnStack.set(currentRStack));
      }
      // New definitions only ever append to LATEST — comparing the
      // address is a cheap enough guard to avoid re-walking the whole
      // dictionary chain (listDictionaryEntries) on every frame.
      const latestAddr = this.machine.sysvars.getLatest();
      if (latestAddr !== this.lastLatestAddr) {
        this.lastLatestAddr = latestAddr;
        const entries = listDictionaryEntries(this.machine);
        this.zone.run(() => this.dictionaryWords.set(entries));
      }
      // Banks are effectively boot-fixed today (M8's vocabulary has no
      // way to create one at runtime), but diff by count anyway rather
      // than assuming that stays true, matching the other two guards.
      const bankCount = this.machine.banks.getAllBanks().length;
      if (bankCount !== this.lastBankCount) {
        this.lastBankCount = bankCount;
        const banks = this.machine.banks.getAllBanks();
        this.zone.run(() => this.bankTable.set(banks));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
