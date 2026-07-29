import { Component, NgZone, signal, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { Machine } from '@rebel-sim/engine';

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit {
  @ViewChild('input') inputRef!: ElementRef<HTMLInputElement>;

  protected readonly log = signal<string>('Rebel-Sim — M1 REPL\n');
  protected readonly stack = signal<number[]>([]);

  private readonly machine = new Machine();

  constructor(private readonly zone: NgZone) {}

  ngAfterViewInit(): void {
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
    // (PORTING-WEB.md §6) — only the resulting output/stack snapshot
    // crosses back in to trigger a render.
    let output = '';
    let error: string | undefined;
    let stackSnapshot: number[] = [];
    this.zone.runOutsideAngular(() => {
      try {
        output = this.machine.interpret(line);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        output = '';
      }
      stackSnapshot = this.machine.stack.toArray();
    });

    this.zone.run(() => {
      let entry = `> ${line}\n`;
      if (output) entry += output + '\n';
      if (error) entry += `! ${error}\n`;
      this.log.update((prev) => prev + entry);
      this.stack.set(stackSnapshot);
    });
  }
}
