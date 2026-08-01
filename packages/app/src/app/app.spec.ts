import { TestBed } from '@angular/core/testing';
import { App } from './app';

// M7a: the outer loop is driven entirely by a requestAnimationFrame pump
// now (no more synchronous submit()) — poll for the expected DOM state
// instead of asserting immediately after dispatch.
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Simulates a physical key press/release, exactly as app.ts's
// window-level keydown/keyup listeners expect (M4/M7a — there's no DOM
// text field to type into anymore, the whole page is the keyboard).
function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders the screen and an empty stack', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('canvas.screen')).toBeTruthy();
    expect(compiled.querySelector('.stack-values')?.textContent).toContain('(empty)');
  });

  it('typing a line on the keyboard and pressing Enter interprets it', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    // "2 3 SWAP" - avoids needing a shifted key (e.g. '+'), and proves
    // the line actually ran (not just that digits landed on the stack)
    // since the final order only makes sense if SWAP executed.
    for (const code of ['Digit2', 'Space', 'Digit3', 'Space', 'KeyS', 'KeyW', 'KeyA', 'KeyP', 'Enter']) {
      press(code);
    }

    await waitFor(() => (compiled.querySelector('.stack-values')?.textContent ?? '').includes('2 3'));
    fixture.detectChanges();

    expect(compiled.querySelector('.stack-values')?.textContent).toContain('2 3');
  });

  // DEBUGGING.md (M10): the required App-side half of breakpoints —
  // tick() ignores step()'s return value for every other status, but
  // must genuinely stop calling step() once it sees 'breakpoint', or
  // the pause wouldn't outlive a single animation frame. Drives input
  // through app's own remoteChannel (exactly what the real WebMCP
  // `type` tool does — see registerWebMcpTools) rather than synthetic
  // keyboard events: startRepl() has already claimed the one session
  // by the time ngAfterViewInit returns, so machine.interpret()/
  // beginLine() can't be called directly here, and there's no
  // document.modelContext in jsdom to exercise the real debug_* tools
  // through — this reaches into App's private fields to do exactly what
  // they do underneath.
  it('a breakpoint holds the REPL until resumed, matching debug_continue', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const app = fixture.componentInstance as unknown as {
      machine: { setBreakpoint(name: string): void };
      remoteChannel: { push(text: string): void };
      pausedWord: () => string | undefined;
      resumeFromBreakpoint(): void;
    };

    app.remoteChannel.push(': SQUARE DUP * ;\n');
    await waitFor(() => (compiled.querySelector('.dictionary-list')?.textContent ?? '').includes('SQUARE'));

    app.machine.setBreakpoint('SQUARE');
    app.remoteChannel.push('5 SQUARE\n');

    await waitFor(() => app.pausedWord() !== undefined);
    expect(app.pausedWord()).toBe('SQUARE');
    const stackAtPause = compiled.querySelector('.stack-values')?.textContent ?? '';
    expect(stackAtPause).toContain('5');
    expect(stackAtPause).not.toContain('25'); // SQUARE's body hasn't run yet
    expect(compiled.querySelector('.pause-bar')?.textContent ?? '').toContain('paused at SQUARE');

    // Confirm it genuinely holds — not just true for the one frame that
    // set it — across several more animation frames.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.pausedWord()).toBe('SQUARE');
    expect(compiled.querySelector('.stack-values')?.textContent ?? '').not.toContain('25');

    app.resumeFromBreakpoint(); // same effect as debug_continue and the Continue button
    await waitFor(() => (compiled.querySelector('.stack-values')?.textContent ?? '').includes('25'));
    fixture.detectChanges();
    expect(compiled.querySelector('.pause-bar')).toBeFalsy();
  });

  it('clicking a breakable dictionary word arms a breakpoint, shown in the breakpoints section', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const app = fixture.componentInstance as unknown as {
      remoteChannel: { push(text: string): void };
    };

    app.remoteChannel.push(': SQUARE DUP * ;\n');
    await waitFor(() => (compiled.querySelector('.dictionary-list')?.textContent ?? '').includes('SQUARE'));
    fixture.detectChanges();

    const words = Array.from(compiled.querySelectorAll('.inspector-word')) as HTMLElement[];
    const squareEl = words.find((el) => el.textContent?.trim().startsWith('SQUARE'));
    expect(squareEl).toBeTruthy();
    squareEl!.click();

    // The breakpoints section is the first .inspector-section in the
    // template — targeted directly (not via a generic .inspector-word
    // search) since SQUARE, being the most-recently-defined word, would
    // otherwise also match the dictionary section's own entry for it.
    await waitFor(() => (compiled.querySelector('.inspector-section')?.textContent ?? '').includes('SQUARE'));
    fixture.detectChanges();
    const breakpointsSection = compiled.querySelector('.inspector-section');
    expect(breakpointsSection?.textContent ?? '').toContain('breakpoints (1)');
    expect(breakpointsSection?.textContent ?? '').toContain('SQUARE');
  });
});
