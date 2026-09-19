// Re-runs steps whose first attempt hit harness bugs (detail mocks must be anchored to the API
// origin, not the web route), plus targeted evidence captures for confirmed layout defects.
import { launch, personaContext, watch, settle, shot, VIEWPORTS as V, saveManifest, jsonRoute, hangRoute, apiUrl } from "./lib.mjs";
import { apiAs } from "./api.mjs";
import { monitorDetailMany, monitorDetailEmpty, dashboardMany, marketUnavailable } from "./mocks.mjs";

const browser = await launch();
const DM = [V.d1440, V.m390];
async function open(persona) {
  const ctx = await personaContext(browser, persona);
  const page = await ctx.newPage();
  watch(page);
  page.on("dialog", (d) => d.dismiss());
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
async function rows(persona, path) {
  const a = await apiAs(persona);
  const r = await a.get(path);
  await a.dispose();
  return r;
}
const addPicker = (page) => page.getByRole("combobox", { name: "Search stocks to add to this list" });

// ── Lists: add-stocks picker, over-limit add, detail loading/error ──
{
  const { ctx, page } = await open("starter");
  const pair = (await rows("starter", "/lists")).find((l) => l.name === "QA pair");
  for (const vp of DM) {
    await step("add stocks picker in detail", async () => {
      await visit(page, `/lists/${pair.id}`, vp);
      await addPicker(page).fill("QATEST");
      await page.waitForTimeout(900);
      await shot(page, { area: "pickers", name: "starter-add-stocks-in-list-markers", persona: "starter", state: "Add stocks: members shown as 'In list'", viewport: vp, section: "7 Pickers / 8 Lists", fullPage: false });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("free-limit");
  const atLimit = (await rows("free-limit", "/lists")).find((l) => l.name === "ENT-Free At Limit");
  for (const vp of DM) {
    await step("add over limit", async () => {
      await visit(page, `/lists/${atLimit.id}`, vp);
      await addPicker(page).fill("QATEST1");
      await page.waitForTimeout(900);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      await addPicker(page).scrollIntoViewIfNeeded();
      await shot(page, { area: "lists", name: "free-limit-at-10-before-add", persona: "free-limit", state: "List at 10/10 with an 11th stock selected: no warning, Add enabled", viewport: vp, section: "25 Entitlements", fullPage: false });
      await page.getByRole("button", { name: /^Add/ }).click();
      await page.waitForTimeout(900);
      await shot(page, { area: "lists", name: "free-limit-add-refused", persona: "free-limit", state: "Add → real 403 ENTITLEMENT_LIST_SYMBOL_LIMIT (nothing written)", viewport: vp, section: "25 Entitlements", fullPage: false, expectedFailures: ["/items"] });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("pro-heavy");
  const long = (await rows("pro-heavy", "/lists")).find((l) => /^Global dividend/.test(l.name));
  const detail = apiUrl(`/lists/${long.id}`);
  await step("list detail loading/error", async () => {
    await page.route(detail, hangRoute());
    await visit(page, `/lists/${long.id}`, V.d1440, 400);
    await shot(page, { area: "lists", name: "pro-heavy-list-detail-loading", persona: "pro-heavy", state: "GET /lists/:id pending", viewport: V.d1440, section: "16 Loading", mocks: ["GET /lists/:id hangs"] });
    await page.unroute(detail);
    await page.route(detail, jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    await visit(page, `/lists/${long.id}`, V.d1440);
    await shot(page, { area: "lists", name: "pro-heavy-list-detail-error", persona: "pro-heavy", state: "GET /lists/:id → 500", viewport: V.d1440, section: "17 Errors", mocks: ["GET /lists/:id → 500"], expectedFailures: ["/lists/"] });
    await page.unroute(detail);
  });
  // ── Monitors: dense, empty, loading, overflow, delete confirm, edit/rebind ──
  const mons = await rows("pro-heavy", "/monitors");
  const own = mons.find((m) => m.ownership === "USER" && m.name === "Ladder · long list");
  const mUrl = apiUrl(`/monitors/${own.id}`);
  await step("dense mocked", async () => {
    await page.route(mUrl, jsonRoute({ ...monitorDetailMany(), id: own.id, ownership: "USER", canEdit: true, name: own.name, systemKey: undefined }));
    for (const vp of [V.d1440, V.t1024, V.m390]) {
      await visit(page, `/monitors/${own.id}`, vp, 900);
      await shot(page, { area: "monitors", name: "pro-heavy-monitor-detail-dense", persona: "pro-heavy", state: "30 securities in all 5 statuses, 100 signals incl. ended ones", viewport: vp, section: "11 Monitors / 18 Density", mocks: ["GET /monitors/:id (synthetic, from real built-in response)"] });
    }
    await page.unroute(mUrl);
    await page.route(mUrl, jsonRoute({ ...monitorDetailEmpty(), id: own.id, ownership: "USER", canEdit: true, name: own.name, systemKey: undefined }));
    for (const vp of DM) {
      await visit(page, `/monitors/${own.id}`, vp, 900);
      await shot(page, { area: "monitors", name: "pro-heavy-monitor-detail-empty", persona: "pro-heavy", state: "Monitor whose list is empty and never scanned", viewport: vp, section: "11 Monitors / 15 Empty", mocks: ["GET /monitors/:id (synthetic empty)"] });
    }
    await page.unroute(mUrl);
    await page.route(mUrl, hangRoute());
    await visit(page, `/monitors/${own.id}`, V.d1440, 400);
    await shot(page, { area: "monitors", name: "pro-heavy-monitor-detail-loading", persona: "pro-heavy", state: "GET /monitors/:id pending", viewport: V.d1440, section: "16 Loading", mocks: ["GET /monitors/:id hangs"] });
    await page.unroute(mUrl);
  });
  for (const vp of DM) {
    await step("monitor overflow + delete confirm", async () => {
      await visit(page, `/monitors/${own.id}`, vp, 900);
      await page.getByRole("button", { name: /More actions for/ }).first().click();
      await page.waitForTimeout(300);
      await shot(page, { area: "monitors", name: "pro-heavy-detail-overflow-open", persona: "pro-heavy", state: "Monitor header overflow open", viewport: vp, section: "19 Interaction", fullPage: false });
      await page.getByText("Delete monitor", { exact: true }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "monitors", name: "pro-heavy-delete-confirm", persona: "pro-heavy", state: "Delete monitor confirmation", viewport: vp, section: "19 Interaction", fullPage: false });
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    });
    await step("edit dialog rebind", async () => {
      await visit(page, `/monitors/${own.id}`, vp, 900);
      await page.getByRole("button", { name: "Edit monitor" }).click();
      await page.waitForTimeout(1500);
      await shot(page, { area: "monitors", name: "pro-heavy-edit-dialog", persona: "pro-heavy", state: "Edit monitor dialog", viewport: vp, section: "11 Monitors / 7 Pickers", fullPage: false });
      const dialog = page.getByRole("dialog");
      const info = await dialog.getByLabel("Strategy").evaluate((s) => `${s.options.length} options, optgroups=${s.querySelectorAll("optgroup").length}`);
      console.log("    monitor strategy select:", info);
      await dialog.getByLabel("Strategy").selectOption({ index: 3 });
      await page.waitForTimeout(300);
      await shot(page, { area: "monitors", name: "pro-heavy-edit-dialog-rebind-note", persona: "pro-heavy", state: "Strategy changed → rebind note", viewport: vp, section: "11 Monitors", fullPage: false });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
  }
  // ── Evidence: collection tables pushed wide by one long chip name ──
  for (const [route, area] of [["/backtests", "backtests"], ["/monitors", "monitors"]]) {
    await step(`wide table ${route}`, async () => {
      await visit(page, route, V.d1440, 900);
      await page.locator("[class*=DataTable][class*=scroll]").first().evaluate((el) => el.scrollTo(el.scrollWidth, 0));
      await page.waitForTimeout(300);
      await shot(page, { area, name: "pro-heavy-collection-table-scrolled-right", persona: "pro-heavy", state: "Same table scrolled horizontally inside its surface to reveal the Actions column", viewport: V.d1440, section: "18 Density / 5 Responsive", fullPage: false });
    });
  }
  await ctx.close();
}
{
  // ── Evidence: phone Dashboard page scrolls sideways with a long monitor name ──
  const { ctx, page } = await open("pro");
  await page.route(apiUrl("/dashboard"), jsonRoute(dashboardMany()));
  await step("dashboard sideways", async () => {
    await visit(page, "/dashboard", V.m390, 1000);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    await page.evaluate(() => window.scrollTo(document.documentElement.scrollWidth, 900));
    await page.waitForTimeout(300);
    console.log("    dashboard phone scrollWidth:", sw);
    await shot(page, { area: "dashboard", name: "pro-many-signals-scrolled-sideways", persona: "pro", state: `Phone page scrolled right (document ${sw}px wide at 390px)`, viewport: V.m390, section: "5 Responsive", fullPage: false, mocks: ["GET /dashboard (synthetic)"] });
  });
  await page.unroute(apiUrl("/dashboard"));
  await page.route(apiUrl("/market-overview"), jsonRoute(marketUnavailable()));
  for (const vp of DM) {
    await step("market unavailable", async () => {
      await visit(page, "/dashboard", vp, 800);
      await shot(page, { area: "dashboard", name: "pro-market-unavailable", persona: "pro", state: "Market overview items UNAVAILABLE (contract-true)", viewport: vp, section: "11 Dashboard / 17 Errors", mocks: ["GET /market-overview → all UNAVAILABLE, sparkline []"] });
    });
  }
  await page.unroute(apiUrl("/market-overview"));
  await ctx.close();
}

saveManifest();
await browser.close();
