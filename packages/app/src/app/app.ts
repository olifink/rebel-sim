import { Component, NgZone, signal, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { Machine } from '@rebel-sim/engine';
import { CanvasScreenHal } from './canvas-screen-hal.js';

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit {
  @ViewChild('input') inputRef!: ElementRef<HTMLInputElement>;
  @ViewChild('screen') screenRef!: ElementRef<HTMLCanvasElement>;

  protected readonly log = signal<string>('Rebel-Sim\n');
  protected readonly stack = signal<number[]>([]);

  // Constructed in ngAfterViewInit — the engine's Screen.cls() (M3) runs
  // during Machine's own constructor and paints through the HAL
  // immediately, so the canvas must already exist before `new Machine()`.
  private machine!: Machine;

  constructor(private readonly zone: NgZone) {}

  ngAfterViewInit(): void {
    // getContext('2d') can be null in environments with no real canvas
    // backing (e.g. jsdom in unit tests) — degrade to the engine's
    // default no-op HAL rather than crashing; a real browser always has one.
    const ctx = this.screenRef.nativeElement.getContext('2d');
    this.machine = new Machine({ screenHal: ctx ? new CanvasScreenHal(ctx) : undefined });
    this.inputRef.nativeElement.focus();
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
