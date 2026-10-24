import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

/**
 * Browser journeys for the interactive-load benchmark (`docs/production/benchmarks.md`,
 * "Interactive load"): real page loads in Chromium while backtests execute, measured with the
 * browser's own Performance APIs.
 *
 * ```bash
 * LOAD_TEST_PASSWORD=… pnpm --filter @intrinsic/web exec tsx load-test/browser-journeys.ts \
 *   --web-url http://127.0.0.1:3100 --users 3 --rounds 3 --label "during H"
 * ```
 *
 * Each browser user signs in as `load-user-NNN` (created by `load:interactive setup`) through the
 * real sign-in page, then visits the pages a session moves through — dashboard, a stock, strategies,
 * lists, backtest history, a completed run, monitors, pricing, billing — and records per page:
 * time to first byte, DOM content loaded, load, largest contentful paint, the time until the page's
 * main landmark is visible, and the count and total of long tasks (> 50 ms) while it settled.
 * The password is read from the environment of this process only and never written anywhere.
 */

type Arguments = {
  webUrl: string;
  users: number;
  rounds: number;
  label: string;
  report: string;
};

function parseArguments(argv: readonly string[]): Arguments {
  const parsed: Arguments = {
    webUrl: "http://127.0.0.1:3100",
    users: 3,
    rounds: 3,
    label: "",
    report: "../../docs/production/benchmark-results/browser-journeys.jsonl",
  };
  const rest = argv.filter((value) => value !== "--");
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    if (flag === "--web-url") parsed.webUrl = value.replace(/\/$/, "");
    else if (flag === "--users") parsed.users = Number(value);
    else if (flag === "--rounds") parsed.rounds = Number(value);
    else if (flag === "--label") parsed.label = value;
    else if (flag === "--report") parsed.report = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  return parsed;
}

type PageSample = {
  page: string;
  ttfbMs: number;
  domContentLoadedMs: number;
  loadMs: number;
  lcpMs: number | null;
  readyMs: number;
  longTasks: number;
  longTaskMs: number;
  /** The slowest input event's duration while typing in the stock search (Event Timing API). */
  interactionMs: number | null;
  timedOut: boolean;
  ok: boolean;
};

const INIT_SCRIPT = `
  window.__longTasks = [];
  window.__lcp = null;
  window.__events = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__lcp = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__events.push(entry.duration);
    }).observe({ type: "event", durationThreshold: 16, buffered: true });
  } catch (error) {}
`;

async function measure(
  page: Page,
  name: string,
  url: string,
  interact = false,
): Promise<PageSample> {
  const startedAt = Date.now();
  let ok = true;
  let timedOut = false;
  try {
    const response = await page.goto(url, {
      waitUntil: "load",
      timeout: 60_000,
    });
    ok = response !== null && response.status() < 400;
    await page
      .locator("main")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    // Let data requests started on mount settle, as a person waits for the page to fill.
    await page
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() => {});
  } catch (error) {
    ok = false;
    timedOut = error instanceof Error && error.name === "TimeoutError";
  }
  const readyMs = Date.now() - startedAt;
  let interactionMs: number | null = null;
  if (interact && ok) {
    // A person typing a ticker into the stock search: the slowest input event is the page's
    // responsiveness under load (an INP-style measure).
    const search = page
      .getByRole("combobox")
      .or(page.getByRole("searchbox"))
      .first();
    if (await search.isVisible().catch(() => false)) {
      await page.evaluate(() => {
        (window as unknown as { __events: number[] }).__events = [];
      });
      await search.click();
      await search.pressSequentially("SYN07", { delay: 80 });
      await page.waitForTimeout(500);
      interactionMs = await page.evaluate(() =>
        Math.round(
          Math.max(
            0,
            ...((window as unknown as { __events?: number[] }).__events ?? []),
          ),
        ),
      );
      await search.fill("");
    }
  }
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined;
    const tasks =
      (window as unknown as { __longTasks?: number[] }).__longTasks ?? [];
    return {
      ttfb: navigation
        ? navigation.responseStart - navigation.requestStart
        : -1,
      dcl: navigation
        ? navigation.domContentLoadedEventEnd - navigation.startTime
        : -1,
      load: navigation ? navigation.loadEventEnd - navigation.startTime : -1,
      lcp: (window as unknown as { __lcp?: number | null }).__lcp ?? null,
      longTasks: tasks.length,
      longTaskMs: tasks.reduce((sum, value) => sum + value, 0),
    };
  });
  return {
    page: name,
    ttfbMs: Math.round(timing.ttfb),
    domContentLoadedMs: Math.round(timing.dcl),
    loadMs: Math.round(timing.load),
    lcpMs: timing.lcp === null ? null : Math.round(timing.lcp),
    readyMs,
    longTasks: timing.longTasks,
    longTaskMs: Math.round(timing.longTaskMs),
    interactionMs,
    timedOut,
    ok,
  };
}

function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(share * sorted.length))
  ] as number;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const password = process.env.LOAD_TEST_PASSWORD?.trim();
  if (!password) {
    throw new Error("LOAD_TEST_PASSWORD is required");
  }
  const browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  });
  const samples: PageSample[] = [];
  const failures: string[] = [];
  let crashes = 0;
  let pageErrors = 0;
  try {
    await Promise.all(
      Array.from({ length: args.users }, async (_, index) => {
        const context = await browser.newContext({
          viewport: { width: 1366, height: 900 },
        });
        await context.addInitScript(INIT_SCRIPT);
        const page = await context.newPage();
        page.on("crash", () => {
          crashes += 1;
        });
        page.on("pageerror", () => {
          pageErrors += 1;
        });
        const email = `load-user-${String(index + 1).padStart(3, "0")}@factorsage.invalid`;
        // First as a Guest: the public pages a visitor sees before signing in.
        for (const [name, path] of [
          ["guest-dashboard", "/"],
          ["guest-pricing", "/pricing"],
          ["guest-demos", "/demo-backtests"],
        ] as const) {
          samples.push(await measure(page, name, `${args.webUrl}${path}`));
        }
        try {
          await page.goto(`${args.webUrl}/login`, { waitUntil: "load" });
          await page.getByLabel(/email/i).first().fill(email);
          await page
            .getByLabel(/password/i)
            .first()
            .fill(password);
          await Promise.all([
            page.waitForURL((url) => !url.pathname.startsWith("/login"), {
              timeout: 30_000,
            }),
            page
              .getByRole("button", { name: /sign in/i })
              .first()
              .click(),
          ]);
        } catch (error) {
          failures.push(
            `${email}: sign-in failed (${error instanceof Error ? error.message : String(error)})`,
          );
          await context.close();
          return;
        }
        // A completed run of this user's, for the result page.
        const runHref = await page
          .goto(`${args.webUrl}/backtests`, { waitUntil: "load" })
          .then(() =>
            page
              .locator('a[href^="/backtests/"]')
              .first()
              .getAttribute("href", { timeout: 15_000 }),
          )
          .catch(() => null);
        // A well-known stock (the canonical universe, always resident) and a long-tail one (read
        // through the LRU), different in every round so the long-tail view is a cold read.
        const journey = (round: number): [string, string][] => [
          ["dashboard", "/"],
          [
            "stock-details",
            `/stocks/SYN${String(1 + ((index * 37 + round * 11) % 735)).padStart(4, "0")}`,
          ],
          [
            "stock-details-long-tail",
            `/stocks/SYN${String(736 + ((index * 53 + round * 17) % 1000)).padStart(4, "0")}`,
          ],
          ["strategies", "/strategies"],
          ["lists", "/lists"],
          ["backtest-history", "/backtests"],
          ...(runHref
            ? ([["backtest-result", runHref]] as [string, string][])
            : []),
          ["monitors", "/monitors"],
          ["pricing", "/pricing"],
          ["billing", "/billing"],
        ];
        for (let round = 0; round < args.rounds; round += 1) {
          for (const [name, path] of journey(round)) {
            samples.push(
              await measure(
                page,
                name,
                `${args.webUrl}${path}`,
                name === "dashboard",
              ),
            );
          }
        }
        await context.close();
      }),
    );
  } finally {
    await browser.close();
  }
  const pages = [...new Set(samples.map((sample) => sample.page))].map(
    (name) => {
      const entries = samples.filter((sample) => sample.page === name);
      const okEntries = entries.filter((sample) => sample.ok);
      return {
        page: name,
        samples: entries.length,
        failures: entries.length - okEntries.length,
        readyMs: {
          p50: percentile(
            okEntries.map((s) => s.readyMs),
            0.5,
          ),
          p95: percentile(
            okEntries.map((s) => s.readyMs),
            0.95,
          ),
        },
        ttfbMs: {
          p50: percentile(
            okEntries.map((s) => s.ttfbMs),
            0.5,
          ),
          p95: percentile(
            okEntries.map((s) => s.ttfbMs),
            0.95,
          ),
        },
        lcpMs: {
          p50: percentile(
            okEntries.flatMap((s) => (s.lcpMs === null ? [] : [s.lcpMs])),
            0.5,
          ),
        },
        longTasks: okEntries.reduce((sum, s) => sum + s.longTasks, 0),
        longTaskMsP95: percentile(
          okEntries.map((s) => s.longTaskMs),
          0.95,
        ),
        interactionMs: okEntries.some((s) => s.interactionMs !== null)
          ? {
              p50: percentile(
                okEntries.flatMap((s) =>
                  s.interactionMs === null ? [] : [s.interactionMs],
                ),
                0.5,
              ),
              max: Math.max(
                0,
                ...okEntries.flatMap((s) =>
                  s.interactionMs === null ? [] : [s.interactionMs],
                ),
              ),
            }
          : null,
        timeouts: entries.filter((s) => s.timedOut).length,
      };
    },
  );
  const report = {
    label: args.label,
    recordedAt: new Date().toISOString(),
    users: args.users,
    rounds: args.rounds,
    samples: samples.length,
    failures,
    crashes,
    pageErrors,
    pages,
  };
  const path = resolve(process.cwd(), args.report);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(report)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
