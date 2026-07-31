import { TestBed } from '@angular/core/testing';
import { App } from './app';

// M7: a submitted line is now driven by a requestAnimationFrame pump
// rather than finishing synchronously inside submit() — poll for the
// expected DOM state instead of asserting immediately after dispatch.
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition never became true');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it('renders the REPL prompt and an empty stack', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.log')?.textContent).toContain('Rebel-Sim');
    expect(compiled.querySelector('.stack-values')?.textContent).toContain('(empty)');
  });

  it('interprets a line typed into the input on submit', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    const input = compiled.querySelector('input') as HTMLInputElement;
    const form = compiled.querySelector('form') as HTMLFormElement;

    // M3: printed output (from `.`) now lands on the canvas via the
    // screen HAL, not in the log pane — leave a value on the stack
    // instead of printing it, so this test can verify success without
    // depending on canvas rendering (unavailable in jsdom).
    input.value = '2 3 +';
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(compiled.querySelector('.log')?.textContent).toContain('> 2 3 +');

    await waitFor(() => (compiled.querySelector('.stack-values')?.textContent ?? '').includes('5'));
    fixture.detectChanges();

    expect(compiled.querySelector('.log')?.textContent).not.toContain('!');
    expect(compiled.querySelector('.stack-values')?.textContent).toContain('5');
  });
});
