/**
 * Which user agents receive page metadata in the document `<head>`, resolved before streaming.
 *
 * Next.js streams `generateMetadata` output into the body for most user agents and blocks only for
 * the crawlers on its own list. A link-preview crawler that reads only `<head>` and is not on that
 * list — Telegram's, Mastodon's, a corporate chat's, the next one — would then see a shared
 * backtest with no title, description or image (`docs/decisions/backtest-sharing-v1.md`). Every
 * user agent is therefore served blocking metadata.
 *
 * The cost is nil everywhere else: every other route's metadata is static or synchronous, and the
 * one route with a remote read, `/share/{token}`, needs the same read to render its body anyway.
 *
 * Imported by `next.config.ts`, so it depends on nothing but the language.
 */
export const BLOCKING_METADATA_USER_AGENTS = /.*/;
