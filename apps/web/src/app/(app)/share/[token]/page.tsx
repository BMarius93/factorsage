import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedBacktestReport } from "../../../../features/backtests/sharing/SharedBacktestReport";
import {
  SHARED_BACKTEST_NOT_FOUND_METADATA,
  sharedBacktestMetadata,
} from "../../../../features/backtests/sharing/share-metadata";
import { loadSharedBacktestReport } from "../../../../features/backtests/sharing/shared-backtest-loader";

type SharedBacktestPageProps = {
  readonly params: Promise<{ readonly token: string }>;
};

/** Read per request: a revoked link must stop rendering on the very next one. */
export const dynamic = "force-dynamic";

/**
 * The link preview a crawler reads, from the report's real figures — in the HTML itself, so
 * WhatsApp, Discord, LinkedIn and the rest need no JavaScript to see it.
 */
export async function generateMetadata({
  params,
}: SharedBacktestPageProps): Promise<Metadata> {
  const { token } = await params;
  const report = await loadSharedBacktestReport(token);
  return report
    ? sharedBacktestMetadata(report, token)
    : SHARED_BACKTEST_NOT_FOUND_METADATA;
}

/**
 * A shared backtest's public report (`docs/decisions/backtest-sharing-v1.md`). Thin route
 * boundary: the token is the whole input, the report is read once per request on the server
 * (shared with `generateMetadata`), and an unknown or revoked link is a `404`.
 */
export default async function SharedBacktestPage({
  params,
}: SharedBacktestPageProps) {
  const { token } = await params;
  const report = await loadSharedBacktestReport(token);
  if (!report) {
    notFound();
  }
  return <SharedBacktestReport report={report} />;
}
