// Sections 10–11: Backtests (new form, running, completed, failed, queued) and Monitors (detail,
// dialogs, blocked, dense). Submissions are either refused by the real API or never sent.
import { launch, personaContext, watch, settle, shot, VIEWPORTS as V, saveManifest, jsonRoute, hangRoute, apiUrl } from "./lib.mjs";
import { apiAs } from "./api.mjs";
import { fx, backtestQueued, monitorDetailMany, monitorDetailEmpty } from "./mocks.mjs";

const browser = await launch();
const ALL = [V.d1440, V.d1280, V.t1024, V.b880, V.b879, V.m390];
const STD = [V.d1440, V.t1024, V.m390];
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

// ═════════════════════════════ BACKTESTS ═════════════════════════════
console.log("backtests");
{
  const { ctx, page } = await open("pro-heavy");
  for (const vp of ALL) {
    await step("new form", async () => {
      await visit(page, "/backtests/new", vp, 900);
      await shot(page, { area: "backtests", name: "pro-heavy-new-initial", persona: "pro-heavy", state: "New backtest, initial state (defaults)", viewport: vp, section: "10 Backtests" });
    });
  }
  for (const vp of DM) {
    await step("new validation", async () => {
      await visit(page, "/backtests/new", vp, 900);
      await page.getByLabel("Start date").fill("");
      await page.getByLabel("Initial capital").fill("0");
      await page.getByLabel("Maximum positions").fill("150");
      await page.getByRole("button", { name: "Run backtest" }).click();
      await page.waitForTimeout(400);
      await shot(page, { area: "backtests", name: "pro-heavy-new-validation", persona: "pro-heavy", state: "Run pressed with nothing selected + invalid numbers (focus stays on button)", viewport: vp, section: "10 Backtests" });
      const focused = await page.evaluate(() => document.activeElement?.textContent || document.activeElement?.tagName);
      console.log("    focus after invalid submit:", focused);
    });
    await step("new strategy options", async () => {
      await visit(page, "/backtests/new", vp, 900);
      const groups = await page.getByLabel("Strategy").evaluate((s) => [...s.querySelectorAll("optgroup")].map((g) => `${g.label} (${g.querySelectorAll("option").length})`));
      console.log("    strategy optgroups:", JSON.stringify(groups));
      const lists = await page.getByLabel("Stock list").evaluate((s) => [...s.options].slice(0, 6).map((o) => o.textContent));
      console.log("    list options (first 6):", JSON.stringify(lists));
    });
  }
  const strategies = await rows("pro-heavy", "/strategies");
  const lists = await rows("pro-heavy", "/lists");
  const s = strategies.find((x) => x.name === "Trend confirmation");
  const l = lists.find((x) => /^Global dividend/.test(x.name));
  for (const vp of DM) {
    await step("prefilled", async () => {
      await visit(page, `/backtests/new?strategyId=${s.id}&stockListId=${l.id}`, vp, 900);
      await page.getByTestId("backtest-start-max").click().catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, { area: "backtests", name: "pro-heavy-new-prefilled-max", persona: "pro-heavy", state: "Prefilled via ?strategyId&stockListId, MAX pressed (30 years)", viewport: vp, section: "10 Backtests" });
    });
  }
  await step("new loading", async () => {
    await page.route(apiUrl("/benchmarks"), hangRoute());
    for (const vp of DM) {
      await visit(page, "/backtests/new", vp, 500);
      await shot(page, { area: "backtests", name: "pro-heavy-new-loading", persona: "pro-heavy", state: "Options loading (GET /benchmarks pending)", viewport: vp, section: "16 Loading", mocks: ["GET /benchmarks hangs"] });
    }
    await page.unroute(apiUrl("/benchmarks"));
  });
  await step("new error", async () => {
    await page.route(apiUrl("/strategies"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    for (const vp of DM) {
      await visit(page, "/backtests/new", vp);
      await shot(page, { area: "backtests", name: "pro-heavy-new-load-error", persona: "pro-heavy", state: "GET /strategies → 500 on the form", viewport: vp, section: "17 Errors", mocks: ["GET /strategies → 500"], expectedFailures: ["/strategies"] });
    }
    await page.unroute(apiUrl("/strategies"));
  });
  await step("submit processing", async () => {
    await page.route(apiUrl("/backtests"), async (route) => (route.request().method() === "POST" ? new Promise(() => {}) : route.continue()));
    await visit(page, `/backtests/new?strategyId=${s.id}&stockListId=${l.id}`, V.m390, 900);
    await page.getByRole("button", { name: "Run backtest" }).click();
    await page.waitForTimeout(500);
    await shot(page, { area: "backtests", name: "pro-heavy-new-submitting", persona: "pro-heavy", state: "Submit in flight (POST mocked to hang; nothing sent)", viewport: V.m390, section: "16 Loading", fullPage: false, mocks: ["POST /backtests hangs"] });
    await page.unroute(apiUrl("/backtests"));
  });
  const runs = await rows("pro-heavy", "/backtests");
  const done = runs.filter((r) => r.status === "COMPLETED");
  const failed = runs.filter((r) => r.status === "FAILED");
  const richest = done[done.length - 1]; // oldest completed = 3-year ladder with contributions
  for (const vp of ALL) {
    await step("result completed", async () => {
      await visit(page, `/backtests/${richest.id}`, vp, 1500);
      await shot(page, { area: "backtests", name: "pro-heavy-result-completed", persona: "pro-heavy", state: "Completed result (3y, contributions)", viewport: vp, section: "10 Backtests" });
    });
  }
  for (const vp of DM) {
    await step("result config expanded + hover", async () => {
      await visit(page, `/backtests/${richest.id}`, vp, 1500);
      await page.getByText("Run configuration").click();
      await page.waitForTimeout(300);
      await shot(page, { area: "backtests", name: "pro-heavy-result-configuration-expanded", persona: "pro-heavy", state: "Run configuration disclosure opened", viewport: vp, section: "10 Backtests" });
      const canvas = page.locator("[data-testid=backtest-hero] canvas").first();
      const box = await canvas.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
        await page.waitForTimeout(300);
        await shot(page, { area: "backtests", name: "pro-heavy-result-chart-crosshair", persona: "pro-heavy", state: "Chart crosshair legend", viewport: vp, section: "10 Backtests charts", fullPage: false });
      }
    });
  }
  for (const r of done.slice(0, 5)) {
    await step("other results", async () => {
      await visit(page, `/backtests/${r.id}`, V.d1440, 1200);
      await shot(page, { area: "backtests", name: `pro-heavy-result-${r.id.slice(0, 8)}`, persona: "pro-heavy", state: `Completed: ${r.strategyName} (${r.startDate}→${r.endDate}, trades vary)`, viewport: V.d1440, section: "10 Backtests" });
    });
  }
  for (const [i, r] of failed.entries()) {
    for (const vp of DM) {
      await step("result failed", async () => {
        await visit(page, `/backtests/${r.id}`, vp, 1200);
        await shot(page, { area: "backtests", name: `pro-heavy-result-failed-${i + 1}`, persona: "pro-heavy", state: `Failed run (${r.stockListName})`, viewport: vp, section: "10 Backtests / 17 Errors" });
      });
    }
  }
  await step("queued mock", async () => {
    const q = backtestQueued();
    await page.route(apiUrl(`/backtests/${q.id}(/progress)?`), jsonRoute(q));
    for (const vp of DM) {
      await visit(page, `/backtests/${q.id}`, vp, 1200);
      await shot(page, { area: "backtests", name: "pro-heavy-result-queued", persona: "pro-heavy", state: "Queued run (mocked from the real running run)", viewport: vp, section: "10 Backtests", mocks: ["GET /backtests/:id(+/progress) → QUEUED"] });
    }
    await page.unroute(apiUrl(`/backtests/${q.id}(/progress)?`));
  });
  await step("result not found", async () => {
    await visit(page, "/backtests/00000000-0000-4000-8000-000000000000", V.d1440);
    await shot(page, { area: "backtests", name: "pro-heavy-result-not-found", persona: "pro-heavy", state: "Unknown run id", viewport: V.d1440, section: "17 Errors", expectedFailures: ["/backtests/"] });
  });
  await ctx.close();
}
{
  // free-limit: its only slot is held by the pinned RUNNING run → real in-flight view + refusal.
  const { ctx, page } = await open("free-limit");
  const run = (await rows("free-limit", "/backtests"))[0];
  for (const vp of STD) {
    await step("running", async () => {
      await visit(page, `/backtests/${run.id}`, vp, 1500);
      await shot(page, { area: "backtests", name: "free-limit-result-running", persona: "free-limit", state: "Running at 42% (pinned fixture run, polled each second)", viewport: vp, section: "10 Backtests" });
    });
  }
  for (const vp of DM) {
    await step("concurrency refused", async () => {
      await visit(page, "/backtests/new", vp, 900);
      await page.getByLabel("Strategy").selectOption({ index: 1 });
      await page.getByLabel("Stock list").selectOption({ index: 1 });
      await page.getByRole("button", { name: "Run backtest" }).click();
      await page.waitForTimeout(1200);
      await shot(page, { area: "backtests", name: "free-limit-new-concurrency-refused", persona: "free-limit", state: "Submit while a run is in flight → real 403 (nothing created)", viewport: vp, section: "25 Entitlements", expectedFailures: ["/backtests"] });
    });
  }
  await ctx.close();
}
{
  // free-normal: MAX (30y) on a Free plan → real history refusal (nothing created).
  const { ctx, page } = await open("free-normal");
  for (const vp of DM) {
    await step("history refused", async () => {
      await visit(page, "/backtests/new", vp, 900);
      await page.getByLabel("Strategy").selectOption({ label: "My trend follower" });
      await page.getByLabel("Stock list").selectOption({ label: "Core research" });
      await page.getByTestId("backtest-start-max").click();
      await page.getByRole("button", { name: "Run backtest" }).click();
      await page.waitForTimeout(1200);
      await shot(page, { area: "backtests", name: "free-normal-new-history-limit-refused", persona: "free-normal", state: "MAX (30y) on Free → real 403 history limit", viewport: vp, section: "25 Entitlements", expectedFailures: ["/backtests"] });
    });
  }
  const r = (await rows("free-normal", "/backtests")).find((x) => x.status === "COMPLETED");
  for (const vp of DM) {
    await step("free result", async () => {
      await visit(page, `/backtests/${r.id}`, vp, 1500);
      await shot(page, { area: "backtests", name: "free-normal-result-completed", persona: "free-normal", state: "Completed 2-year result (Free)", viewport: vp, section: "10 Backtests" });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("free-empty");
  for (const vp of DM) {
    await step("free-empty new", async () => {
      await visit(page, "/backtests/new", vp, 900);
      await shot(page, { area: "backtests", name: "free-empty-new-initial", persona: "free-empty", state: "New backtest with no own content (built-ins available)", viewport: vp, section: "10 Backtests / 15 Empty" });
    });
  }
  await step("free-empty prerequisites", async () => {
    await page.route(apiUrl("/strategies"), jsonRoute([]));
    await page.route(apiUrl("/lists"), jsonRoute([]));
    for (const vp of DM) {
      await visit(page, "/backtests/new", vp, 900);
      await shot(page, { area: "backtests", name: "free-empty-new-prerequisites-missing", persona: "free-empty", state: "No strategies or lists at all → prerequisites notice", viewport: vp, section: "10 Backtests / 15 Empty", mocks: ["GET /strategies → []", "GET /lists → []"] });
    }
    await page.unroute(apiUrl("/strategies"));
    await page.unroute(apiUrl("/lists"));
  });
  await ctx.close();
}
{
  const { ctx, page } = await open("downgraded");
  const run = (await rows("downgraded", "/backtests"))[0];
  for (const vp of DM) {
    await step("historic", async () => {
      await visit(page, `/backtests/${run.id}`, vp, 1200);
      await shot(page, { area: "backtests", name: "downgraded-result-historic-summary-only", persona: "downgraded", state: "Completed 20-year run with summary but no curve/trades (fixture)", viewport: vp, section: "10 Backtests / 25 Entitlements" });
    });
  }
  await ctx.close();
}

// ═════════════════════════════ MONITORS ═════════════════════════════
console.log("monitors");
{
  const { ctx, page } = await open("pro-heavy");
  const mons = await rows("pro-heavy", "/monitors");
  const own = mons.find((m) => m.ownership === "USER" && m.name === "Ladder · long list");
  const longM = mons.find((m) => /very long name/.test(m.name));
  for (const vp of STD) {
    await step("own detail", async () => {
      await visit(page, `/monitors/${own.id}`, vp, 900);
      await shot(page, { area: "monitors", name: "pro-heavy-own-monitor-detail", persona: "pro-heavy", state: "Own monitor detail (worker: not evaluable on fixture data)", viewport: vp, section: "11 Monitors" });
    });
    await step("long detail", async () => {
      await visit(page, `/monitors/${longM.id}`, vp, 900);
      await shot(page, { area: "monitors", name: "pro-heavy-long-name-monitor-detail", persona: "pro-heavy", state: "Monitor with a 120-char name over a 100-stock list", viewport: vp, section: "18 Density" });
    });
  }
  await step("dense mocked", async () => {
    const dense = monitorDetailMany();
    await page.route(apiUrl(`/monitors/${own.id}`), jsonRoute({ ...dense, id: own.id, ownership: "USER", canEdit: true, name: own.name }));
    for (const vp of [V.d1440, V.t1024, V.m390]) {
      await visit(page, `/monitors/${own.id}`, vp, 900);
      await shot(page, { area: "monitors", name: "pro-heavy-monitor-detail-dense", persona: "pro-heavy", state: "30 securities in all 5 statuses, 100 signals incl. ended ones", viewport: vp, section: "11 Monitors / 18 Density", mocks: ["GET /monitors/:id (synthetic, from real built-in response)"] });
    }
    await page.unroute(apiUrl(`/monitors/${own.id}`));
    await page.route(apiUrl(`/monitors/${own.id}`), jsonRoute({ ...monitorDetailEmpty(), id: own.id, ownership: "USER", canEdit: true, name: own.name }));
    for (const vp of DM) {
      await visit(page, `/monitors/${own.id}`, vp, 900);
      await shot(page, { area: "monitors", name: "pro-heavy-monitor-detail-empty", persona: "pro-heavy", state: "Monitor whose list is empty and never scanned", viewport: vp, section: "11 Monitors / 15 Empty", mocks: ["GET /monitors/:id (synthetic empty)"] });
    }
    await page.unroute(apiUrl(`/monitors/${own.id}`));
    await page.route(apiUrl(`/monitors/${own.id}`), hangRoute());
    await visit(page, `/monitors/${own.id}`, V.d1440, 400);
    await shot(page, { area: "monitors", name: "pro-heavy-monitor-detail-loading", persona: "pro-heavy", state: "GET /monitors/:id pending", viewport: V.d1440, section: "16 Loading", mocks: ["GET /monitors/:id hangs"] });
    await page.unroute(apiUrl(`/monitors/${own.id}`));
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
      await page.waitForTimeout(1200);
      await shot(page, { area: "monitors", name: "pro-heavy-edit-dialog", persona: "pro-heavy", state: "Edit monitor dialog", viewport: vp, section: "11 Monitors / 7 Pickers", fullPage: false });
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Strategy").selectOption({ index: 3 });
      await page.waitForTimeout(300);
      await shot(page, { area: "monitors", name: "pro-heavy-edit-dialog-rebind-note", persona: "pro-heavy", state: "Strategy changed → rebind note", viewport: vp, section: "11 Monitors", fullPage: false });
      const optCount = await dialog.getByLabel("Strategy").evaluate((s) => `${s.options.length} options, optgroups=${s.querySelectorAll("optgroup").length}`);
      console.log("    monitor strategy select:", optCount);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("starter");
  for (const vp of DM) {
    await step("new monitor dialog", async () => {
      await page.route(apiUrl("/strategies"), async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
      await visit(page, "/monitors", vp, 900);
      await page.getByRole("button", { name: "New monitor" }).first().click();
      await page.waitForTimeout(500);
      await shot(page, { area: "monitors", name: "starter-new-monitor-loading", persona: "starter", state: "New monitor dialog: options loading on open", viewport: vp, section: "7 Pickers / 16 Loading", fullPage: false, mocks: ["GET /strategies delayed 2.5s"] });
      await page.waitForTimeout(3000);
      await page.unroute(apiUrl("/strategies"));
      await shot(page, { area: "monitors", name: "starter-new-monitor-dialog", persona: "starter", state: "New monitor dialog loaded", viewport: vp, section: "11 Monitors", fullPage: false });
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: /Create monitor/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "monitors", name: "starter-new-monitor-validation", persona: "starter", state: "Create pressed empty", viewport: vp, section: "11 Monitors", fullPage: false });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
    await step("new monitor options error", async () => {
      await page.route(apiUrl("/lists"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
      await visit(page, "/monitors", vp, 900);
      await page.getByRole("button", { name: "New monitor" }).first().click();
      await page.waitForTimeout(900);
      await shot(page, { area: "monitors", name: "starter-new-monitor-options-error", persona: "starter", state: "Dialog options GET /lists → 500", viewport: vp, section: "17 Errors", fullPage: false, mocks: ["GET /lists → 500"], expectedFailures: ["/lists"] });
      await page.unroute(apiUrl("/lists"));
      await page.keyboard.press("Escape");
    });
    await step("row overflow", async () => {
      await visit(page, "/monitors", vp, 900);
      await page.getByRole("button", { name: /More actions for Value ladder/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "monitors", name: "starter-row-overflow-open", persona: "starter", state: "Monitor row overflow (Disable / Edit / Delete)", viewport: vp, section: "19 Interaction", fullPage: false });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("free-limit");
  for (const vp of DM) {
    await step("free-limit create refused", async () => {
      await visit(page, "/monitors", vp, 900);
      await page.getByRole("button", { name: "New monitor" }).first().click();
      await page.waitForTimeout(1200);
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Audit second monitor");
      await dialog.getByLabel("Strategy").selectOption({ index: 1 });
      await dialog.getByLabel("Stock list").selectOption({ index: 1 });
      await dialog.getByRole("button", { name: /Create monitor/ }).click();
      await page.waitForTimeout(1200);
      await shot(page, { area: "monitors", name: "free-limit-new-monitor-refused", persona: "free-limit", state: "2nd active monitor on Free → real 403 (nothing created)", viewport: vp, section: "25 Entitlements", fullPage: false, expectedFailures: ["/monitors"] });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("free-empty");
  for (const vp of DM) {
    await step("free-empty new monitor", async () => {
      await visit(page, "/monitors", vp, 900);
      await page.getByRole("button", { name: "New monitor" }).first().click();
      await page.waitForTimeout(1200);
      await shot(page, { area: "monitors", name: "free-empty-new-monitor-prerequisites", persona: "free-empty", state: "No own strategy or list → prerequisites dialog", viewport: vp, section: "11 Monitors / 15 Empty", fullPage: false });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("guest");
  const mons = await rows("pro", "/monitors");
  const b = mons.find((m) => m.name === "QA Built-in Monitor B");
  for (const vp of STD) {
    await step("guest builtin monitor", async () => {
      await visit(page, `/monitors/${b.id}`, vp, 900);
      await shot(page, { area: "monitors", name: "guest-builtin-monitor-detail", persona: "guest", state: "Built-in monitor detail as Guest", viewport: vp, section: "11 Monitors / 26 Built-ins", expectedFailures: ["/auth/me"] });
    });
  }
  await step("guest visibility switch", async () => {
    await visit(page, "/monitors", V.d1440, 900);
    await page.getByRole("switch").first().click();
    await page.waitForTimeout(300);
    await shot(page, { area: "monitors", name: "guest-visibility-switch-prompt", persona: "guest", state: "Guest toggles 'On my dashboard'", viewport: V.d1440, section: "25 Entitlements", fullPage: false, expectedFailures: ["/auth/me"] });
  });
  await step("monitor not found", async () => {
    await visit(page, "/monitors/00000000-0000-4000-8000-000000000000", V.d1440);
    await shot(page, { area: "monitors", name: "guest-monitor-not-found", persona: "guest", state: "Unknown monitor id", viewport: V.d1440, section: "17 Errors", expectedFailures: ["/auth/me", "/monitors/"] });
  });
  await ctx.close();
}
{
  const { ctx, page } = await open("downgraded");
  const mons = (await rows("downgraded", "/monitors")).filter((m) => m.ownership === "USER");
  for (const m of mons.slice(0, 2)) {
    for (const vp of DM) {
      await step("blocked monitor", async () => {
        await visit(page, `/monitors/${m.id}`, vp, 900);
        await shot(page, { area: "monitors", name: `downgraded-blocked-${m.operationalStatus?.toLowerCase()}-${m.id.slice(0, 6)}`, persona: "downgraded", state: `Blocked monitor (${m.name})`, viewport: vp, section: "25 Entitlements" });
      });
    }
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("master");
  const mons = await rows("master", "/monitors");
  const b = mons.find((m) => m.name === "QA Built-in Monitor A");
  for (const vp of DM) {
    await step("master builtin monitor", async () => {
      await visit(page, `/monitors/${b.id}`, vp, 900);
      await page.getByRole("button", { name: /More actions for/ }).first().click();
      await page.waitForTimeout(300);
      await shot(page, { area: "monitors", name: "master-builtin-monitor-admin-menu", persona: "master", state: "Admin on built-in monitor: Pause for everyone / Unpublish", viewport: vp, section: "26 Built-in/admin" });
    });
  }
  await ctx.close();
}

saveManifest();
await browser.close();
