"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { stockLogoSrc } from "../../lib/stock-logo";
import { isBrightLogo } from "./logo-brightness";
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
   * The mark this security's contract projects, when it has one.
   *
   * Not what the browser loads: `stockLogoSrc` turns the security into the product's own
   * ticker-keyed logo URL, which is what makes the image cacheable across every surface and
   * samplable on a canvas. See `lib/stock-logo.ts`.
   */
  readonly logoUrl?: string;
  readonly size?: "sm" | "md" | "lg";
  /**
   * `lazy` by default, because most marks are rows in a collection that may never be scrolled to.
   * A prominent above-the-fold mark — the Stock Details identity — passes `eager` so it is not
   * deferred behind a viewport check it has already satisfied.
   */
  readonly loading?: "eager" | "lazy";
};

/**
 * A company mark, or the ticker's initials when there is no usable image.
 *
 * A logo is decoration, never data: the element reserves its box before the image resolves, so a
 * slow or broken logo cannot shift the row it sits in, and a failed load silently falls back to the
 * monogram rather than leaving a broken-image glyph in a table. Always `aria-hidden` — the symbol
 * and company name sit right beside it, and announcing the logo too would read every row twice.
 *
 * Near-white marks — and there are many, because a logo is usually drawn for a dark header — get a
 * dark plate behind them instead of vanishing into the surface. That is measured from the loaded
 * pixels rather than guessed per security, which is only possible because the image is same-origin.
 */
export function StockLogo({
  symbol,
  name,
  logoUrl,
  size = "md",
  loading = "lazy",
}: StockLogoProps) {
  const [failed, setFailed] = useState(false);
  const [bright, setBright] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const src = stockLogoSrc(symbol, logoUrl);

  useEffect(() => {
    // A row recycled onto a different security must not keep the previous one's failure or plate.
    setFailed(false);
    setBright(false);
    // `onLoad` is not enough on its own. A mark already in the HTTP cache can finish decoding
    // before React's listener is attached, and then no load event is ever delivered — which is
    // precisely the repeat-navigation case the long `Cache-Control` creates, so without this the
    // plate would appear on a cold visit and silently vanish on every one after it.
    //
    // The same is true of a miss. The logo endpoint answers a security with no mark with an empty
    // `204` (UX-005), which an image settles as `complete` with no pixels; if that happened before
    // hydration — a cached miss usually does — `onError` never arrives either, and without this the
    // row would keep an empty box instead of the monogram.
    const image = imageRef.current;
    if (image?.complete) {
      if (image.naturalWidth > 0) {
        setBright(isBrightLogo(image));
      } else {
        setFailed(true);
      }
    }
  }, [src]);

  const showImage = src !== undefined && !failed;

  return (
    <span
      className={styles.logo}
      data-size={size}
      data-bright={bright ? "true" : undefined}
      aria-hidden="true"
    >
      {showImage ? (
        // A plain `img`, not `next/image`: the logo endpoint already serves one cacheable,
        // correctly typed asset per ticker, and routing it through the image optimizer would
        // add a second cache and a build-time host allowlist for no gain at 32px.
        <img
          ref={imageRef}
          className={styles.logoImage}
          src={src}
          alt=""
          loading={loading}
          decoding="async"
          onLoad={(event) => setBright(isBrightLogo(event.currentTarget))}
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
  /** Forwarded to the mark; see `StockLogo`. Collections keep the lazy default. */
  readonly loading?: "eager" | "lazy";
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
  loading,
  testId,
}: StockIdentityProps) {
  const subtitle = secondary ?? name;
  const body = (
    <>
      <StockLogo
        symbol={symbol}
        {...(name === undefined ? {} : { name })}
        {...(logoUrl === undefined ? {} : { logoUrl })}
        {...(loading === undefined ? {} : { loading })}
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
