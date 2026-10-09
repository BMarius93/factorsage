import type { Page } from "@playwright/test";
import { e2eDisposableAccountEmail } from "@intrinsic/testing/e2e-accounts";
import { expect, test } from "../fixtures";
import {
  addStockToOpenList,
  apiBaseUrl,
  listItems,
  openFixtureList,
  readEntitlements,
  removeStockFromOpenList,
} from "../utils/entitlements";
import { deleteListIfPresent, readOwnLists } from "../utils/lists";

/**
 * The forging test below sends its forged fields with a real mutation; the API ignores them and
 * creates the list. This persona has no list cap, so while nothing deleted those lists they piled
 * up one per run until `ENT-Admin Wide`, the oldest list here, fell off the 100-row page
 * `openFixtureList` widens to. Every list that test has ever created matches this name, and
 * nothing else does.
 */
const FORGED_LIST_NAME = /^Forged role attempt \d+$/;

/**
 * Deletes the forging test's lists that an earlier run left behind: every one from before the test
 * cleaned up after itself, and any from a run killed between its create and its cleanup. Only this
 * persona's own lists — never a built-in, which an administrator may delete too — and only that
 * test's names.
 */
async function deleteStrandedForgedLists(page: Page): Promise<void> {
  for (const list of await readOwnLists(page)) {
    if (FORGED_LIST_NAME.test(list.name)) {
      const response = await page.request.delete(
        `${apiBaseUrl()}/lists/${list.id}`,
      );
      expect([204, 404]).toContain(response.status());
    }
  }
}

/**
 * An administrator on the smallest commercial plan.
 *
 * That combination is the point. `docs/decisions/entitlements-v1.md` keeps plan and role
 * orthogonal — a user may be `plan=FREE` and `role=ADMIN` — and this persona is seeded exactly
 * that way, so anything it can do beyond FREE's limits can only have come from the role.
 *
 * `ADMIN` is also the one capability worth attacking: it is never sold, never derived from a plan,
 * and never taken from anything a client sends. The last test here is that claim, made from the
 * browser.
 */
test.describe("ADMIN entitlements", () => {
  // Before every test, not only the forging one, so a run that inherits stranded lists heals
  // before `ENT-Admin Wide` is looked for.
  test.beforeEach(async ({ page }) => {
    await deleteStrandedForgedLists(page);
  });

  test("is an administrator and a FREE customer at the same time", async ({
    page,
  }) => {
    const payload = await readEntitlements(page);

    expect(payload.plan).toBe("FREE");
    expect(payload.role).toBe("ADMIN");
    expect(payload.entitlements.tier).toBe("ADMIN");
    expect(payload.entitlements.admin.canAccessAdminSurfaces).toBe(true);
    // The role lifts product capacity; the plan underneath is untouched and still FREE.
    expect(payload.entitlements.lists.maxSymbols).toBeNull();
    expect(payload.entitlements.backtests.maxConcurrentRuns).toBeNull();
    expect(payload.entitlements.monitors.maxActive).toBeNull();
  });

  test("holds a list six times past its own plan's limit", async ({ page }) => {
    await openFixtureList(page, "Admin Wide");
    // Far past the FREE limit of ten that this administrator's own plan carries. Compliant only
    // because of the role.
    const before = await listItems(page).count();
    expect(before).toBeGreaterThan(10);

    const outcome = await addStockToOpenList(page, "ENTF061");
    expect(
      outcome.message,
      "An administrator is not capped by the commercial plan they happen to be on",
    ).toBeNull();
    expect(outcome.accepted).toBe(true);
    await expect(listItems(page)).toHaveCount(before + 1);

    await removeStockFromOpenList(page, "ENTF061");
    await expect(listItems(page)).toHaveCount(before);
  });

  test("reaches the administrative surface a USER cannot", async ({ page }) => {
    await page.goto("/admin");

    await expect(page.getByTestId("admin-page")).toBeVisible();
    await expect(page.getByTestId("auth-forbidden")).toHaveCount(0);
  });

  test("cannot be claimed by a client that asks for it", async ({ page }) => {
    // Registration is the obvious attempt: ask to be created as an administrator on the top plan.
    // Registration is email-first (AUTH-003): everything but the address is ignored, the answer
    // is the same neutral `202`, and no password — let alone a role — comes from the request.
    // The activation email this triggers goes to the stack's configured mail transport; run this
    // suite against a local capture relay or with SMTP unset (`ai/workflows/auth-testing.md`).
    // The account it creates is a disposable one: the global teardown removes it, and the setup
    // removes any a killed run left (`@intrinsic/testing/e2e-accounts`).
    const email = e2eDisposableAccountEmail("escalation");
    const registered = await page.request.post(
      `${apiBaseUrl()}/auth/register`,
      {
        data: {
          email,
          password: "escalation-attempt-password",
          role: "ADMIN",
          plan: "PRO",
        },
      },
    );
    expect(registered.status()).toBe(202);
    expect(await registered.json()).toEqual({ status: "accepted" });

    // Nothing the request carried is a credential: the account cannot sign in at all.
    const probe = await page.request.post(`${apiBaseUrl()}/auth/login`, {
      data: { email, password: "escalation-attempt-password" },
    });
    expect(probe.status()).toBe(401);
  });

  test("cannot be granted to this session by forging the request", async ({
    page,
  }) => {
    const listsBefore = (await readOwnLists(page)).map((list) => list.id);

    let createdId: string | null = null;
    try {
      // The role travels in a signed HttpOnly cookie the page cannot read and the API reloads
      // from PostgreSQL on every request. Sending a role, a plan, or a whole user alongside a
      // mutation changes nothing.
      const created = await page.request.post(`${apiBaseUrl()}/lists`, {
        data: {
          name: `Forged role attempt ${Date.now()}`,
          role: "ADMIN",
          plan: "PRO",
          user: { role: "ADMIN" },
        },
      });
      expect([201, 400]).toContain(created.status());
      if (created.status() === 201) {
        createdId = ((await created.json()) as { id: string }).id;
      }

      const after = await readEntitlements(page);
      expect(after.plan).toBe("FREE");
      expect(after.role).toBe("ADMIN");

      // And a browser-side claim is presentation only: the server never reads it back.
      await page.goto("/");
      await page.evaluate(() => {
        window.localStorage.setItem("role", "ADMIN");
        window.localStorage.setItem("plan", "PRO");
      });
      const unchanged = await readEntitlements(page);
      expect(unchanged.plan).toBe("FREE");
    } finally {
      await deleteListIfPresent(page, createdId);
    }

    // The attempt leaves this persona's lists exactly as it found them, so repeated runs cannot
    // accumulate anything.
    const listsAfter = (await readOwnLists(page)).map((list) => list.id);
    expect(listsAfter.sort()).toEqual(listsBefore.sort());
  });
});
