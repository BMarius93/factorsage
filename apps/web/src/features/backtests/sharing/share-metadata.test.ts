import { describe, expect, it } from "vitest";
import { sharedBacktestMetadata } from "./share-metadata";
import {
  TEST_SHARE_TOKEN,
  TEST_SHARE_URL,
  testSharedReport,
} from "./shared-backtest.test-helper";

describe("sharedBacktestMetadata", () => {
  const report = testSharedReport();
  const metadata = sharedBacktestMetadata(report, TEST_SHARE_TOKEN);

  it("builds Open Graph and X card tags from the report's real figures", () => {
    const title = "6.3% Annualized vs 3.9% Total Market Index | FactorSage";
    const description = "5-year backtest · 750 securities · 12 strategy rules";
    expect(metadata.title).toEqual({ absolute: title });
    expect(metadata.description).toBe(description);
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "FactorSage",
      url: TEST_SHARE_URL,
      title,
      description,
      images: [
        {
          url: `${TEST_SHARE_URL}/preview.png`,
          width: 1200,
          height: 630,
          type: "image/png",
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title,
      description,
      images: [{ url: `${TEST_SHARE_URL}/preview.png` }],
    });
  });

  it("takes every absolute address from the report's own public URL", () => {
    expect(String(metadata.metadataBase)).toBe(`${TEST_SHARE_URL}`);
  });

  it("asks search engines not to list a link somebody was sent", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("says nothing private, whatever the report carried", () => {
    const serialized = JSON.stringify(metadata);
    for (const forbidden of [
      "Deep value",
      "Quality compounders",
      "strategy-1",
      "list-1",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
