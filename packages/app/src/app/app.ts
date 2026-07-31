import { Component, NgZone, signal, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { Machine, runStorageSelfTest, StepStatus } from '@rebel-sim/engine';
import { CanvasScreenHal } from './canvas-screen-hal.js';
import { codeToUsage } from './browser-keymap.js';
import { createOpfsStorageHalIfSupported } from './opfs-storage-hal.js';

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit, OnDestroy {
  @ViewChild('input') inputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('screen') screenRef!: ElementRef<HTMLCanvasElement>;

  protected readonly log = signal<string>('Rebel-Sim\n');
  protected readonly stack = signal<number[]>([]);
  protected readonly storageStatus = signal<string>('checking…');

  // Constructed in ngAfterViewInit — the engine's Screen.cls() (M3) runs
  // during Machine's own constructor and paints through the HAL
  // immediately, so the canvas must already exist before `new Machine()`.
  private machine!: Machine;

  // Bound once so removeEventListener in ngOnDestroy actually matches.
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyEvent(e, true);
  private readonly onKeyUp = (e: KeyboardEvent): void => this.handleKeyEvent(e, false);

  constructor(private readonly zone: NgZone) {}

  ngAfterViewInit(): void {
    // getContext('2d') can be null in environments with no real canvas
    // backing (e.g. jsdom in unit tests) — degrade to the engine's
    // default no-op HAL rather than crashing; a real browser always has one.
    const ctx = this.screenRef.nativeElement.getContext('2d');
    const storageHal = createOpfsStorageHalIfSupported();
    this.machine = new Machine({
      screenHal: ctx ? new CanvasScreenHal(ctx) : undefined,
      storageHal,
    });
    this.inputRef.nativeElement.focus();

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
    // PORTING-WEB.md §4) — a separate channel from the REPL <input> below,
    // which stays a plain cooked text field for typing Forth source at
    // tool-development speed. Rebel-Sim has no multi-arena/focus-
    // attachment model yet (FORTH-ARCHITECTURE.md's "current arena" is
    // fixed), so whether the REPL input box itself has DOM focus is used
    // as a simple proxy for "attached to the simulated keyboard or not":
    // while typing a command, keystrokes go to the input field only, not
    // into the Forth-visible queue.
    this.zone.runOutsideAngular(() => {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private handleKeyEvent(e: KeyboardEvent, pressed: boolean): void {
    if (document.activeElement === this.inputRef.nativeElement) {
      return; // typing a REPL command — not routed to the simulated keyboard
    }
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

  // Primitives run per animation frame while a line is in flight (M7).
  // Generous enough that any line expressible today (no loop/recursion
  // words exist yet) finishes within a single frame — same invisible
  // latency as before M7 — while still bounding worst-case per-frame
  // work if that ever changes. The only thing that makes a line span
  // multiple frames today is a blocking KEY with nothing queued yet.
  private static readonly STEP_BUDGET = 2000;

  // Guards against overlapping requestAnimationFrame chains if startPump()
  // were ever called while one is already running.
  private pumping = false;

  submit(): void {
    const el = this.inputRef.nativeElement;
    const line = el.value;
    el.value = '';
    if (line.trim().length === 0) {
      return;
    }

    this.log.update((prev) => prev + `> ${line}\n`);

    // beginLine()/step() (not the old single interpret() call) so a
    // blocking KEY inside this line suspends instead of throwing or
    // freezing the tab (PORTING-WEB.md §6, FORTH-ARCHITECTURE.md §7a).
    // Runs outside Angular's zone throughout — the driving pump below
    // only crosses back in once the line actually finishes or errors.
    this.zone.runOutsideAngular(() => {
      try {
        this.machine.beginLine(line);
      } catch (e) {
        this.zone.run(() => this.reportError(e));
        return;
      }
      this.startPump();
    });
  }

  // Must be called from outside the Angular zone (submit() already is) —
  // requestAnimationFrame callbacks scheduled there stay outside it too,
  // which is the point: no change detection runs on frames that don't
  // need it. Forth's own output lands on the canvas synchronously as
  // primitives execute (the HAL, M3), independent of this pump's pace.
  private startPump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;

    const tick = (): void => {
      let status: StepStatus;
      try {
        status = this.machine.step(App.STEP_BUDGET);
      } catch (e) {
        this.pumping = false;
        this.zone.run(() => this.reportError(e));
        return;
      }
      if (status === 'idle') {
        this.pumping = false;
        this.zone.run(() => this.stack.set(this.machine.stack.toArray()));
        return;
      }
      // 'blocked' or 'more-to-run' — keep pumping. A frame spent
      // 'blocked' is cheap (Channel.hasData() is an O(queue length)
      // scan) and lets the browser's own event loop (keydown delivery,
      // rendering, everything else) get a turn between checks.
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private reportError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.log.update((prev) => prev + `! ${message}\n`);
    this.stack.set(this.machine.stack.toArray());
  }
}
