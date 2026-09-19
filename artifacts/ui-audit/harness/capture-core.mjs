// Shell, Dashboard and the four collections, for every persona, plus mocked Dashboard states.
import { launch, personaContext, watch, settle, shot, VIEWPORTS as V, saveManifest, jsonRoute, hangRoute, apiUrl } from "./lib.mjs";
import { dashboardMany, dashboardWith, marketUnavailable, backtestsAllStatuses, backtestsMany } from "./mocks.mjs";

const browser = await launch();
const ALL = [V.d1440, V.d1280, V.t1024, V.b880, V.b879, V.m390];
const STD = [V.d1440, V.t1024, V.m390];
const m375 = { width: 375, height: 812, label: "mobile-375" };

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
const guestOk = (p) => (p === "guest" ? ["/auth/me"] : []);
async function visit(page, route, vp, ms = 700) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await settle(page, ms);
}

// ── Collections & dashboard for every persona ────────────────────────────────
const PERSONA_SET = ["guest", "free-empty", "free-normal", "free-limit", "starter", "starter-limit", "pro", "pro-heavy", "downgraded", "master"];
const ROUTES = [
  ["dashboard", "/dashboard", "11 Dashboard"],
  ["lists", "/lists", "8 Lists"],
  ["strategies", "/strategies", "9 Strategies"],
  ["monitors", "/monitors", "11 Monitors"],
  ["backtests", "/backtests", "10 Backtests"],
];
for (const persona of PERSONA_SET) {
  console.log(persona);
  const { ctx, page } = await open(persona);
  for (const [area, route, section] of ROUTES) {
    const vps = persona === "pro-heavy" || (persona === "pro" && area === "dashboard") ? ALL : STD;
    for (const vp of vps) {
      await step(`${persona} ${route} ${vp.label}`, async () => {
        await visit(page, route, vp, area === "dashboard" ? 1200 : 700);
        await shot(page, { area, name: `${persona}-collection`, persona, state: `${route} as ${persona} (real seeded data)`, viewport: vp, section, expectedFailures: guestOk(persona) });
      });
    }
  }
  await ctx.close();
}

// ── Shell / navigation ──────────────────────────────────────────────────────
{
  const { ctx, page } = await open("pro");
  for (const [route, name] of [["/lists", "nav-active-lists"], ["/strategies/new", "nav-active-strategies-new"], ["/stocks/QATEST1", "nav-on-stock-details"], ["/billing", "nav-on-billing"]]) {
    for (const vp of [V.d1440, V.m390]) {
      await step(name, async () => {
        await visit(page, route, vp);
        await shot(page, { area: "shell", name: `pro-${name}`, persona: "pro", state: `Active nav state on ${route}`, viewport: vp, section: "6 Navigation/shell", fullPage: false });
      });
    }
  }
  for (const vp of [m375, V.m390]) {
    await step("search compact", async () => {
      await visit(page, "/dashboard", vp);
      await shot(page, { area: "shell", name: "pro-topbar-search", persona: "pro", state: `Topbar at ${vp.width}px (search icon-only below 380px)`, viewport: vp, section: "6 Navigation/shell", fullPage: false });
    });
  }
  await step("search expanded 375", async () => {
    await visit(page, "/dashboard", m375);
    await page.getByRole("button", { name: "Search stocks" }).click();
    await page.waitForTimeout(400);
    await shot(page, { area: "shell", name: "pro-topbar-search-expanded", persona: "pro", state: "Compact search expanded at 375px", viewport: m375, section: "6/12 Search", fullPage: false });
  });
  await step("mobile scrolled bottom", async () => {
    await visit(page, "/backtests", V.m390);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    await shot(page, { area: "shell", name: "pro-bottom-nav-scrolled-to-end", persona: "pro", state: "Phone scrolled to the end: bottom nav vs last content", viewport: V.m390, section: "6 Navigation/shell", fullPage: false });
  });
  await ctx.close();
  const g = await open("guest");
  for (const vp of [V.d1440, V.t1024, V.m390]) {
    await step("guest topbar", async () => {
      await visit(g.page, "/strategies", vp);
      await shot(g.page, { area: "shell", name: "guest-topbar", persona: "guest", state: "Guest shell: Pricing + Sign in", viewport: vp, section: "6 Navigation/shell", fullPage: false, expectedFailures: ["/auth/me"] });
    });
  }
  await g.ctx.close();
}

// ── Dashboard mocked states (pro) ──────────────────────────────────────────
{
  const { ctx, page } = await open("pro");
  const states = [
    ["many-signals-buy-sell-exit", "24 rows: BUY/SELL/FINAL EXIT, active+waiting, 4 monitors, repeated securities, long names", () => dashboardMany()],
    ["no-matches", "Monitors shown, no rows", () => dashboardWith({ rows: [] })],
    ["no-monitors-shown", "No monitors shown (all hidden)", () => dashboardWith({ rows: [], monitors: [] })],
    ["stale", "Every monitor STALE (last scan yesterday)", () => dashboardWith({ freshness: "STALE" })],
    ["not-scanned", "Monitors never scanned", () => dashboardWith({ freshness: "NOT_SCANNED", rows: [] })],
  ];
  for (const [name, state, make] of states) {
    const body = make();
    await page.route(apiUrl("/dashboard"), jsonRoute(body));
    for (const vp of name === "many-signals-buy-sell-exit" ? ALL : [V.d1440, V.m390]) {
      await step(name, async () => {
        await visit(page, "/dashboard", vp, 1000);
        await shot(page, { area: "dashboard", name: `pro-${name}`, persona: "pro", state, viewport: vp, section: "11 Dashboard", mocks: ["GET /dashboard (synthetic, derived from real response)"] });
      });
    }
    await page.unroute(apiUrl("/dashboard"));
  }
  // Filters on the many-signals state.
  await page.route(apiUrl("/dashboard"), jsonRoute(dashboardMany()));
  for (const vp of [V.d1440, V.m390]) {
    await step("filters", async () => {
      await visit(page, "/dashboard", vp, 1000);
      await page.getByRole("button", { name: /^Waiting/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "dashboard", name: "pro-filter-waiting", persona: "pro", state: "State filter = Waiting", viewport: vp, section: "11 Dashboard", mocks: ["GET /dashboard (synthetic)"] });
      await page.getByRole("button", { name: /^Waiting/ }).click().catch(() => {});
      await page.getByLabel("Action").selectOption({ label: "Sell" });
      await page.getByRole("button", { name: /^Waiting/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "dashboard", name: "pro-filter-sell-waiting-empty", persona: "pro", state: "Action=Sell + Waiting → filtered-empty", viewport: vp, section: "11/15 Dashboard empty", mocks: ["GET /dashboard (synthetic)"] });
    });
  }
  await page.unroute(apiUrl("/dashboard"));
  // Loading, error, market overview unavailable / slow.
  await step("loading", async () => {
    await page.route(apiUrl("/dashboard"), hangRoute());
    await page.route(apiUrl("/market-overview"), hangRoute());
    for (const vp of [V.d1440, V.m390]) {
      await visit(page, "/dashboard", vp, 500);
      await shot(page, { area: "dashboard", name: "pro-loading", persona: "pro", state: "GET /dashboard and /market-overview pending", viewport: vp, section: "16 Loading", mocks: ["GET /dashboard hangs", "GET /market-overview hangs"] });
    }
    await page.unroute(apiUrl("/dashboard"));
    await page.unroute(apiUrl("/market-overview"));
  });
  await step("error", async () => {
    await page.route(apiUrl("/dashboard"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    await page.route(apiUrl("/market-overview"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    for (const vp of [V.d1440, V.m390]) {
      await visit(page, "/dashboard", vp, 800);
      await shot(page, { area: "dashboard", name: "pro-error", persona: "pro", state: "GET /dashboard and /market-overview → 500", viewport: vp, section: "17 Errors", mocks: ["GET /dashboard → 500", "GET /market-overview → 500"], expectedFailures: ["/dashboard", "/market-overview"] });
    }
    await page.unroute(apiUrl("/dashboard"));
    await page.unroute(apiUrl("/market-overview"));
  });
  await step("market unavailable", async () => {
    await page.route(apiUrl("/market-overview"), jsonRoute(marketUnavailable()));
    for (const vp of [V.d1440, V.m390]) {
      await visit(page, "/dashboard", vp, 800);
      await shot(page, { area: "dashboard", name: "pro-market-unavailable", persona: "pro", state: "Market overview items UNAVAILABLE", viewport: vp, section: "11 Dashboard / 17 Errors", mocks: ["GET /market-overview → all UNAVAILABLE"] });
    }
    await page.unroute(apiUrl("/market-overview"));
  });
  await step("malformed dashboard", async () => {
    await page.route(apiUrl("/dashboard"), jsonRoute({ unexpected: true }));
    await visit(page, "/dashboard", V.d1440, 800);
    await shot(page, { area: "dashboard", name: "pro-malformed-response", persona: "pro", state: "GET /dashboard returns an unexpected shape (render failure → error boundary)", viewport: V.d1440, section: "17 Errors", mocks: ["GET /dashboard → {unexpected:true}"] });
    await page.unroute(apiUrl("/dashboard"));
  });
  // Backtests collection mocked densities / statuses.
  await step("backtests statuses", async () => {
    await page.route(apiUrl("/backtests"), jsonRoute(backtestsAllStatuses()));
    for (const vp of [V.d1440, V.m390]) {
      await visit(page, "/backtests", vp);
      await shot(page, { area: "backtests", name: "pro-collection-every-status", persona: "pro", state: "One run in each status (QUEUED…FAILED)", viewport: vp, section: "10 Backtests", mocks: ["GET /backtests (synthetic, from real rows)"] });
    }
    await page.unroute(apiUrl("/backtests"));
    await page.route(apiUrl("/backtests"), jsonRoute(backtestsMany(60)));
    for (const vp of [V.d1440, V.m390]) {
      await visit(page, "/backtests", vp);
      await shot(page, { area: "backtests", name: "pro-collection-60-runs", persona: "pro", state: "60 runs, long strategy name, extreme returns", viewport: vp, section: "18 Density", mocks: ["GET /backtests (synthetic, 60 rows)"] });
    }
    await page.unroute(apiUrl("/backtests"));
  });
  // Collection loading/error for each resource.
  for (const [area, route, path] of [["lists", "/lists", "/lists"], ["strategies", "/strategies", "/strategies"], ["monitors", "/monitors", "/monitors"], ["backtests", "/backtests", "/backtests"]]) {
    await step(`${area} loading/error`, async () => {
      await page.route(apiUrl(path), hangRoute());
      for (const vp of [V.d1440, V.m390]) {
        await visit(page, route, vp, 400);
        await shot(page, { area, name: "pro-collection-loading", persona: "pro", state: `GET ${path} pending`, viewport: vp, section: "16 Loading", mocks: [`GET ${path} hangs`] });
      }
      await page.unroute(apiUrl(path));
      await page.route(apiUrl(path), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
      for (const vp of [V.d1440, V.m390]) {
        await visit(page, route, vp, 600);
        await shot(page, { area, name: "pro-collection-error", persona: "pro", state: `GET ${path} → 500`, viewport: vp, section: "17 Errors", mocks: [`GET ${path} → 500`], expectedFailures: [path] });
      }
      await page.unroute(apiUrl(path));
    });
  }
  await ctx.close();
}

// Guest collections error (the "Your …" wording is shown to guests too).
{
  const { ctx, page } = await open("guest");
  await page.route(apiUrl("/lists"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
  await step("guest lists error", async () => {
    await visit(page, "/lists", V.d1440);
    await shot(page, { area: "lists", name: "guest-collection-error", persona: "guest", state: "GET /lists → 500 as a Guest", viewport: V.d1440, section: "17 Errors", mocks: ["GET /lists → 500"], expectedFailures: ["/lists", "/auth/me"] });
  });
  await ctx.close();
}

saveManifest();
await browser.close();
