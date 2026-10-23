import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SharedBacktestPreviewResponse } from "@intrinsic/contracts";
import { ImageResponse } from "next/og";
import {
  PREVIEW_CARD_HEIGHT,
  PREVIEW_CARD_WIDTH,
  PreviewCard,
} from "./PreviewCard";

/**
 * Renders a shared backtest's link-preview PNG, and keeps the result in memory.
 *
 * The bytes are generated on demand from the preview data and never stored anywhere durable: not
 * in PostgreSQL, not in Redis, not in object storage, not in the link. What is cached is keyed by
 * a digest of the **data drawn plus the card's design version**, never by the token, so:
 *
 * - a cache hit still required the token to resolve — the route asks the API on every request,
 *   and a revoked link is answered `404` before this module is reached;
 * - the same run re-shared under a new token reuses the picture it already has;
 * - a design change bumps `PREVIEW_DESIGN_VERSION` and every cached picture is redrawn.
 *
 * The cache is a small process-local LRU. Losing it costs one re-render; it is never the source of
 * anything. The digest is also the image's HTTP `ETag`, so a client revalidating an unchanged
 * picture is answered `304` without a render.
 */

/** Bump when the card's layout, palette or typeface changes. */
export const PREVIEW_DESIGN_VERSION = "1";

/** Enough for a burst of shared links being unfurled at once; ~60 KB each. */
const CACHE_LIMIT = 64;

const rendered = new Map<string, ArrayBuffer>();

type Assets = {
  readonly regular: Buffer;
  readonly semibold: Buffer;
  readonly logo: string;
};

let assets: Promise<Assets> | null = null;

/**
 * The product's typeface and wordmark, read once per process.
 *
 * Paths are resolved from the web app's own directory — where `next dev`, `next build` and
 * `next start` all run — because the renderer can fetch nothing over the network.
 */
function loadAssets(): Promise<Assets> {
  assets ??= (async () => {
    const root = process.cwd();
    const fonts = join(
      root,
      "node_modules",
      "geist",
      "dist",
      "fonts",
      "geist-sans",
    );
    const [regular, semibold, logo] = await Promise.all([
      readFile(join(fonts, "Geist-Regular.ttf")),
      readFile(join(fonts, "Geist-SemiBold.ttf")),
      readFile(
        join(
          root,
          "public",
          "images",
          "logo",
          "FactorSage-logo-transparent.png",
        ),
      ),
    ]);
    return {
      regular,
      semibold,
      logo: `data:image/png;base64,${logo.toString("base64")}`,
    };
  })().catch((error: unknown) => {
    // A failed read must not poison every later request.
    assets = null;
    throw error;
  });
  return assets;
}

/** A strong validator for one picture: the design version and the exact data drawn. */
export function previewImageEtag(
  preview: SharedBacktestPreviewResponse,
): string {
  const digest = createHash("sha256")
    .update(PREVIEW_DESIGN_VERSION)
    .update("\n")
    .update(JSON.stringify(preview))
    .digest("base64url")
    .slice(0, 32);
  return `"${digest}"`;
}

/** Whether an `If-None-Match` header already names this picture. */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) {
    return false;
  }
  return header
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//, ""))
    .some((candidate) => candidate === etag || candidate === "*");
}

/** The PNG for one preview, from the cache when this exact picture was drawn before. */
export async function renderPreviewImage(
  preview: SharedBacktestPreviewResponse,
  etag: string = previewImageEtag(preview),
): Promise<ArrayBuffer> {
  const cached = rendered.get(etag);
  if (cached) {
    // Most recently used goes to the back.
    rendered.delete(etag);
    rendered.set(etag, cached);
    return cached;
  }
  const { regular, semibold, logo } = await loadAssets();
  const image = new ImageResponse(
    <PreviewCard preview={preview} logoSrc={logo} />,
    {
      width: PREVIEW_CARD_WIDTH,
      height: PREVIEW_CARD_HEIGHT,
      fonts: [
        { name: "Geist", data: regular, weight: 400, style: "normal" },
        { name: "Geist", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
  const bytes = await image.arrayBuffer();
  rendered.set(etag, bytes);
  while (rendered.size > CACHE_LIMIT) {
    const oldest = rendered.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    rendered.delete(oldest);
  }
  return bytes;
}

/** For tests: forget every picture. */
export function clearPreviewImageCache(): void {
  rendered.clear();
}
