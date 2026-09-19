// Sections 12–14 + admin + failure pages. Billing is driven entirely by mocked /billing/* responses,
// and every Stripe-facing POST is mocked, so no Checkout session or Portal link is ever created.
import { launch, personaContext, watch, settle, shot, VIEWPORTS as V, saveManifest, jsonRoute, hangRoute, apiUrl } from "./lib.mjs";
import { BILLING } from "./mocks.mjs";

const browser = await launch();
const ALL = [V.d1440, V.d1280, V.t1024, V.b880, V.b879, V.m390];
const STD = [V.d1440, V.t1024, V.m390];
const DM = [V.d1440, V.m390];
async function open(persona) {
  const ctx = await personaContext(browser, persona);
  const page = await ctx.newPage();
  watch(page);
  return { ctx, page };
}
async function step(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`  ✗ ${label}: ${String(e).split("\n")[0]}`);
  }
}
async function visit(page, route, vp, ms = 700) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await settle(page, ms);
}
const g = ["/auth/me"];

// ═════════════════════════════ SEARCH ═════════════════════════════
console.log("search");
for (const persona of ["guest", "pro-heavy"]) {
  const { ctx, page } = await open(persona);
  const exp = persona === "guest" ? g : [];
  for (const vp of DM) {
    await step("search blank", async () => {
      await visit(page, "/dashboard", vp, 900);
      if (vp.width < 380) await page.getByRole("button", { name: "Search stocks" }).click();
      await page.getByRole("combobox", { name: "Search stocks" }).click();
      await page.waitForTimeout(500);
      await shot(page, { area: "stocks", name: `${persona}-search-focused-blank`, persona, state: persona === "guest" ? "Focused, blank: popular only (no recents)" : "Focused, blank: Recent Searches + Popular", viewport: vp, section: "12 Search", fullPage: false, expectedFailures: exp });
      await page.keyboard.type("QA", { delay: 30 });
      await page.waitForTimeout(900);
      await shot(page, { area: "stocks", name: `${persona}-search-results`, persona, state: "Results for 'QA'", viewport: vp, section: "12 Search", fullPage: false, expectedFailures: exp });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(200);
      await shot(page, { area: "stocks", name: `${persona}-search-keyboard-highlight`, persona, state: "Arrow-key highlight", viewport: vp, section: "12 Search / 28 A11y", fullPage: false, expectedFailures: exp });
      await page.getByRole("combobox", { name: "Search stocks" }).fill("International Business");
      await page.waitForTimeout(900);
      await shot(page, { area: "stocks", name: `${persona}-search-long-company-name`, persona, state: "Long company name result", viewport: vp, section: "12 Search / 18 Density", fullPage: false, expectedFailures: exp });
      await page.getByRole("combobox", { name: "Search stocks" }).fill("zzqqxx");
      await page.waitForTimeout(900);
      await shot(page, { area: "stocks", name: `${persona}-search-no-results`, persona, state: "No results", viewport: vp, section: "12 Search / 15 Empty", fullPage: false, expectedFailures: exp });
    });
  }
  if (persona === "pro-heavy") {
    await step("search error/429/loading", async () => {
      for (const [name, handler, state, mock] of [
        ["search-error", jsonRoute({ statusCode: 500, message: "Internal server error" }, 500), "Search → 500", "GET /stocks/search → 500"],
        ["search-rate-limited", jsonRoute({ statusCode: 429, code: "RATE_LIMITED", message: "Too many requests", retryAfterSeconds: 42 }, 429), "Search → 429", "GET /stocks/search → 429"],
        ["search-loading", hangRoute(), "Search pending, no prior results", "GET /stocks/search hangs"],
      ]) {
        await page.route(/\/stocks\/search/, handler);
        for (const vp of DM) {
          await visit(page, "/dashboard", vp, 800);
          await page.getByRole("combobox", { name: "Search stocks" }).fill("GS");
          await page.waitForTimeout(900);
          await shot(page, { area: "stocks", name: `pro-heavy-${name}`, persona, state, viewport: vp, section: "12 Search / 17 Errors", fullPage: false, mocks: [mock], expectedFailures: ["/stocks/search"] });
        }
        await page.unroute(/\/stocks\/search/);
      }
    });
  }
  await ctx.close();
}

// ═════════════════════════════ STOCK DETAILS ═════════════════════════════
console.log("stock details");
{
  const { ctx, page } = await open("pro");
  for (const vp of ALL) {
    await step("qatest1", async () => {
      await visit(page, "/stocks/QATEST1", vp, 1500);
      await shot(page, { area: "stocks", name: "pro-details-qatest1", persona: "pro", state: "Stock Details with 3y synthetic data, default Balanced overlay", viewport: vp, section: "13 Stock Details" });
    });
  }
  for (const vp of DM) {
    await step("indicators open", async () => {
      await visit(page, "/stocks/QATEST1", vp, 1500);
      await page.getByRole("button", { name: /Indicators/ }).click();
      await page.waitForTimeout(400);
      await shot(page, { area: "pickers", name: "pro-indicators-menu-open", persona: "pro", state: "Indicators popover open (grouped checkboxes, Unavailable entries)", viewport: vp, section: "7 Pickers / 13 Stock Details", fullPage: false });
      await page.getByRole("dialog", { name: "Indicators" }).evaluate((d) => d.scrollTo(0, d.scrollHeight));
      await page.waitForTimeout(200);
      await shot(page, { area: "pickers", name: "pro-indicators-menu-scrolled", persona: "pro", state: "Indicators popover scrolled to the end", viewport: vp, section: "7 Pickers", fullPage: false });
      for (const label of ["SMA 50D", "SMA 200D", "RSI 14D"]) await page.getByRole("checkbox", { name: new RegExp(`^${label}`) }).check().catch(() => {});
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      await shot(page, { area: "stocks", name: "pro-details-overlays-rsi", persona: "pro", state: "SMA 50D + SMA 200D + RSI 14D pane selected", viewport: vp, section: "13 Stock Details charts" });
      await page.getByText("MAX", { exact: true }).click();
      await page.waitForTimeout(1500);
      await shot(page, { area: "stocks", name: "pro-details-range-max", persona: "pro", state: "Range MAX (history bound + unavailable gaps)", viewport: vp, section: "13 Stock Details charts" });
      const canvas = page.locator("canvas").first();
      const box = await canvas.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
        await page.waitForTimeout(300);
        await shot(page, { area: "stocks", name: "pro-details-crosshair", persona: "pro", state: "Crosshair legend", viewport: vp, section: "13 Stock Details charts", fullPage: false });
      }
    });
  }
  for (const [sym, name, state] of [["QATEST2", "qatest2-no-data", "Security with no price data (complete & empty)"], ["NOPE1", "unknown-symbol", "Symbol not in catalog"], ["IBM", "real-symbol-no-local-data", "Real catalog symbol, no local data (fixture provider refuses)"]]) {
    for (const vp of DM) {
      await step(sym, async () => {
        await visit(page, `/stocks/${sym}`, vp, 2500);
        await shot(page, { area: "stocks", name: `pro-details-${name}`, persona: "pro", state, viewport: vp, section: "13 Stock Details / 17 Errors", expectedFailures: [`/stocks/${sym}`] });
      });
    }
  }
  await step("details loading", async () => {
    await page.route(/\/stocks\/QATEST1\?/, hangRoute());
    for (const vp of DM) {
      await visit(page, "/stocks/QATEST1", vp, 500);
      await shot(page, { area: "stocks", name: "pro-details-loading", persona: "pro", state: "GET /stocks/QATEST1 pending (skeleton)", viewport: vp, section: "16 Loading", mocks: ["GET /stocks/QATEST1 hangs"] });
    }
    await page.unroute(/\/stocks\/QATEST1\?/);
    await page.route(/\/stocks\/QATEST1\?/, jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    await visit(page, "/stocks/QATEST1", V.d1440);
    await shot(page, { area: "stocks", name: "pro-details-error", persona: "pro", state: "GET /stocks/QATEST1 → 500", viewport: V.d1440, section: "17 Errors", mocks: ["GET /stocks/QATEST1 → 500"], expectedFailures: ["/stocks/QATEST1"] });
    await page.unroute(/\/stocks\/QATEST1\?/);
  });
  await step("history error", async () => {
    await page.route(/\/stocks\/QATEST1\/prices/, jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    await visit(page, "/stocks/QATEST1", V.d1440, 1200);
    await page.getByText("MAX", { exact: true }).click();
    await page.waitForTimeout(1500);
    await shot(page, { area: "stocks", name: "pro-details-history-error", persona: "pro", state: "Older-history load fails after MAX", viewport: V.d1440, section: "17 Errors", mocks: ["GET /stocks/QATEST1/prices → 500"], expectedFailures: ["/stocks/QATEST1"] });
    await page.unroute(/\/stocks\/QATEST1\/prices/);
    await page.route(/\/stocks\/QATEST1\/prices/, hangRoute());
    await visit(page, "/stocks/QATEST1", V.d1440, 1200);
    await page.getByText("5Y", { exact: true }).click();
    await page.waitForTimeout(600);
    await shot(page, { area: "stocks", name: "pro-details-history-loading", persona: "pro", state: "Older history loading (spinner overlay)", viewport: V.d1440, section: "16 Loading", fullPage: false, mocks: ["GET /stocks/QATEST1/prices hangs"] });
    await page.unroute(/\/stocks\/QATEST1\/prices/);
  });
  for (const vp of DM) {
    await step("stocks placeholder", async () => {
      await visit(page, "/stocks", vp);
      await shot(page, { area: "stocks", name: "pro-stocks-index-placeholder", persona: "pro", state: "/stocks route", viewport: vp, section: "4 Inventory / 12 Search" });
    });
  }
  await ctx.close();
  const gg = await open("guest");
  for (const vp of DM) {
    await step("guest details", async () => {
      await visit(gg.page, "/stocks/QATEST1", vp, 1500);
      await shot(gg.page, { area: "stocks", name: "guest-details-qatest1", persona: "guest", state: "Stock Details as Guest", viewport: vp, section: "13 Stock Details", expectedFailures: g });
    });
  }
  await step("guest recents after view", async () => {
    await visit(gg.page, "/dashboard", V.d1440, 800);
    await gg.page.getByRole("combobox", { name: "Search stocks" }).click();
    await gg.page.waitForTimeout(600);
    await shot(gg.page, { area: "stocks", name: "guest-search-recents-after-view", persona: "guest", state: "Guest after viewing QATEST1: localStorage recents", viewport: V.d1440, section: "12 Search", fullPage: false, expectedFailures: g });
  });
  await gg.ctx.close();
}

// ═════════════════════════════ BILLING / PRICING ═════════════════════════════
console.log("billing");
{
  const { ctx, page } = await open("guest");
  for (const vp of STD) {
    await step("guest pricing", async () => {
      await visit(page, "/pricing", vp);
      await shot(page, { area: "billing", name: "guest-pricing-monthly", persona: "guest", state: "Public pricing, monthly", viewport: vp, section: "14 Billing/pricing", expectedFailures: g });
      await page.getByText("Yearly", { exact: true }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "billing", name: "guest-pricing-yearly", persona: "guest", state: "Public pricing, yearly", viewport: vp, section: "14 Billing/pricing", expectedFailures: g });
    });
  }
  await step("guest choose plan", async () => {
    await visit(page, "/pricing", V.d1440);
    await page.getByTestId("plan-action-PRO").click();
    await page.waitForTimeout(300);
    await shot(page, { area: "billing", name: "guest-pricing-choose-pro-prompt", persona: "guest", state: "Guest presses Choose Pro", viewport: V.d1440, section: "14 Billing / 25 Entitlements", fullPage: false, expectedFailures: g });
  });
  await step("guest billing bounce", async () => {
    await visit(page, "/billing", V.d1440, 1200);
    await shot(page, { area: "billing", name: "guest-billing-redirect", persona: "guest", state: "Guest opens /billing", viewport: V.d1440, section: "14 Billing", expectedFailures: g });
  });
  await ctx.close();
}
for (const persona of ["free-limit", "pro"]) {
  const { ctx, page } = await open(persona);
  for (const vp of STD) {
    await step("real billing", async () => {
      await visit(page, "/billing", vp, 900);
      await shot(page, { area: "billing", name: `${persona}-billing-real`, persona, state: "/billing against the hermetic stack (Stripe inert)", viewport: vp, section: "14 Billing" });
      await visit(page, "/pricing", vp, 900);
      await shot(page, { area: "billing", name: `${persona}-pricing-signed-in`, persona, state: "/pricing signed in", viewport: vp, section: "14 Pricing" });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("pro");
  for (const [key, body] of Object.entries(BILLING)) {
    await page.route(apiUrl("/billing/status"), jsonRoute(body));
    for (const vp of key === "pro-monthly" || key === "free" ? STD : [V.d1440]) {
      await step(`billing ${key}`, async () => {
        await visit(page, "/billing", vp, 900);
        await shot(page, { area: "billing", name: `mock-${key}`, persona: "pro", state: `/billing with status '${key}'`, viewport: vp, section: "14 Billing", mocks: [`GET /billing/status → ${key}`] });
      });
    }
    await page.unroute(apiUrl("/billing/status"));
  }
  await page.route(apiUrl("/billing/status"), jsonRoute(BILLING["starter-monthly"]));
  await step("toggle yearly", async () => {
    await visit(page, "/billing", V.d1440, 900);
    await page.getByText("Yearly", { exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, { area: "billing", name: "mock-starter-monthly-viewing-yearly", persona: "pro", state: "Starter monthly customer toggles Yearly", viewport: V.d1440, section: "14 Billing", mocks: ["GET /billing/status → starter-monthly"] });
  });
  await step("action error", async () => {
    await page.route(apiUrl("/billing/change"), jsonRoute({ statusCode: 503, code: "BILLING_STRIPE_UNAVAILABLE", message: "Billing is temporarily unavailable. Please try again shortly." }, 503));
    await visit(page, "/billing", V.d1440, 900);
    await page.getByTestId("plan-action-PRO").click();
    await page.waitForTimeout(800);
    await shot(page, { area: "billing", name: "mock-upgrade-failed", persona: "pro", state: "Upgrade → POST /billing/change 503", viewport: V.d1440, section: "17 Errors", mocks: ["GET /billing/status → starter-monthly", "POST /billing/change → 503"], expectedFailures: ["/billing/change"] });
    await page.unroute(apiUrl("/billing/change"));
    await page.route(apiUrl("/billing/change"), hangRoute());
    await visit(page, "/billing", V.d1440, 900);
    await page.getByTestId("plan-action-PRO").click();
    await page.waitForTimeout(500);
    await shot(page, { area: "billing", name: "mock-upgrade-pending", persona: "pro", state: "Upgrade in flight ('Working…')", viewport: V.d1440, section: "16 Loading", mocks: ["POST /billing/change hangs"] });
    await page.unroute(apiUrl("/billing/change"));
  });
  await page.unroute(apiUrl("/billing/status"));
  await step("billing loading/error", async () => {
    await page.route(apiUrl("/billing/status"), hangRoute());
    for (const vp of DM) {
      await visit(page, "/billing", vp, 500);
      await shot(page, { area: "billing", name: "mock-loading", persona: "pro", state: "GET /billing/status pending", viewport: vp, section: "16 Loading", mocks: ["GET /billing/status hangs"] });
    }
    await page.unroute(apiUrl("/billing/status"));
    await page.route(apiUrl("/billing/status"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    for (const vp of DM) {
      await visit(page, "/billing", vp);
      await shot(page, { area: "billing", name: "mock-error", persona: "pro", state: "GET /billing/status → 500", viewport: vp, section: "17 Errors", mocks: ["GET /billing/status → 500"], expectedFailures: ["/billing/status"] });
      await visit(page, "/pricing", vp);
      await shot(page, { area: "billing", name: "mock-pricing-status-error", persona: "pro", state: "/pricing signed in, status → 500", viewport: vp, section: "17 Errors", mocks: ["GET /billing/status → 500"], expectedFailures: ["/billing/status"] });
    }
    await page.unroute(apiUrl("/billing/status"));
  });
  await step("checkout returns", async () => {
    await page.route(apiUrl("/billing/status"), jsonRoute(BILLING.free));
    await page.route(apiUrl("/billing/refresh"), jsonRoute(BILLING.free));
    await visit(page, "/billing?checkout=success", V.d1440, 300);
    await shot(page, { area: "billing", name: "mock-checkout-success-settling", persona: "pro", state: "Returned from Checkout, still settling", viewport: V.d1440, section: "14 Billing", mocks: ["status/refresh → free (webhook not yet applied)"] });
    await page.waitForTimeout(10000);
    await shot(page, { area: "billing", name: "mock-checkout-success-window-expired", persona: "pro", state: "Settle window elapsed, still Free — copy claims confirmation", viewport: V.d1440, section: "14 Billing", mocks: ["status/refresh → free"] });
    await visit(page, "/billing?checkout=cancelled", V.d1440);
    await shot(page, { area: "billing", name: "mock-checkout-cancelled", persona: "pro", state: "Returned from Checkout (cancelled)", viewport: V.d1440, section: "14 Billing", mocks: ["GET /billing/status → free"] });
    await page.unroute(apiUrl("/billing/status"));
    await page.unroute(apiUrl("/billing/refresh"));
  });
  await ctx.close();
}

// ═════════════════════════════ ADMIN / FAILURE PAGES ═════════════════════════════
console.log("admin");
{
  const { ctx, page } = await open("master");
  for (const vp of STD) {
    await step("admin", async () => {
      await visit(page, "/admin", vp, 900);
      await shot(page, { area: "admin", name: "master-admin", persona: "master", state: "/admin as ADMIN", viewport: vp, section: "26 Built-in/admin" });
    });
  }
  for (const [area, route] of [["lists", "/lists"], ["strategies", "/strategies"], ["monitors", "/monitors"]]) {
    await step(`master ${area}`, async () => {
      await visit(page, route, V.d1440);
      await page.getByRole("button", { name: /More actions for QA Built-in/ }).first().click();
      await page.waitForTimeout(300);
      await shot(page, { area, name: "master-builtin-row-overflow", persona: "master", state: "Admin: built-in row overflow", viewport: V.d1440, section: "26 Built-in/admin", fullPage: false });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("pro");
  for (const vp of DM) {
    await step("admin denied", async () => {
      await visit(page, "/admin", vp, 1200);
      await shot(page, { area: "admin", name: "pro-admin-access-denied", persona: "pro", state: "Non-admin opens /admin", viewport: vp, section: "26 Admin / 17 Errors" });
    });
    await step("not found", async () => {
      await visit(page, "/this-route-does-not-exist", vp);
      await shot(page, { area: "shell", name: "pro-not-found-page", persona: "pro", state: "Unknown URL", viewport: vp, section: "17 Errors", expectedFailures: ["/this-route-does-not-exist"] });
    });
    await step("root", async () => {
      await visit(page, "/", vp);
      await shot(page, { area: "shell", name: "pro-root-redirect", persona: "pro", state: "/ → redirect", viewport: vp, section: "4 Inventory" });
    });
  }
  await step("session error gate", async () => {
    await page.route(apiUrl("/auth/me"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    for (const vp of DM) {
      await visit(page, "/backtests", vp, 1200);
      await shot(page, { area: "shell", name: "pro-session-check-failed", persona: "pro", state: "GET /auth/me → 500 on a protected route", viewport: vp, section: "17 Errors", mocks: ["GET /auth/me → 500"], expectedFailures: ["/auth/me"] });
    }
    await page.unroute(apiUrl("/auth/me"));
    await page.route(apiUrl("/auth/me"), hangRoute());
    for (const vp of DM) {
      await visit(page, "/backtests", vp, 600);
      await shot(page, { area: "shell", name: "pro-session-checking", persona: "pro", state: "Session still resolving on a protected route", viewport: vp, section: "16 Loading", mocks: ["GET /auth/me hangs"] });
      await visit(page, "/dashboard", vp, 600);
      await shot(page, { area: "shell", name: "pro-session-resolving-dashboard", persona: "pro", state: "Session still resolving on the Dashboard", viewport: vp, section: "16 Loading", mocks: ["GET /auth/me hangs"] });
    }
    await page.unroute(apiUrl("/auth/me"));
  });
  await ctx.close();
  const gg = await open("guest");
  await step("guest not found", async () => {
    await visit(gg.page, "/nope/deeper", V.m390);
    await shot(gg.page, { area: "shell", name: "guest-not-found-page", persona: "guest", state: "Unknown URL as Guest", viewport: V.m390, section: "17 Errors", expectedFailures: ["/nope/deeper", "/auth/me"] });
  });
  await gg.ctx.close();
}

saveManifest();
await browser.close();
