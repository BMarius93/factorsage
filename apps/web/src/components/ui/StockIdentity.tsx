"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./StockIdentity.module.css";

/** Initials for the monogram fallback: `AAPL` → `AA`, `Apple Inc.` → `AI`. */
export function logoMonogram(symbol: string, name?: string): string {
  const ticker = symbol.trim().toUpperCase();
  if (ticker.length >= 2) {
    return ticker.slice(0, 2);
  }
  if (ticker.length === 1) {
    return ticker;
  }
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }
  return "?";
}

type StockLogoProps = {
  readonly symbol: string;
  readonly name?: string;
  /**
   * Optional company logo. Only `StockDetailsResponse.profile` carries one today; every other
   * surface renders the monogram until the catalog projections expose it.
   */
  readonly logoUrl?: string;
  readonly size?: "sm" | "md" | "lg";
};

/**
 * A company mark, or the ticker's initials when there is no usable image.
 *
 * A logo is decoration, never data: the element reserves its box before the image resolves, so a
 * slow or broken logo cannot shift the row it sits in, and a failed load silently falls back to the
 * monogram rather than leaving a broken-image glyph in a table. Always `aria-hidden` — the symbol
 * and company name sit right beside it, and announcing the logo too would read every row twice.
 */
export function StockLogo({ symbol, name, logoUrl, size = "md" }: StockLogoProps) {
  const [failed, setFailed] = useState(false);

  // A row recycled onto a different security must not keep the previous one's failure.
  useEffect(() => {
    setFailed(false);
  }, [logoUrl]);

  const showImage = Boolean(logoUrl) && !failed;

  return (
    <span className={styles.logo} data-size={size} aria-hidden="true">
      {showImage ? (
        // A plain `img`, not `next/image`: optimising it would require every logo host a
        // provider might return to be allowlisted in `next.config.ts`, which would put a
        // provider concern in the application's build configuration. A 32px decorative
        // mark does not earn that.
        <img
          className={styles.logoImage}
          src={logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        // Rendered as CSS generated content, not a text node: the initials are decoration,
        // so they must not join the row's text — where they would be copied with a
        // selection, matched by find-in-page, and prepended to every symbol.
        <span
          className={styles.monogram}
          data-monogram={logoMonogram(symbol, name)}
        />
      )}
    </span>
  );
}

type StockIdentityProps = {
  readonly symbol: string;
  readonly name?: string;
  readonly logoUrl?: string;
  /** Link to the stock's page. Omit where the row is already a link or the page is unreachable. */
  readonly href?: string;
  /** Secondary line under the symbol; defaults to the company name. */
  readonly secondary?: string;
  readonly size?: "sm" | "md" | "lg";
  readonly testId?: string;
};

/**
 * How a security is identified everywhere in the product: mark, ticker, company name.
 *
 * Search results, list members, monitored stocks, signals and backtest positions all used to write
 * their own symbol/name stack with different weights and different link behaviour. This is the one
 * of them, so a stock looks the same wherever the user meets it.
 */
export function StockIdentity({
  symbol,
  name,
  logoUrl,
  href,
  secondary,
  size = "md",
  testId,
}: StockIdentityProps) {
  const subtitle = secondary ?? name;
  const body = (
    <>
      <StockLogo
        symbol={symbol}
        {...(name === undefined ? {} : { name })}
        {...(logoUrl === undefined ? {} : { logoUrl })}
        size={size}
      />
      <span className={styles.text}>
        <span className={styles.symbol}>{symbol}</span>
        {subtitle ? <span className={styles.name}>{subtitle}</span> : null}
      </span>
    </>
  );

  if (!href) {
    return (
      <span
        className={styles.identity}
        data-size={size}
        {...(testId ? { "data-testid": testId } : {})}
      >
        {body}
      </span>
    );
  }

  return (
    <Link
      className={styles.identity}
      data-size={size}
      data-interactive="true"
      href={href}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {body}
    </Link>
  );
}
