import {
  matchesEtag,
  previewImageEtag,
  renderPreviewImage,
} from "../../../../../features/backtests/sharing/preview-image";
import { loadSharedBacktestPreview } from "../../../../../features/backtests/sharing/shared-backtest-loader";

/**
 * A shared backtest's link-preview image: a 1200 × 630 PNG at a stable public HTTPS address, named
 * by `og:image` (`docs/decisions/backtest-sharing-v1.md`).
 *
 * Every request asks the API whether the token still resolves, so a revoked link stops producing
 * an image at once. The picture itself is rendered in memory and cached by its content; nothing
 * is stored, and nothing of the image is carried in the link.
 *
 * `public, no-cache` with an `ETag`: any cache may keep the bytes, but must revalidate them here
 * before each use — which is where revocation is enforced — and an unchanged picture revalidates
 * with a `304` and no render. Platforms that already unfurled a link may keep their own copy after
 * a revocation; that copy is outside FactorSage, and the owner is told so when they stop sharing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_HEADERS = {
  "Cache-Control": "public, no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
} as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  const preview = await loadSharedBacktestPreview(token);
  if (!preview) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
  const etag = previewImageEtag(preview);
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: { ...IMAGE_HEADERS, ETag: etag },
    });
  }
  const png = await renderPreviewImage(preview, etag);
  return new Response(png, {
    status: 200,
    headers: {
      ...IMAGE_HEADERS,
      ETag: etag,
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
    },
  });
}
