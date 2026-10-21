import type {
  DashboardActivityEventResponse,
  DashboardActivityResponse,
} from "@intrinsic/contracts";
import type { Route } from "@playwright/test";
import { expect, test, type Page } from "../fixtures";

/**
 * The Monitor activity feed's reading guarantees (`docs/decisions/monitor-eod-v2.md` §7, DB-2):
 * arrivals are merged where they belong without moving the row the reader is on, an event written
 * late for an older session still appears, one trigger starts one request, and an answer for a filter
 * the reader has left is never shown.
 *
 * The feed's shape is injected over the hermetic API's real answer (its events are the template), so
 * the cases stay deterministic; every read still goes through the real client and the real hook.
 */

const ACTIVITY = /\/dashboard\/activity(\?.*)?$/;

/** Monday-to-Friday sessions, newest first, ending Oct 16, 2026. */
const SESSIONS = [
  "2026-10-16",
  "2026-10-15",
  "2026-10-14",
  "2026-10-13",
  "2026-10-12",
  "2026-10-09",
  "2026-10-08",
];

function copy(
  template: DashboardActivityEventResponse,
  id: string,
  sequence: number,
  sessionDate: string,
): DashboardActivityEventResponse {
  return { ...template, id, sequence: String(sequence), sessionDate };
}

/** The hermetic API's own first page for this request's filters: the template for injected events. */
async function realAnswer(route: Route): Promise<DashboardActivityResponse> {
  const url = new URL(route.request().url());
  url.searchParams.delete("cursor");
  url.searchParams.delete("since");
  const response = await route.fetch({ url: url.toString() });
  return (await response.json()) as DashboardActivityResponse;
}

async function dismissConsent(page: Page) {
  const reject = page.getByTestId("consent-reject");
  if (await reject.isVisible().catch(() => false)) {
    await reject.click();
  }
}

test.describe("Monitor activity feed", () => {
  test("keeps the reader's row in place while a new event and a late one are merged in", async ({
    page,
  }) => {
    let template: DashboardActivityEventResponse | undefined;
    const sinceReads: string[] = [];
    await page.route(ACTIVITY, async (route) => {
      const url = new URL(route.request().url());
      const body = await realAnswer(route);
      template ??= body.events[0];
      if (!template) throw new Error("the hermetic feed has no events");
      const since = url.searchParams.get("since");
      if (since !== null) {
        sinceReads.push(since);
        await route.fulfill({
          json: {
            ...body,
            events: [
              copy(template, "arrival-new", 2_000, "2026-10-19"),
              // Written after everything shown, for the third session on screen.
              copy(template, "arrival-late", 2_001, SESSIONS[2]!),
            ],
            watermark: "1000",
          } satisfies DashboardActivityResponse,
        });
        return;
      }
      // Six events in each of seven sessions: a feed long enough to read down.
      const events = SESSIONS.flatMap((session, day) =>
        Array.from({ length: 6 }, (_, index) =>
          copy(
            template!,
            `shown-${day}-${index}`,
            900 - day * 10 - index,
            session,
          ),
        ),
      );
      await route.fulfill({
        json: { ...body, events, watermark: "1000" },
      });
    });
    await page.clock.install();
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto("/");
    await dismissConsent(page);
    const rows = page.getByTestId("dashboard-activity-row");
    await expect(rows).toHaveCount(42);

    // The reader is well into the feed, reading the fifth session.
    const reading = page.locator('[data-event-id="shown-4-2"]');
    await reading.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -200));
    const before = await reading.boundingBox();

    await page.clock.runFor(60_000);
    const arrivals = page.getByTestId("dashboard-activity-arrivals");
    await expect(arrivals).toBeVisible();
    await expect(arrivals.getByRole("status")).toHaveText(
      "1 new event · 1 event added to an earlier session",
    );
    expect(sinceReads).toEqual(["1000"]);
    await expect(rows).toHaveCount(44);

    // Two rows were added above it; the row being read has not moved.
    const after = await reading.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);

    // The late event sits in its own session, newest-written first; the new one tops the feed.
    const sessionOf = (id: string) =>
      page
        .locator(`[data-event-id="${id}"]`)
        .locator("xpath=ancestor::*[@data-testid='dashboard-session-group'][1]")
        .getByTestId("dashboard-session");
    await expect(sessionOf("arrival-late")).toHaveText("October 14, 2026");
    const lateGroup = page
      .locator('[data-event-id="arrival-late"]')
      .locator("xpath=ancestor::*[@data-testid='dashboard-session-group'][1]");
    await expect(
      lateGroup.getByTestId("dashboard-activity-row").first(),
    ).toHaveAttribute("data-event-id", "arrival-late");
    await expect(rows.first()).toHaveAttribute("data-event-id", "arrival-new");

    // "Show newest" goes back to the top; nothing is read again to do it.
    await arrivals.getByTestId("dashboard-activity-show-newest").click();
    await expect(arrivals).toHaveCount(0);
    await expect(rows.first()).toBeInViewport();
    expect(sinceReads).toEqual(["1000"]);
  });

  test("starts one request for a double click, and never shows an older page of a filter the reader left", async ({
    page,
  }) => {
    const cursorReads: string[] = [];
    let releaseOlder: () => void = () => undefined;
    const olderHeld = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    await page.route(ACTIVITY, async (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null) cursorReads.push(cursor);
      const body = await realAnswer(route);
      const template = body.events[0]!;
      if (cursor !== null) {
        await olderHeld;
        await route
          .fulfill({
            json: {
              ...body,
              events: [copy(template, "stale-older", 10, "2026-09-01")],
            },
          })
          .catch(() => undefined);
        return;
      }
      if (url.searchParams.get("kind") === null) {
        await route.fulfill({
          json: {
            ...body,
            events: body.events.slice(0, 2),
            nextCursor: "held-cursor",
          },
        });
        return;
      }
      await route.fulfill({ json: body });
    });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/");
    await dismissConsent(page);
    const rows = page.getByTestId("dashboard-activity-row");
    await expect(rows).toHaveCount(2);

    await page.getByTestId("dashboard-activity-more").dblclick();
    await expect(page.getByTestId("dashboard-activity-more")).toHaveText(
      "Loading…",
    );
    await expect.poll(() => cursorReads).toEqual(["held-cursor"]);

    // The reader changes the Event filter while that page is still on its way.
    await page.getByTestId("dashboard-event-filter").selectOption("ACTIVATED");
    await expect(rows.first()).toBeVisible();
    releaseOlder();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-event-id="stale-older"]')).toHaveCount(0);
    for (const row of await rows.all()) {
      await expect(row).toHaveAttribute("data-kind", "ACTIVATED");
    }
    expect(cursorReads).toEqual(["held-cursor"]);
  });

  test("says when older activity could not be loaded, and loads it on retry", async ({
    page,
  }) => {
    let failures = 0;
    await page.route(ACTIVITY, async (route) => {
      const url = new URL(route.request().url());
      const body = await realAnswer(route);
      if (url.searchParams.get("cursor") !== null) {
        if (failures === 0) {
          failures += 1;
          await route.fulfill({ status: 503, json: { message: "down" } });
          return;
        }
        await route.fulfill({
          json: {
            ...body,
            events: [copy(body.events[0]!, "older-1", 5, "2026-09-01")],
          },
        });
        return;
      }
      await route.fulfill({
        json: { ...body, events: body.events.slice(0, 1), nextCursor: "c1" },
      });
    });
    await page.goto("/");
    await dismissConsent(page);
    await page.getByTestId("dashboard-activity-more").click();
    await expect(page.getByTestId("dashboard-activity-more-failed")).toHaveText(
      "Older activity could not be loaded.",
    );
    await page.getByTestId("dashboard-activity-more").click();
    await expect(page.locator('[data-event-id="older-1"]')).toHaveCount(1);
    await expect(
      page.getByTestId("dashboard-activity-more-failed"),
    ).toHaveCount(0);
  });
});
