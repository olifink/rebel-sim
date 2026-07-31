/**
 * Fixes a real rendering bug, not a font bug: the low-res framebuffer
 * (320x240, one canvas pixel per Screen pixel — see CanvasScreenHal) was
 * being displayed by fixing the visible <canvas>'s backing-store
 * resolution at 320x240 and stretching it to a hardcoded 640x480 via
 * CSS. That's only a clean, uniform upscale when the browser's
 * `devicePixelRatio` happens to be an integer — at any fractional DPR
 * (Windows 125%/150% scaling, some Linux fractional-scaling setups, all
 * common), the actual device-pixel upscale factor becomes
 * `2 * devicePixelRatio`, which isn't a whole number, so different
 * source pixels land on different numbers of physical pixels: some
 * columns of an identical glyph render one physical pixel wide, others
 * two, wide even though the underlying framebuffer is completely
 * correct.
 *
 * The fix (the standard "crisp canvas at any DPR" pattern): compute the
 * visible canvas's *backing store* resolution as an exact integer
 * multiple of the true framebuffer size, chosen so that multiple times
 * devicePixelRatio lands as close as possible to a target on-screen
 * size — then set its CSS size from that backing resolution divided by
 * devicePixelRatio. The browser then never needs to scale the canvas at
 * all (backing-store pixel count already equals the physical pixel
 * footprint), and the framebuffer -> backing-store upscale happens once,
 * deterministically, inside `drawImage` with smoothing disabled.
 */

export interface PresentationSize {
  /** Visible <canvas> backing-store resolution (its width/height
   * attributes), always framebuffer size * scale. */
  backingWidth: number;
  backingHeight: number;
  /** Visible <canvas> CSS size, chosen so backingSize / devicePixelRatio
   * lands here — the browser renders it 1:1 against physical pixels. */
  cssWidth: number;
  cssHeight: number;
  /** The integer nearest-neighbor multiple actually used. */
  scale: number;
}

export function computePresentationSize(
  framebufferWidth: number,
  framebufferHeight: number,
  targetCssWidth: number,
  devicePixelRatio: number,
): PresentationSize {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const targetDeviceWidth = targetCssWidth * dpr;
  const scale = Math.max(1, Math.round(targetDeviceWidth / framebufferWidth));

  const backingWidth = framebufferWidth * scale;
  const backingHeight = framebufferHeight * scale;

  return {
    backingWidth,
    backingHeight,
    cssWidth: backingWidth / dpr,
    cssHeight: backingHeight / dpr,
    scale,
  };
}
