import type {
  DashboardActivityEventResponse,
  DashboardActivityResponse,
} from "@intrinsic/contracts";
import type { Route } from "@playwright/test";
import { expect, test, type Page } from "../fixtures";

/**
 * The Monitor activity feed's reading guarantees (`docs/decisions/monitor-eod-v2.md` §7, DB-2):
 * a refresh re-reads the range the reader holds and shows new and late events where they belong
 * without moving the row the reader is on, older pages load on their own a few at a time and one
 * request each, and an answer for a filter the reader has left is never shown.
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
  sessionDate: string,
): DashboardActivityEventResponse {
  return { ...template, id, sessionDate };
}

/** The hermetic API's own first page for this request's filters: the template for injected events. */
async function realAnswer(route: Route): Promise<DashboardActivityResponse> {
  const url = new URL(route.request().url());
  url.searchParams.delete("cursor");
  url.searchParams.delete("through");
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
  test("keeps the reader's row in place while a new event and a late one appear on refresh", async ({
    page,
  }) => {
    const throughReads: string[] = [];
    await page.route(ACTIVITY, async (route) => {
      const url = new URL(route.request().url());
      const body = await realAnswer(route);
      const template = body.events[0];
      if (!template) throw new Error("the hermetic feed has no events");
      // Six events in each of seven sessions: a feed long enough to read down.
      const held = SESSIONS.flatMap((session, day) =>
        Array.from({ length: 6 }, (_, index) =>
          copy(template, `shown-${day}-${index}`, session),
        ),
      );
      const through = url.searchParams.get("through");
      if (through !== null) {
        throughReads.push(through);
        // The held range, read again: one event is new, one was written late for the third
        // session and sorts first within it.
        const lateAt = held.findIndex(
          (item) => item.sessionDate === SESSIONS[2],
        );
        await route.fulfill({
          json: {
            ...body,
            events: [
              copy(template, "arrival-new", "2026-10-19"),
              ...held.slice(0, lateAt),
              copy(template, "arrival-late", SESSIONS[2]!),
              ...held.slice(lateAt),
            ],
          } satisfies DashboardActivityResponse,
        });
        return;
      }
      await route.fulfill({ json: { ...body, events: held } });
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
    // The whole range it holds, down to its oldest loaded event, was read again.
    expect(throughReads).toEqual(["shown-6-5"]);
    await expect(rows).toHaveCount(44);

    // Two rows were added above it; the row being read has not moved.
    const after = await reading.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);

    // The late event sits first in its own session; the new one tops the feed.
    const groupOf = (id: string) =>
      page
        .locator(`[data-event-id="${id}"]`)
        .locator(
          "xpath=ancestor::*[@data-testid='dashboard-session-group'][1]",
        );
    await expect(
      groupOf("arrival-late").getByTestId("dashboard-session"),
    ).toHaveText("October 14, 2026");
    await expect(
      groupOf("arrival-late").getByTestId("dashboard-activity-row").first(),
    ).toHaveAttribute("data-event-id", "arrival-late");
    await expect(rows.first()).toHaveAttribute("data-event-id", "arrival-new");

    // "Show newest" goes back to the top; nothing is read again to do it.
    await arrivals.getByTestId("dashboard-activity-show-newest").click();
    await expect(arrivals).toHaveCount(0);
    await expect(rows.first()).toBeInViewport();
    expect(throughReads).toHaveLength(1);
  });

  test("loads four older pages on its own, one request each, then one per press of Show more", async ({
    page,
  }) => {
    const cursorReads: string[] = [];
    await page.route(ACTIVITY, async (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null) cursorReads.push(cursor);
      const body = await realAnswer(route);
      const template = body.events[0]!;
      // An endless feed: every page one event older, with a cursor to the next.
      const number = cursor === null ? 0 : Number(cursor.slice(5)) + 1;
      await route.fulfill({
        json: {
          ...body,
          events: [copy(template, `page-${number}`, "2026-09-01")],
          nextCursor: `page-${number}`,
        },
      });
    });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/");
    await dismissConsent(page);
    const rows = page.getByTestId("dashboard-activity-row");

    // The feed is shorter than the screen, so the next page is always within reach: it fills on
    // its own, four older pages, and then waits for the reader.
    const more = page.getByTestId("dashboard-activity-more");
    await expect(more).toHaveText("Show more activity");
    await expect(rows).toHaveCount(5);
    expect(cursorReads).toEqual(["page-0", "page-1", "page-2", "page-3"]);

    await more.dblclick();
    await expect(rows).toHaveCount(6);
    await page.waitForTimeout(300);
    expect(cursorReads).toEqual([
      "page-0",
      "page-1",
      "page-2",
      "page-3",
      "page-4",
    ]);
  });

  test("never shows an older page of a filter the reader left", async ({
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
              events: [copy(template, "stale-older", "2026-09-01")],
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

    // The older page is asked for once, and is still on its way.
    await expect.poll(() => cursorReads).toEqual(["held-cursor"]);
    await expect(page.getByTestId("dashboard-activity-autoload")).toContainText(
      "Loading older activity…",
    );

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
            events: [copy(body.events[0]!, "older-1", "2026-09-01")],
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
    // The older page is asked for on its own and fails: the feed stops asking and says so.
    await expect(page.getByTestId("dashboard-activity-more-failed")).toHaveText(
      "Older activity could not be loaded.",
    );
    await expect(page.getByTestId("dashboard-activity-more")).toHaveText(
      "Try again",
    );
    await page.getByTestId("dashboard-activity-more").click();
    await expect(page.locator('[data-event-id="older-1"]')).toHaveCount(1);
    await expect(
      page.getByTestId("dashboard-activity-more-failed"),
    ).toHaveCount(0);
  });
});
