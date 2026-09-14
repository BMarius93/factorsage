/**
 * Perceived brightness above which a mark needs a dark plate behind it to stay visible.
 *
 * Calibrated against the product's surfaces rather than against pure white: a logo drawn in a very
 * light grey is already unreadable on `--color-surface`, so the threshold sits below 255 by a
 * comfortable margin. Marks that are merely light — a pale blue, a light orange — stay well under
 * it and keep the ordinary surface.
 */
const BRIGHT_THRESHOLD = 220;

/** Ignore pixels this transparent. A mark on a transparent plate is mostly empty pixels. */
const OPAQUE_ALPHA = 10;

/** Sampling grid. Sixteen squared is 256 pixels — plenty for an average, and free to draw. */
const SAMPLE_SIZE = 16;

/**
 * Whether a loaded logo is so close to white that it would disappear on a light surface.
 *
 * Draws the image into a small offscreen canvas and averages the ITU-R BT.601 perceived brightness
 * of its opaque pixels. Transparent pixels are skipped: almost every company mark ships on a
 * transparent plate, and counting those would report every logo as whatever the canvas cleared to.
 *
 * Returns `false` whenever it cannot know — no 2D context (jsdom, a blocked canvas), a
 * cross-origin image that tainted the canvas, a zero-size draw. A wrong `false` renders the mark
 * on the ordinary surface, which is how every logo rendered before this existed; a wrong `true`
 * would put a black plate behind a dark logo, which is worse.
 */
export function isBrightLogo(
  image: HTMLImageElement,
  threshold: number = BRIGHT_THRESHOLD,
): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const context = canvas.getContext("2d");
    if (!context) {
      return false;
    }
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    // Throws a SecurityError on a tainted canvas, which is exactly the cross-origin case the
    // same-origin logo endpoint exists to avoid — and the reason this is inside the try.
    const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

    let total = 0;
    let counted = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if ((data[offset + 3] ?? 0) < OPAQUE_ALPHA) {
        continue;
      }
      total +=
        0.299 * (data[offset] ?? 0) +
        0.587 * (data[offset + 1] ?? 0) +
        0.114 * (data[offset + 2] ?? 0);
      counted += 1;
    }
    return counted > 0 && total / counted > threshold;
  } catch {
    return false;
  }
}
