import type { Page } from "@playwright/test";

/**
 * Everything a page did wrong while a test watched it (E2E-006: the one shared watcher).
 *
 * - `consoleErrors`: every `console.error` the page logged, including the browser's own
 *   "Failed to load resource" lines and React hydration warnings.
 * - `pageErrors`: uncaught exceptions and unhandled rejections.
 * - `failedRequests`: requests that failed at the network layer, and responses with a status of
 *   400 or more.
 *
 * Assert all three are empty. Nothing is filtered by URL, host or message — the shared logo stub
 * in `fixtures.ts` answers logos with the product's real `204` miss, so a logo cannot excuse an
 * error, and a real `404` anywhere still fails the test. The single exception is a request the
 * page itself **aborted** (`net::ERR_ABORTED`): every history read is abortable and a remount
 * cancels the superseded one on purpose, so a cancellation is not a failure.
 */
export type PageIssues = {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
};

export function watchForIssues(page: Page): PageIssues {
  const issues: PageIssues = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error") {
      issues.consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    issues.pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText === "net::ERR_ABORTED") {
      return;
    }
    issues.failedRequests.push(
      `${request.method()} ${request.url()} (${request.failure()?.errorText ?? "failed"})`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      issues.failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });
  return issues;
}
