import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import { shouldServeStreamingMetadata } from "next/dist/server/lib/streaming-metadata";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { BLOCKING_METADATA_USER_AGENTS } from "./link-previews";

/**
 * A shared backtest's preview must reach crawlers that read only `<head>`, including ones Next.js
 * does not know about. Asked of Next.js's own decision function, so an upgrade that changes how
 * the setting is read fails here rather than quietly streaming the tags into the body again.
 */
const USER_AGENTS = [
  "WhatsApp/2.23.20.0",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "TelegramBot (like TwitterBot)",
  "Mastodon/4.2.0 (http.rb/5.1.1; +https://mastodon.social/)",
  "curl/8.5.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
];

describe("link-preview metadata", () => {
  it("is resolved into the head for every user agent", () => {
    for (const phase of [PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER]) {
      const configured = nextConfig(phase).htmlLimitedBots;
      expect(configured, phase).toBe(BLOCKING_METADATA_USER_AGENTS);
      for (const userAgent of USER_AGENTS) {
        expect(
          shouldServeStreamingMetadata(userAgent, configured?.source),
          userAgent,
        ).toBe(false);
      }
    }
  });
});
