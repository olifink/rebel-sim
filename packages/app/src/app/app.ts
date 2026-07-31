import { Component, NgZone, signal, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { Machine, runStorageSelfTest } from '@rebel-sim/engine';
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

  submit(): void {
    const el = this.inputRef.nativeElement;
    const line = el.value;
    el.value = '';
    if (line.trim().length === 0) {
      return;
    }

    // The interpreter loop itself runs outside Angular's zone
    // (PORTING-WEB.md §6) — only the resulting stack snapshot crosses
    // back in to trigger a render. Forth's own output now lands on the
    // canvas directly (via the HAL, M3), not through this return path.
    let error: string | undefined;
    let stackSnapshot: number[] = [];
    this.zone.runOutsideAngular(() => {
      try {
        this.machine.interpret(line);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      stackSnapshot = this.machine.stack.toArray();
    });

    this.zone.run(() => {
      let entry = `> ${line}\n`;
      if (error) entry += `! ${error}\n`;
      this.log.update((prev) => prev + entry);
      this.stack.set(stackSnapshot);
    });
  }
}
