// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPreviewImageCache } from "../../../../../features/backtests/sharing/preview-image";
import { loadSharedBacktestPreview } from "../../../../../features/backtests/sharing/shared-backtest-loader";
import {
  TEST_SHARE_TOKEN,
  testSharedPreview,
} from "../../../../../features/backtests/sharing/shared-backtest.test-helper";
import { GET } from "./route";

vi.mock(
  "../../../../../features/backtests/sharing/shared-backtest-loader",
  () => ({ loadSharedBacktestPreview: vi.fn() }),
);

const loadMock = vi.mocked(loadSharedBacktestPreview);

function call(headers: Record<string, string> = {}): Promise<Response> {
  return GET(
    new Request(`http://localhost/share/${TEST_SHARE_TOKEN}/preview.png`, {
      headers,
    }),
    { params: Promise.resolve({ token: TEST_SHARE_TOKEN }) },
  );
}

/** Width and height from a PNG's IHDR chunk, which always follows the 8-byte signature. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

beforeEach(() => {
  loadMock.mockReset();
  clearPreviewImageCache();
});

describe("GET /share/{token}/preview.png", () => {
  it("renders a 1200 × 630 PNG from the shared run's preview data", async () => {
    loadMock.mockResolvedValue(testSharedPreview());
    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, no-cache");
    expect(response.headers.get("etag")).toMatch(/^"[A-Za-z0-9_-]{32}"$/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 630 });
    expect(Number(response.headers.get("content-length"))).toBe(bytes.length);
    expect(loadMock).toHaveBeenCalledWith(TEST_SHARE_TOKEN);
  }, 60_000);

  it("revalidates an unchanged picture with a 304 — still asking whether the link lives", async () => {
    loadMock.mockResolvedValue(testSharedPreview());
    const first = await call();
    const etag = first.headers.get("etag") as string;

    const revalidated = await call({ "If-None-Match": etag });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect(loadMock).toHaveBeenCalledTimes(2);
  }, 60_000);

  it("draws a different picture, under a different validator, for different data", async () => {
    loadMock.mockResolvedValueOnce(testSharedPreview());
    const first = await call();
    loadMock.mockResolvedValueOnce(
      testSharedPreview({
        headline: { ...testSharedPreview().headline, portfolioCagrPercent: 2 },
      }),
    );
    const second = await call({
      "If-None-Match": first.headers.get("etag") as string,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
  }, 60_000);

  it("renders a run that has no curve to draw", async () => {
    loadMock.mockResolvedValue(testSharedPreview({ series: [] }));
    const response = await call();
    expect(response.status).toBe(200);
    expect(pngSize(new Uint8Array(await response.arrayBuffer()))).toEqual({
      width: 1200,
      height: 630,
    });
  }, 60_000);

  it("answers 404 and renders nothing once the link is unknown or revoked", async () => {
    loadMock.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).not.toContain("image");
  });

  it("refuses a revoked link even when the client holds the picture's validator", async () => {
    loadMock.mockResolvedValueOnce(testSharedPreview());
    const etag = (await call()).headers.get("etag") as string;
    loadMock.mockResolvedValueOnce(null);
    expect((await call({ "If-None-Match": etag })).status).toBe(404);
  }, 60_000);
});
