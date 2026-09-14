import { afterEach, describe, expect, it, vi } from "vitest";
import { isBrightLogo } from "./logo-brightness";

/**
 * jsdom has no canvas implementation, so the pixels the sampler reads are supplied here. That is
 * the whole surface under test: the averaging rule and what it does when it cannot know.
 */
function withCanvas(
  context: Partial<CanvasRenderingContext2D> | null,
): HTMLImageElement {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as CanvasRenderingContext2D | null,
  );
  return document.createElement("img");
}

/** One RGBA pixel repeated across the 16×16 sample grid. */
function pixels(
  r: number,
  g: number,
  b: number,
  a = 255,
): Partial<CanvasRenderingContext2D> {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = a;
  }
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data }) as ImageData),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isBrightLogo", () => {
  it("reports a white mark, which would otherwise vanish on a white surface", () => {
    expect(isBrightLogo(withCanvas(pixels(255, 255, 255)))).toBe(true);
  });

  it("leaves a dark mark alone", () => {
    expect(isBrightLogo(withCanvas(pixels(20, 24, 31)))).toBe(false);
  });

  it("leaves a merely light mark alone", () => {
    // A pale brand colour still reads on the surface; only near-white needs the plate.
    expect(isBrightLogo(withCanvas(pixels(200, 214, 240)))).toBe(false);
  });

  it("ignores the transparent plate almost every mark ships on", () => {
    // White pixels at alpha 0 are the background of a dark logo, not the logo.
    expect(isBrightLogo(withCanvas(pixels(255, 255, 255, 0)))).toBe(false);
  });

  it("stays false when there is no context to sample", () => {
    expect(isBrightLogo(withCanvas(null))).toBe(false);
  });

  it("stays false when the canvas is tainted", () => {
    // What a cross-origin image does. The same-origin logo endpoint exists to avoid it, and the
    // wrong answer here must be "leave it on the ordinary surface", never a plate under a dark mark.
    expect(
      isBrightLogo(
        withCanvas({
          drawImage: vi.fn(),
          getImageData: vi.fn(() => {
            throw new Error("SecurityError: tainted canvas");
          }),
        }),
      ),
    ).toBe(false);
  });
});
