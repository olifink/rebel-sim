import { computePresentationSize } from './canvas-presenter.js';

describe('computePresentationSize', () => {
  it('picks a clean 2x at devicePixelRatio 1, matching the old hardcoded behavior', () => {
    const size = computePresentationSize(320, 240, 640, 1);
    expect(size).toEqual({ backingWidth: 640, backingHeight: 480, cssWidth: 640, cssHeight: 480, scale: 2 });
  });

  it('always yields a backing size that is an exact framebuffer multiple', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      const size = computePresentationSize(320, 240, 640, dpr);
      expect(size.backingWidth % 320).toBe(0);
      expect(size.backingHeight % 240).toBe(0);
      expect(size.backingWidth / 320).toBe(size.scale);
    }
  });

  it('always yields a CSS size whose device-pixel footprint exactly equals the backing size (no fractional scaling left for the browser to do)', () => {
    for (const dpr of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      const size = computePresentationSize(320, 240, 640, dpr);
      expect(size.cssWidth * dpr).toBeCloseTo(size.backingWidth, 6);
      expect(size.cssHeight * dpr).toBeCloseTo(size.backingHeight, 6);
    }
  });

  it('never picks a scale below 1x even if the target is tiny', () => {
    const size = computePresentationSize(320, 240, 10, 1);
    expect(size.scale).toBeGreaterThanOrEqual(1);
  });

  it('falls back to devicePixelRatio 1 for a non-positive value', () => {
    const size = computePresentationSize(320, 240, 640, 0);
    expect(size).toEqual(computePresentationSize(320, 240, 640, 1));
  });
});
