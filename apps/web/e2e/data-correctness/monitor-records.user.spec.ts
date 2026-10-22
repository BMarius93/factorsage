import {
  newYorkDate,
  type DashboardActivityEventResponse,
  type DashboardActivityResponse,
  type DashboardResponse,
  type MonitorDetailResponse,
  type MonitorSignalPageResponse,
  type MonitorSignalRowResponse,
  type MonitorSummaryResponse,
  type MonitorWhyResponse,
} from "@intrinsic/contracts";
import { expect, test, type Locator, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";

/**
 * The Monitor records a user reads — the Dashboard's activity feed and each Monitor's one Signal
 * table — reconciled against the records the API serves, and those records against the rules that
 * make them correct (`docs/decisions/monitor-eod-v2.md` §6–§10).
 *
 * This is the hermetic, every-run counterpart of the data-correctness audit's Dashboard stage
 * (`data-correctness.audit.spec.ts`, run by `pnpm audit:data-correctness` against the QA matrix).
 * The audit proves the values against an independent oracle on real data; this spec proves, on the
 * deterministic QA built-ins, the properties the audit's Dashboard stage existed to protect:
 *
 * - every stored Signal is shown exactly once, active ones first, dated by its own finalized
 *   session, with its activation price and the Why that decided it;
 * - every feed event is shown under the heading of its own finalized session, with the values its
 *   Why compared — and, since Dashboard V2, without a standalone price of its own;
 * - only **observed** changes are activity: a change history established, or one an administrative
 *   event made, is a Signal-table record and never a feed event;
 * - every feed event is a Signal-table record with the same stock, level, session and price;
 * - nothing is dated after the newest finalized session, and nothing calls itself live;
 * - a private Monitor's records are its owner's alone.
 *
 * Needs `pnpm test:personas:seed` (which seeds the QA built-ins): Monitor A and Monitor B, with
 * observed activations and endings, a setup waiting for its trigger, and one occurrence that a
 * reconstruction established and a membership change ended administratively.
 */

const BUILT_IN = /^QA Built-in Monitor [AB]$/;

async function getJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${apiBaseUrl()}${path}`);
  expect(response.ok(), `${path} → ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

const money = (value: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value,
  );

/** Evidence values as the Why shows them: two decimals under 1,000. */
const evidenceValue = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

/** A session as the feed's session heading writes it: `September 11, 2026`. */
const sessionHeading = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));

/** Every value a Why with recorded evidence compared appears where the Why is shown. */
async function expectWhyShown(
  shown: Locator,
  why: MonitorWhyResponse | undefined,
) {
  if (why?.basis !== "EVIDENCE") {
    return;
  }
  for (const rule of why.rules) {
    for (const predicate of rule.predicates) {
      for (const value of [predicate.metric, predicate.value]) {
        if (typeof value === "number") {
          await expect(shown).toContainText(evidenceValue(value));
        }
      }
    }
  }
}

async function builtInMonitors(page: Page) {
  const dashboard = await getJson<DashboardResponse>(page, "/dashboard");
  const monitors = dashboard.monitors.filter((monitor) =>
    BUILT_IN.test(monitor.name),
  );
  expect(monitors.map((monitor) => monitor.name).sort()).toEqual([
    "QA Built-in Monitor A",
    "QA Built-in Monitor B",
  ]);
  return monitors;
}

async function signalRows(
  page: Page,
  monitorId: string,
  state?: "PENDING_TRIGGER",
): Promise<MonitorSignalRowResponse[]> {
  const page1 = await getJson<MonitorSignalPageResponse>(
    page,
    `/monitors/${monitorId}/signals?limit=100${state ? `&state=${state}` : ""}`,
  );
  expect(page1.nextCursor).toBeUndefined();
  return page1.rows;
}

/** The whole feed, page by page (the API serves at most 50 events a page). */
async function activity(page: Page): Promise<DashboardActivityEventResponse[]> {
  const events: DashboardActivityEventResponse[] = [];
  let cursor: string | undefined;
  do {
    const feed: DashboardActivityResponse =
      await getJson<DashboardActivityResponse>(
        page,
        `/dashboard/activity?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
    events.push(...feed.events);
    cursor = feed.nextCursor;
  } while (cursor);
  return events;
}

test.describe("Monitor records, reconciled", () => {
  test("shows every stored Signal once, active first, on its own finalized session, with its price, provenance and Why", async ({
    page,
  }) => {
    const today = newYorkDate(new Date());
    for (const monitor of await builtInMonitors(page)) {
      const detail = await getJson<MonitorDetailResponse>(
        page,
        `/monitors/${monitor.id}`,
      );
      const rows = await signalRows(page, monitor.id);
      expect(rows.length, monitor.name).toBeGreaterThan(0);
      // Active first: no active occurrence is listed after an ended one.
      const states = rows.map((row) => row.state);
      const firstEnded = states.indexOf("RESOLVED");
      expect(
        firstEnded === -1 || states.lastIndexOf("ACTIVE") < firstEnded,
        `${monitor.name}: ${states.join(", ")}`,
      ).toBe(true);
      for (const row of rows) {
        // Finalized sessions only: never after today in New York, never past the evaluation.
        expect(row.sessionDate <= today, row.id).toBe(true);
        if (detail.coverage?.latestSession && row.state === "ACTIVE") {
          expect(row.sessionDate <= detail.coverage.latestSession).toBe(true);
        }
        if (row.state === "ACTIVE") {
          expect(row.activatedOn).toBe(row.sessionDate);
        }
      }

      await page.goto(`/monitors/${monitor.id}`);
      const table = page.getByTestId("monitor-signals");
      await expect(table.getByTestId("monitor-signal-row")).toHaveCount(
        rows.length,
      );
      for (const [index, row] of rows.entries()) {
        const shown = table.getByTestId("monitor-signal-row").nth(index);
        await expect(shown).toContainText(row.security.symbol);
        await expect(shown.locator("[data-kind]").first()).toHaveAttribute(
          "data-kind",
          row.levelKind,
        );
        await expect(
          shown.getByTestId("monitor-signal-status"),
        ).toHaveAttribute("data-state", row.state);
        await expect(
          shown.locator(`time[datetime="${row.sessionDate}"]`),
        ).toHaveCount(1);
        if (row.activationPrice !== undefined) {
          await expect(shown).toContainText(money(row.activationPrice));
        }
        await expect(shown.getByTestId("monitor-signal-history")).toHaveCount(
          row.fromHistory ? 1 : 0,
        );
        await expectWhyShown(shown, row.why);
      }
      const dashboardText = await page
        .getByTestId("monitor-detail")
        .innerText();
      expect(dashboardText).not.toMatch(/\blive\b|real-time/i);
    }
  });

  test("lists a setup waiting for its trigger under Waiting, never as an occurrence", async ({
    page,
  }) => {
    const monitorB = (await builtInMonitors(page)).find(
      (monitor) => monitor.name === "QA Built-in Monitor B",
    )!;
    const waiting = await signalRows(page, monitorB.id, "PENDING_TRIGGER");
    expect(waiting.map((row) => [row.security.symbol, row.state])).toEqual([
      ["QATEST2", "PENDING_TRIGGER"],
    ]);
    await page.goto(`/monitors/${monitorB.id}`);
    await page
      .getByTestId("monitor-signal-state-filter")
      .getByRole("button", { name: "Waiting" })
      .click();
    const rows = page
      .getByTestId("monitor-signals")
      .getByTestId("monitor-signal-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Waiting for trigger");
    await expect(
      rows.first().locator(`time[datetime="${waiting[0]!.sessionDate}"]`),
    ).toHaveCount(1);
  });

  test("keeps history and administrative changes in the Signal table, and out of the activity feed", async ({
    page,
  }) => {
    const monitorB = (await builtInMonitors(page)).find(
      (monitor) => monitor.name === "QA Built-in Monitor B",
    )!;
    const rows = await signalRows(page, monitorB.id);
    const established = rows.find(
      (row) => row.security.symbol === "QATEST2" && row.state === "RESOLVED",
    );
    expect(established).toMatchObject({
      fromHistory: true,
      activatedOn: "2026-08-20",
      resolutionReason: "MEMBERSHIP_CHANGED",
    });
    // Ended by an administrative change, not by a session: no session ended it.
    expect(established!.resolvedOn).toBeUndefined();
    await page.goto(`/monitors/${monitorB.id}`);
    const shown = page
      .getByTestId("monitor-signals")
      .getByTestId("monitor-signal-row")
      .filter({ hasText: "QATEST2" })
      .filter({ hasText: "no longer a current list member" });
    await expect(shown).toHaveCount(1);
    await expect(shown.getByTestId("monitor-signal-history")).toHaveText(
      "From history",
    );

    const events = await activity(page);
    for (const event of events) {
      // Only observed activations, and endings a market observation made.
      expect(
        (event.kind === "ACTIVATED" &&
          ["TRIGGER_FIRED", "CONDITIONS_MET"].includes(event.reason)) ||
          (event.kind === "RESOLVED" && event.reason === "CONDITIONS_ENDED"),
        `${event.monitor.name} ${event.security.symbol} ${event.kind} ${event.reason}`,
      ).toBe(true);
      expect(event.signalId).not.toBe(established!.id);
    }
  });

  test("shows each feed event as the Signal-table record it is, in order, with its session, price and Why", async ({
    page,
  }) => {
    const monitors = await builtInMonitors(page);
    const ids = new Set(monitors.map((monitor) => monitor.id));
    const events = (await activity(page)).filter((event) =>
      ids.has(event.monitor.id),
    );
    expect(events.length).toBeGreaterThan(0);
    // Newest session first.
    const sessions = events.map((event) => event.sessionDate);
    expect([...sessions].sort().reverse()).toEqual(sessions);
    const today = newYorkDate(new Date());
    for (const event of events) {
      expect(event.sessionDate <= today).toBe(true);
      const record = (await signalRows(page, event.monitor.id)).find(
        (row) => row.id === event.signalId,
      );
      expect(
        record,
        `${event.monitor.name} ${event.security.symbol}`,
      ).toBeDefined();
      expect(record!.security.symbol).toBe(event.security.symbol);
      expect(record!.levelKind).toBe(event.levelKind);
      expect(record!.fromHistory).toBe(false);
      if (event.kind === "ACTIVATED") {
        expect(record!.activatedOn).toBe(event.sessionDate);
        expect(record!.activationPrice).toBe(event.price);
      } else {
        expect(record!.resolvedOn).toBe(event.sessionDate);
      }
    }

    await page.goto("/");
    const feedRows = page
      .getByTestId("dashboard-activity-row")
      .filter({ hasText: /QA Built-in Monitor/ });
    await expect(feedRows).toHaveCount(events.length);
    for (const [index, event] of events.entries()) {
      const shown = feedRows.nth(index);
      await expect(shown).toContainText(event.security.symbol);
      await expect(shown).toContainText(event.monitor.name);
      // Dated by the heading of the session group it sits in, written once for all its events.
      await expect(
        shown
          .locator(
            "xpath=ancestor::*[@data-testid='dashboard-session-group'][1]",
          )
          .getByTestId("dashboard-session"),
      ).toHaveText(sessionHeading(event.sessionDate));
      // The activation price is the Signal table's to show; the feed shows prices only where a
      // condition compared them.
      await expect(shown).not.toContainText("$");
      await expectWhyShown(shown, event.why);
    }
  });

  test("keeps a private Monitor's records to its owner", async ({
    page,
    playwright,
  }) => {
    const own = (
      await getJson<MonitorSummaryResponse[]>(page, "/monitors")
    ).filter((monitor) => monitor.ownership === "USER");
    expect(own.length).toBeGreaterThan(0);
    // A request context opened in a test inherits the project's storage state unless told not to.
    const anonymous = await playwright.request.newContext({
      baseURL: apiBaseUrl(),
      storageState: { cookies: [], origins: [] },
    });
    try {
      for (const monitor of own) {
        expect((await anonymous.get(`/monitors/${monitor.id}`)).status()).toBe(
          404,
        );
        expect(
          (await anonymous.get(`/monitors/${monitor.id}/signals`)).status(),
        ).toBe(404);
      }
      const guestFeed = (await (
        await anonymous.get("/dashboard/activity?limit=50")
      ).json()) as DashboardActivityResponse;
      const ownIds = new Set(own.map((monitor) => monitor.id));
      expect(
        guestFeed.events.filter((event) => ownIds.has(event.monitor.id)),
      ).toEqual([]);
      expect(
        guestFeed.events.every((event) => event.monitor.ownership === "SYSTEM"),
      ).toBe(true);
    } finally {
      await anonymous.dispose();
    }
  });
});
