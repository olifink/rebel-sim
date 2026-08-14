import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { App } from './app';

// DEVELOPING.md §6: App.loadSystemVocabulary() fetches public/system.fth
// at startup — jsdom/vitest has no real dev server behind it (a bare
// relative fetch('system.fth') throws "Invalid URL" with no document
// base to resolve against), so every test needs a stubbed fetch. Reads
// the real file from disk rather than a canned string, so a test
// failure here means the actual shipped file broke, not a stale fixture.
const __dirname = dirname(fileURLToPath(import.meta.url));
const systemFthText = readFileSync(join(__dirname, '../../public/system.fth'), 'utf-8');

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

// Pushes `text` into the app's RemoteChannel *and* restarts the pump —
// the real WebMCP `type` tool handler always does both together
// (app.ts: `remoteChannel.push(text); this.wake();`), since a frame
// that finds step() blocked with nothing else changed lets the
// requestAnimationFrame chain die rather than polling forever at idle
// (app.ts's own tick() comment). Calling push() alone, as this file's
// tests used to, works only by accident — while the pump happens to
// still be alive from a previous push — and silently does nothing once
// it's died out in between two pushes. `wake` is private on App, hence
// the same "reach into private fields via unknown" cast every other
// helper here already uses.
function typeIntoRepl(app: { remoteChannel: { push(text: string): void } }, text: string): void {
  app.remoteChannel.push(text);
  (app as unknown as { wake(): void }).wake();
}

describe('App', () => {
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(systemFthText, { status: 200 })),
    );
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

    typeIntoRepl(app, ': SQUARE DUP * ;\n');
    await waitFor(() => (compiled.querySelector('.dictionary-list')?.textContent ?? '').includes('SQUARE'));

    app.machine.setBreakpoint('SQUARE');
    typeIntoRepl(app, '5 SQUARE\n');

    await waitFor(() => app.pausedWord() !== undefined);
    // pausedWord() is a raw signal read, unlike every other waitFor() in
    // this file (which poll rendered .textContent directly) — it can
    // resolve before Angular's zone-triggered change detection has
    // actually flushed the DOM. detectChanges() here makes that explicit
    // rather than relying on incidental timing (M43: larger, less-frequent
    // tick() calls under the self-hosted interpreter's own step-budget
    // needs removed the lucky window that used to paper over this).
    fixture.detectChanges();
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

    typeIntoRepl(app, ': SQUARE DUP * ;\n');
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

  // Web-only monitor-panel sugar (dictionary.ts's getPrimitiveNote,
  // app.ts's wordTooltip): a primitive with a rebel-opcodes.json `note`
  // shows it as the hover tooltip instead of the breakpoint hint; a
  // primitive with no recorded note, and any user-defined word (which
  // never has one), keep the original breakpoint-oriented text.
  it('the dictionary hover tooltip shows a primitive\'s note when it has one, falling back to the breakpoint hint otherwise', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const app = fixture.componentInstance as unknown as {
      remoteChannel: { push(text: string): void };
    };

    typeIntoRepl(app, ': SQUARE DUP * ;\n');
    await waitFor(() => (compiled.querySelector('.dictionary-list')?.textContent ?? '').includes('SQUARE'));
    fixture.detectChanges();

    const words = Array.from(compiled.querySelectorAll('.dictionary-list .inspector-word')) as HTMLElement[];
    const titleOf = (name: string) =>
      words.find((el) => el.textContent?.trim().replace('*', '') === name)?.title;

    expect(titleOf('ABORT')).toContain('DEVELOPING.md');
    expect(titleOf('DUP')).toBe('no compiled body to break on');
    expect(titleOf('SQUARE')).toBe('click to toggle a breakpoint');
  });

  it('WARM clears the stack but leaves the dictionary untouched', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const app = fixture.componentInstance as unknown as {
      remoteChannel: { push(text: string): void };
    };

    typeIntoRepl(app, ': SQUARE DUP * ;\n');
    await waitFor(() => (compiled.querySelector('.dictionary-list')?.textContent ?? '').includes('SQUARE'));

    typeIntoRepl(app, '1 2 3 WARM\n');
    await waitFor(() => (compiled.querySelector('.stack-values')?.textContent ?? '').includes('(empty)'));
    fixture.detectChanges();

    expect(compiled.querySelector('.stack-values')?.textContent).toContain('(empty)');
    expect(compiled.querySelector('.dictionary-list')?.textContent ?? '').toContain('SQUARE');
  });

  // COLD (rebel-opcodes.json 132): the engine only signals — this proves
  // the *host* side actually reacts, reconstructing this.machine from
  // scratch (app.ts's tick()/performBoot()), the same way a real page
  // reload would. Defining SQUARE and then confirming it's gone (rather
  // than just checking the stack) is the part that specifically proves a
  // whole new Machine replaced the old one, not just a stack clear.
  //
  // Explicit 10s test timeout (vitest's own, third `it()` argument, not
  // waitFor's): the COLD waitFor below already allows up to 4s on its
  // own, which alone was flush against vitest's 5s *default* test
  // timeout, no room left for anything else in this test — a pre-existing
  // near-miss independent of M43, just margin worth widening while
  // touching this test at all.
  it('COLD reconstructs the Machine — the dictionary resets to boot + system.fth vocabulary', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const app = fixture.componentInstance as unknown as {
      remoteChannel: { push(text: string): void };
    };

    typeIntoRepl(app, ': SQUARE DUP * ;\n');
    await waitFor(() => (compiled.querySelector('.dictionary-list')?.textContent ?? '').includes('SQUARE'));

    typeIntoRepl(app, 'COLD\n');
    await waitFor(() => !(compiled.querySelector('.dictionary-list')?.textContent ?? '').includes('SQUARE'), 4000);
    fixture.detectChanges();

    expect(compiled.querySelector('.dictionary-list')?.textContent ?? '').not.toContain('SQUARE');
    // The fresh boot's own vocabulary (system.fth defines WORDS) is
    // present — confirms a real reboot happened, not just a wipe.
    expect(compiled.querySelector('.dictionary-list')?.textContent ?? '').toContain('WORDS');
  }, 10_000);

  it('the left-side sysvars panel lists live FORTH.STATE/.BASE values and updates as they change', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const app = fixture.componentInstance as unknown as {
      remoteChannel: { push(text: string): void };
    };

    await waitFor(() => (compiled.querySelector('.sysvar-table')?.textContent ?? '').includes('BASE'));
    expect(compiled.querySelector('.sysvar-table')?.textContent ?? '').toContain('STATE');

    typeIntoRepl(app, '16 BASE !\n');
    await waitFor(() => {
      const row = Array.from(compiled.querySelectorAll('.sysvar-table tr')).find((tr) =>
        tr.textContent?.includes('BASE'),
      );
      return row?.textContent?.trim().endsWith('16') ?? false;
    });
  });
});
