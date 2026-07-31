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
});
