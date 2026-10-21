import type { ReactNode } from "react";

/**
 * What a Market watch row's mark depicts: the kind of market the fund tracks, never the fund's own
 * logo. Twenty provider logos would be twenty image requests and twenty visual languages; one small
 * set of local line icons is neither, and says more — a bolt reads "utilities" faster than a
 * fund family's emblem.
 */
export type MarketIconKind =
  | "index"
  | "technology"
  | "financials"
  | "energy"
  | "healthcare"
  | "industrials"
  | "consumer-discretionary"
  | "consumer-staples"
  | "utilities"
  | "materials"
  | "real-estate"
  | "communications"
  | "gold"
  | "oil"
  | "bonds"
  | "market";

/**
 * Which mark each fund wears, by the ticker the API displays.
 *
 * Presentation only: the funds, their names, groups and order all come from the API
 * (`GET /market-overview`), and nothing here decides which funds exist. A ticker this table does
 * not know still renders, with the neutral `market` mark.
 */
const ICON_BY_TICKER: Readonly<Record<string, MarketIconKind>> = {
  SPY: "index",
  QQQ: "index",
  DIA: "index",
  IWM: "index",
  RSP: "index",
  XLK: "technology",
  XLF: "financials",
  XLE: "energy",
  XLV: "healthcare",
  XLI: "industrials",
  XLY: "consumer-discretionary",
  XLP: "consumer-staples",
  XLU: "utilities",
  XLB: "materials",
  XLRE: "real-estate",
  XLC: "communications",
  GLD: "gold",
  USO: "oil",
  TLT: "bonds",
  HYG: "bonds",
};

export function marketIconKind(ticker: string): MarketIconKind {
  return ICON_BY_TICKER[ticker] ?? "market";
}

/** 24-unit line drawings in the navigation icons' stroke language (`nav-icons.tsx`). */
const GLYPHS: Record<MarketIconKind, ReactNode> = {
  // Two candles: a broad equity index.
  index: (
    <>
      <path d="M8 3.5v3.5M8 15v5.5M16 3.5v6.5M16 17v3.5" />
      <rect x="6" y="7" width="4" height="8" rx="1" />
      <rect x="14" y="10" width="4" height="7" rx="1" />
    </>
  ),
  technology: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5" />
    </>
  ),
  financials: (
    <>
      <path d="M3.5 9 12 4l8.5 5" />
      <path d="M6 10.5v6.5M10 10.5v6.5M14 10.5v6.5M18 10.5v6.5" />
      <path d="M4 20h16" />
    </>
  ),
  energy: (
    <path d="M12 3.5c.7 3 4.8 5 4.8 9.6a4.8 4.8 0 0 1-9.6 0c0-2.3 1.2-3.6 2.2-4.8.3 1.5 1 2.5 2 3C11.3 8.8 11.2 6 12 3.5z" />
  ),
  healthcare: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  industrials: (
    <>
      <path d="M3.5 20h17" />
      <path d="M4.5 20v-8.5l5 3v-3l5 3V5.5h4.5V20" />
    </>
  ),
  "consumer-discretionary": (
    <>
      <path d="M5.5 8.5h13l-1 11.5h-11z" />
      <path d="M9 8.5V7a3 3 0 0 1 6 0v1.5" />
    </>
  ),
  "consumer-staples": (
    <>
      <path d="M3.5 4.5h2l2 10h9.5l2-7H6.5" />
      <circle cx="9" cy="18.5" r="1.4" />
      <circle cx="16" cy="18.5" r="1.4" />
    </>
  ),
  utilities: <path d="M13 3.5 5.5 13.5H11l-1 7 7.5-10H12z" />,
  materials: (
    <>
      <path d="M12 3.5 19.5 7.5v9L12 20.5l-7.5-4v-9z" />
      <path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9" />
    </>
  ),
  "real-estate": (
    <>
      <rect x="5.5" y="3.5" width="13" height="17" rx="1" />
      <path d="M9 7.5h2M13 7.5h2M9 11h2M13 11h2M9 14.5h2M13 14.5h2M10.5 20.5V18h3v2.5" />
    </>
  ),
  communications: (
    <>
      <circle cx="12" cy="9.5" r="1.6" />
      <path d="M8.7 6.2a4.7 4.7 0 0 0 0 6.6M15.3 6.2a4.7 4.7 0 0 1 0 6.6M6 3.5a8.5 8.5 0 0 0 0 12M18 3.5a8.5 8.5 0 0 1 0 12M12 11.1v9.4" />
    </>
  ),
  // Three ingots.
  gold: (
    <path d="M3.5 19.5 5 15h6l1.5 4.5zM11.5 19.5 13 15h6l1.5 4.5zM7.5 13.5 9 9h6l1.5 4.5z" />
  ),
  oil: <path d="M12 3.5s6 6.3 6 10.5a6 6 0 0 1-12 0c0-4.2 6-10.5 6-10.5z" />,
  // A certificate: a bond is a dated promise on paper.
  bonds: (
    <>
      <path d="M6 3.5h9l3 3v14H6z" />
      <path d="M9 10h6M9 13.5h6M9 17h3.5" />
    </>
  ),
  market: (
    <>
      <path d="M4 20h16" />
      <path d="M7.5 16v-5M12 16V7M16.5 16v-7" />
    </>
  ),
};

/**
 * A fund's mark: a small line icon for the market it tracks.
 *
 * Decorative — the ticker and the market's name beside it are what a reader and a screen reader
 * read — so it is hidden from assistive technology and never focusable. Its size comes from the
 * class it is given.
 */
export function MarketIcon({
  ticker,
  className,
}: {
  readonly ticker: string;
  readonly className?: string;
}) {
  const kind = marketIconKind(ticker);
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={kind}
    >
      {GLYPHS[kind]}
    </svg>
  );
}
