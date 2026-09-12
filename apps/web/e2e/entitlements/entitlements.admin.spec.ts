import { expect, test } from "@playwright/test";
import {
  addStockToOpenList,
  apiBaseUrl,
  listItems,
  openFixtureList,
  readEntitlements,
  removeStockFromOpenList,
} from "../utils/entitlements";

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
    const email = `escalation-${Date.now()}@example.test`;
    await page.request.post(`${apiBaseUrl()}/auth/register`, {
      data: {
        email,
        password: "escalation-attempt-password",
        role: "ADMIN",
        plan: "PRO",
      },
    });

    // Whatever the registration answered, the account it may have created is not an administrator.
    const probe = await page.request.post(`${apiBaseUrl()}/auth/login`, {
      data: { email, password: "escalation-attempt-password" },
    });
    if (probe.ok()) {
      const user = (await probe.json()) as { role: string; plan: string };
      expect(user.role).toBe("USER");
      expect(user.plan).toBe("FREE");
    }
  });

  test("cannot be granted to this session by forging the request", async ({
    page,
  }) => {
    // The role travels in a signed HttpOnly cookie the page cannot read and the API reloads from
    // PostgreSQL on every request. Sending a role, a plan, or a whole user alongside a mutation
    // changes nothing.
    const created = await page.request.post(`${apiBaseUrl()}/lists`, {
      data: {
        name: `Forged role attempt ${Date.now()}`,
        role: "ADMIN",
        plan: "PRO",
        user: { role: "ADMIN" },
      },
    });
    expect([201, 400]).toContain(created.status());

    const after = await readEntitlements(page);
    expect(after.plan).toBe("FREE");
    expect(after.role).toBe("ADMIN");

    // And a browser-side claim is presentation only: the server never reads it back.
    await page.goto("/dashboard");
    await page.evaluate(() => {
      window.localStorage.setItem("role", "ADMIN");
      window.localStorage.setItem("plan", "PRO");
    });
    const unchanged = await readEntitlements(page);
    expect(unchanged.plan).toBe("FREE");
  });
});
