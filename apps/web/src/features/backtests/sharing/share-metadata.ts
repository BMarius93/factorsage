import {
  backtestSharePreviewImagePath,
  type SharedBacktestReportResponse,
} from "@intrinsic/contracts";
import type { Metadata } from "next";
import {
  SHARE_BRAND_NAME,
  sharedBacktestDescription,
  sharedBacktestImageAlt,
  sharedBacktestTitle,
  type SharedBacktestHeadlineInput,
} from "./share-headline";

/** The link-preview image's pixel size: the 1.91:1 card every major platform renders large. */
export const SHARE_PREVIEW_IMAGE_SIZE = { width: 1200, height: 630 } as const;

export function headlineOfReport(
  report: SharedBacktestReportResponse,
): SharedBacktestHeadlineInput {
  const { configuration, result } = report;
  return {
    startDate: configuration.startDate,
    endDate: configuration.endDate,
    benchmarkName: configuration.benchmark.name,
    securityCount: configuration.securityCount,
    strategyRuleCount: configuration.strategyRuleCount,
    portfolioCagrPercent: result.summary.portfolioCagrPercent,
    benchmarkCagrPercent: result.summary.benchmarkCagrPercent,
    portfolioReturnPercent: result.summary.portfolioReturnPercent,
    benchmarkReturnPercent: result.summary.benchmarkReturnPercent,
  };
}

/**
 * Everything a link-unfurling crawler reads: Open Graph, the X/Twitter card and the page title,
 * built from the report's real stored figures.
 *
 * Absolute URLs are taken from the report's own public address, which the API builds from the
 * deployment's web origin exactly as it builds emailed links — never from the request's `Host`.
 *
 * `noindex`: a shared link is something a person was sent, not a page of a public directory.
 * Preview crawlers still read the tags; search engines are asked not to list the page.
 */
export function sharedBacktestMetadata(
  report: SharedBacktestReportResponse,
  token: string,
): Metadata {
  const headline = headlineOfReport(report);
  const title = sharedBacktestTitle(headline);
  const description = sharedBacktestDescription(headline);
  const image = {
    url: new URL(backtestSharePreviewImagePath(token), report.url).toString(),
    width: SHARE_PREVIEW_IMAGE_SIZE.width,
    height: SHARE_PREVIEW_IMAGE_SIZE.height,
    type: "image/png",
    alt: sharedBacktestImageAlt(headline),
  };
  return {
    metadataBase: new URL(report.url),
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      siteName: SHARE_BRAND_NAME,
      url: report.url,
      title,
      description,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: image.url, alt: image.alt }],
    },
  };
}

/** What an unknown or revoked link says about itself: nothing about any backtest. */
export const SHARED_BACKTEST_NOT_FOUND_METADATA: Metadata = {
  title: { absolute: `Shared backtest unavailable | ${SHARE_BRAND_NAME}` },
  robots: { index: false, follow: false },
};
