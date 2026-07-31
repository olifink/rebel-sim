import { Component, NgZone, signal, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { Machine, runStorageSelfTest } from '@rebel-sim/engine';
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
  protected readonly storageStatus = signal<string>('checking…');

  // Constructed in ngAfterViewInit — the engine's Screen.cls() (M3) runs
  // during Machine's own constructor and paints through the HAL
  // immediately, so the canvas must already exist before `new Machine()`.
  private machine!: Machine;

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

  constructor(private readonly zone: NgZone) {}

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
    });
    this.screenRef.nativeElement.focus();

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
    // unconditionally. There's still only one Channel binding (M9's
    // remote channel hasn't landed), so there's nothing to arbitrate yet.
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

  // Compared against each tick's stack snapshot so the Angular zone is
  // only entered when the stack-bar debug readout actually needs to
  // change — NOT gated on step()'s status. A whole line can finish *and*
  // the REPL loop can re-block waiting on the next prompt's ACCEPT
  // within the same step() call (interpret, loop back, draw "> ", block
  // on the empty queue — all before this call returns), so the tick
  // where the stack actually changed can still report 'blocked'.
  private lastStackSnapshot: number[] = [];

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
        this.machine.step(App.STEP_BUDGET);
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
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
