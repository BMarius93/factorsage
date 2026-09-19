// Sections 7–9: Lists and Strategies workflows, dialogs and pickers. Every mutation is either
// cancelled, refused by the real API (entitlement / dependency refusal), or mocked.
import { launch, personaContext, watch, settle, shot, VIEWPORTS as V, saveManifest, jsonRoute, hangRoute, apiUrl } from "./lib.mjs";
import { apiAs } from "./api.mjs";

const browser = await launch();
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
const byName = async (persona, path, name) => {
  const a = await apiAs(persona);
  const rows = await a.get(path);
  await a.dispose();
  return rows.find((r) => (typeof name === "string" ? r.name === name : name.test(r.name)));
};
const esc = (page) => page.keyboard.press("Escape");

// ═════════════════════════════ LISTS ═════════════════════════════
console.log("lists");
{
  // Guest: New list → SignInPrompt.
  const { ctx, page } = await open("guest");
  for (const vp of DM) {
    await step("guest new list prompt", async () => {
      await visit(page, "/lists", vp);
      await page.getByRole("button", { name: "New list" }).click();
      await page.waitForTimeout(400);
      await shot(page, { area: "lists", name: "guest-new-list-sign-in-prompt", persona: "guest", state: "Guest presses New list → SignInPrompt", viewport: vp, section: "8 Lists / 25 Entitlements", fullPage: false, expectedFailures: ["/auth/me"] });
    });
  }
  const builtin = await byName("pro", "/lists", "QA Built-in Newcomers");
  for (const vp of STD) {
    await step("guest builtin list", async () => {
      await visit(page, `/lists/${builtin.id}`, vp);
      await shot(page, { area: "lists", name: "guest-builtin-list-detail", persona: "guest", state: "Built-in list read-only (with a CUSTOM membership row)", viewport: vp, section: "8 Lists / 26 Built-ins", expectedFailures: ["/auth/me"] });
    });
  }
  await step("list not found", async () => {
    await visit(page, "/lists/00000000-0000-4000-8000-000000000000", V.d1440);
    await shot(page, { area: "lists", name: "guest-list-not-found", persona: "guest", state: "Unknown list id", viewport: V.d1440, section: "17 Errors", expectedFailures: ["/auth/me", "/lists/"] });
  });
  await ctx.close();
}
{
  // free-empty: empty collection CTA → New list dialog.
  const { ctx, page } = await open("free-empty");
  for (const vp of DM) {
    await step("empty new list", async () => {
      await visit(page, "/lists", vp);
      await page.getByRole("button", { name: "New list" }).first().click();
      await page.waitForTimeout(400);
      await shot(page, { area: "lists", name: "free-empty-new-list-dialog", persona: "free-empty", state: "New list dialog opened from the empty state", viewport: vp, section: "8 Lists", fullPage: false });
    });
  }
  await ctx.close();
}
{
  // starter: New list dialog, stock picker lifecycle, validation, row menus, rename, delete confirm.
  const { ctx, page } = await open("starter");
  for (const vp of DM) {
    await step("new list dialog + picker", async () => {
      await visit(page, "/lists", vp);
      await page.getByRole("button", { name: "New list" }).first().click();
      await page.waitForTimeout(300);
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: /Create list/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "lists", name: "starter-new-list-validation", persona: "starter", state: "Create pressed with no name", viewport: vp, section: "8 Lists", fullPage: false });
      const picker = dialog.getByRole("combobox");
      await picker.click();
      await page.waitForTimeout(300);
      await shot(page, { area: "pickers", name: "starter-list-picker-focused-blank", persona: "starter", state: "Stock picker focused, blank query (no panel)", viewport: vp, section: "7 Pickers", fullPage: false });
      await picker.fill("Q");
      await page.waitForTimeout(80);
      await shot(page, { area: "pickers", name: "starter-list-picker-typing-debounce", persona: "starter", state: "Typed 'Q' — inside the 250ms debounce", viewport: vp, section: "7 Pickers", fullPage: false });
      await page.waitForTimeout(900);
      await shot(page, { area: "pickers", name: "starter-list-picker-results", persona: "starter", state: "Results for 'Q'", viewport: vp, section: "7 Pickers", fullPage: false });
      await picker.fill("QATEST");
      await page.waitForTimeout(900);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      await picker.fill("International");
      await page.waitForTimeout(900);
      await shot(page, { area: "pickers", name: "starter-list-picker-chip-and-results", persona: "starter", state: "One chip selected; new query open", viewport: vp, section: "7 Pickers", fullPage: false });
      await page.keyboard.press("Enter");
      await picker.fill("QATEST");
      await page.waitForTimeout(900);
      await shot(page, { area: "pickers", name: "starter-list-picker-selected-marker", persona: "starter", state: "Re-searching an already chosen stock (Selected marker)", viewport: vp, section: "7 Pickers", fullPage: false });
      await picker.fill("zzzzqqq");
      await page.waitForTimeout(900);
      await shot(page, { area: "pickers", name: "starter-list-picker-no-results", persona: "starter", state: "No results", viewport: vp, section: "7 Pickers", fullPage: false });
      await page.route(/\/stocks\/search/, jsonRoute({ statusCode: 429, code: "RATE_LIMITED", message: "Too many requests", retryAfterSeconds: 30 }, 429));
      await picker.fill("GS");
      await page.waitForTimeout(900);
      await shot(page, { area: "pickers", name: "starter-list-picker-rate-limited", persona: "starter", state: "Search → 429 (picker ignores the rate-limit copy)", viewport: vp, section: "7 Pickers / 17 Errors", fullPage: false, mocks: ["GET /stocks/search → 429"], expectedFailures: ["/stocks/search"] });
      await page.unroute(/\/stocks\/search/);
      await page.route(/\/stocks\/search/, hangRoute());
      await picker.fill("JPM");
      await page.waitForTimeout(700);
      await shot(page, { area: "pickers", name: "starter-list-picker-loading", persona: "starter", state: "Search pending", viewport: vp, section: "7 Pickers / 16 Loading", fullPage: false, mocks: ["GET /stocks/search hangs"] });
      await page.unroute(/\/stocks\/search/);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
    await step("row menu", async () => {
      await visit(page, "/lists", vp);
      await page.getByRole("button", { name: /More actions for Dow blue chips/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "lists", name: "starter-row-overflow-open", persona: "starter", state: "Row overflow menu open", viewport: vp, section: "19 Interaction", fullPage: false });
      await page.getByRole("button", { name: "Rename" }).or(page.getByRole("menuitem", { name: "Rename" })).first().click();
      await page.waitForTimeout(300);
      await shot(page, { area: "lists", name: "starter-rename-dialog", persona: "starter", state: "Rename → dialog titled 'Edit list'", viewport: vp, section: "19 Interaction", fullPage: false });
      await esc(page);
      await page.waitForTimeout(200);
      await page.getByRole("button", { name: /More actions for Dow blue chips/ }).click();
      await page.getByText("Delete", { exact: true }).last().click();
      await page.waitForTimeout(300);
      await shot(page, { area: "lists", name: "starter-delete-confirm", persona: "starter", state: "Delete list confirmation", viewport: vp, section: "19 Interaction", fullPage: false });
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    });
  }
  const pair = await byName("starter", "/lists", "QA pair");
  const empty = await byName("starter", "/lists", "Empty draft list");
  const wide = await byName("starter", "/lists", /Wide research/);
  for (const vp of STD) {
    await step("own list detail", async () => {
      await visit(page, `/lists/${pair.id}`, vp);
      await shot(page, { area: "lists", name: "starter-own-list-detail", persona: "starter", state: "Own list detail (2 stocks)", viewport: vp, section: "8 Lists" });
    });
    await step("empty list detail", async () => {
      await visit(page, `/lists/${empty.id}`, vp);
      await shot(page, { area: "lists", name: "starter-empty-list-detail", persona: "starter", state: "Own list with no stocks", viewport: vp, section: "8 Lists / 15 Empty" });
    });
  }
  await step("wide list detail", async () => {
    for (const vp of DM) {
      await visit(page, `/lists/${wide.id}`, vp);
      await shot(page, { area: "lists", name: "starter-45-stock-list-detail", persona: "starter", state: "45-stock list (no pagination on members)", viewport: vp, section: "18 Density" });
    }
  });
  for (const vp of DM) {
    await step("membership editor", async () => {
      await visit(page, `/lists/${pair.id}`, vp);
      await page.getByRole("button", { name: "Membership" }).first().click();
      await page.waitForTimeout(400);
      await shot(page, { area: "lists", name: "starter-membership-always-eligible", persona: "starter", state: "Membership editor, FULL (Always eligible)", viewport: vp, section: "8 Lists buy windows", fullPage: false });
      const dialog = page.getByRole("dialog");
      await dialog.getByText("Membership period", { exact: true }).click();
      await page.waitForTimeout(200);
      await shot(page, { area: "lists", name: "starter-membership-period-default", persona: "starter", state: "Switched to Membership period (Present checked, empty From)", viewport: vp, section: "8 Lists buy windows", fullPage: false });
      await dialog.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(200);
      await shot(page, { area: "lists", name: "starter-membership-missing-start", persona: "starter", state: "Save without start date", viewport: vp, section: "8 Lists buy windows", fullPage: false });
      await dialog.getByLabel("Present").uncheck();
      await dialog.getByLabel("From").fill("2025-06-01");
      await dialog.getByLabel("To").fill("2024-01-01");
      await dialog.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(200);
      await shot(page, { area: "lists", name: "starter-membership-end-before-start", persona: "starter", state: "End before start", viewport: vp, section: "8 Lists buy windows", fullPage: false });
      await dialog.getByLabel("To").fill("2026-01-01");
      await page.waitForTimeout(200);
      await shot(page, { area: "lists", name: "starter-membership-valid-preview", persona: "starter", state: "Valid bounded period with 'Saves as' preview", viewport: vp, section: "8 Lists buy windows", fullPage: false });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
    await step("remove stock confirm", async () => {
      await visit(page, `/lists/${pair.id}`, vp);
      await page.getByRole("button", { name: /More actions for QATEST2/ }).or(page.getByRole("button", { name: /QATEST2 in this list/ })).first().click();
      await page.waitForTimeout(200);
      await shot(page, { area: "lists", name: "starter-member-overflow-open", persona: "starter", state: "Member row overflow", viewport: vp, section: "19 Interaction", fullPage: false });
      await page.getByText("Remove from list").click();
      await page.waitForTimeout(300);
      await shot(page, { area: "lists", name: "starter-remove-stock-confirm", persona: "starter", state: "Remove stock confirmation", viewport: vp, section: "19 Interaction", fullPage: false });
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    });
    await step("add stocks picker in detail", async () => {
      await visit(page, `/lists/${pair.id}`, vp);
      const picker = page.locator("#add-stocks").getByRole("combobox");
      await picker.fill("QATEST");
      await page.waitForTimeout(900);
      await shot(page, { area: "pickers", name: "starter-add-stocks-in-list-markers", persona: "starter", state: "Add stocks: members shown as 'In list'", viewport: vp, section: "7 Pickers / 8 Lists", fullPage: false });
    });
  }
  await ctx.close();
}
{
  // free-normal: own list with CUSTOM window; pro-heavy: long name + multi-period + 100 symbols.
  const { ctx, page } = await open("free-normal");
  const core = await byName("free-normal", "/lists", "Core research");
  for (const vp of STD) {
    await step("free-normal list", async () => {
      await visit(page, `/lists/${core.id}`, vp);
      await shot(page, { area: "lists", name: "free-normal-list-detail-custom-window", persona: "free-normal", state: "Own list with one open-ended membership period", viewport: vp, section: "8 Lists" });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("pro-heavy");
  const long = await byName("pro-heavy", "/lists", /^Global dividend/);
  const max = await byName("pro-heavy", "/lists", /100 symbols/);
  for (const vp of STD) {
    await step("long list", async () => {
      await visit(page, `/lists/${long.id}`, vp);
      await shot(page, { area: "lists", name: "pro-heavy-long-name-list-detail", persona: "pro-heavy", state: "120-char name, 500-char description, 3-period member", viewport: vp, section: "18 Density" });
    });
  }
  for (const vp of DM) {
    await step("multi-period editor", async () => {
      await visit(page, `/lists/${long.id}`, vp);
      await page.getByRole("button", { name: "Membership" }).first().click();
      await page.waitForTimeout(400);
      await shot(page, { area: "lists", name: "pro-heavy-membership-multi-period-readonly", persona: "pro-heavy", state: "Member with 3 periods: editor opens read-only", viewport: vp, section: "8 Lists buy windows", fullPage: false });
      await esc(page);
    });
    await step("100 list", async () => {
      await visit(page, `/lists/${max.id}`, vp, 1200);
      await shot(page, { area: "lists", name: "pro-heavy-100-symbol-list-detail", persona: "pro-heavy", state: "List at the Pro limit (100 stocks)", viewport: vp, section: "18 Density / 25 Entitlements" });
    });
  }
  await step("list detail loading/error", async () => {
    await page.route(new RegExp(`/lists/${long.id}$`), hangRoute());
    await visit(page, `/lists/${long.id}`, V.d1440, 400);
    await shot(page, { area: "lists", name: "pro-heavy-list-detail-loading", persona: "pro-heavy", state: "GET /lists/:id pending", viewport: V.d1440, section: "16 Loading", mocks: ["GET /lists/:id hangs"] });
    await page.unroute(new RegExp(`/lists/${long.id}$`));
    await page.route(new RegExp(`/lists/${long.id}$`), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    await visit(page, `/lists/${long.id}`, V.d1440);
    await shot(page, { area: "lists", name: "pro-heavy-list-detail-error", persona: "pro-heavy", state: "GET /lists/:id → 500", viewport: V.d1440, section: "17 Errors", mocks: ["GET /lists/:id → 500"], expectedFailures: ["/lists/"] });
    await page.unroute(new RegExp(`/lists/${long.id}$`));
  });
  await ctx.close();
}
{
  // free-limit: adding an 11th stock → real entitlement refusal (nothing is written).
  const { ctx, page } = await open("free-limit");
  const atLimit = await byName("free-limit", "/lists", "ENT-Free At Limit");
  for (const vp of DM) {
    await step("add over limit", async () => {
      await visit(page, `/lists/${atLimit.id}`, vp);
      const picker = page.locator("#add-stocks").getByRole("combobox");
      await picker.fill("QATEST1");
      await page.waitForTimeout(900);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(200);
      await shot(page, { area: "lists", name: "free-limit-at-10-before-add", persona: "free-limit", state: "List at 10/10 with an 11th stock selected: no warning, Add enabled", viewport: vp, section: "25 Entitlements" });
      await page.getByRole("button", { name: /^Add/ }).click();
      await page.waitForTimeout(900);
      await shot(page, { area: "lists", name: "free-limit-add-refused", persona: "free-limit", state: "Add → real 403 ENTITLEMENT_LIST_SYMBOL_LIMIT", viewport: vp, section: "25 Entitlements", expectedFailures: ["/items"] });
    });
  }
  await step("create over limit", async () => {
    await visit(page, "/lists", V.d1440);
    await page.getByRole("button", { name: "New list" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Audit refused list");
    const picker = dialog.getByRole("combobox");
    for (let i = 1; i <= 11; i++) {
      await picker.fill(`ENTF${String(i).padStart(3, "0")}`);
      await page.waitForTimeout(700);
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(200);
    await shot(page, { area: "lists", name: "free-limit-new-list-11-chips", persona: "free-limit", state: "New list with 11 stocks chosen (limit 10): no counter", viewport: V.d1440, section: "25 Entitlements", fullPage: false });
    await dialog.getByRole("button", { name: /Create list/ }).click();
    await page.waitForTimeout(900);
    await shot(page, { area: "lists", name: "free-limit-new-list-refused", persona: "free-limit", state: "Create → real 403 (nothing persisted)", viewport: V.d1440, section: "25 Entitlements", fullPage: false, expectedFailures: ["/lists"] });
  });
  await ctx.close();
}
{
  const { ctx, page } = await open("downgraded");
  const over = await byName("downgraded", "/lists", /Oversized/);
  for (const vp of DM) {
    await step("downgraded over list", async () => {
      await visit(page, `/lists/${over.id}`, vp);
      await page.getByText("Over plan limit").first().hover();
      await page.waitForTimeout(1200);
      await shot(page, { area: "lists", name: "downgraded-over-limit-list-detail", persona: "downgraded", state: "83 stocks on a Free plan: 'Over plan limit' badge (explanation only in tooltip)", viewport: vp, section: "25 Entitlements", fullPage: false });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("master");
  const builtin = await byName("master", "/lists", "QA Built-in Newcomers");
  for (const vp of DM) {
    await step("master builtin list", async () => {
      await visit(page, `/lists/${builtin.id}`, vp);
      await shot(page, { area: "lists", name: "master-builtin-list-editable", persona: "master", state: "Administrator viewing a built-in list (editable)", viewport: vp, section: "26 Built-in/admin" });
    });
  }
  await ctx.close();
}

// ═════════════════════════════ STRATEGIES ═════════════════════════════
console.log("strategies");
{
  const { ctx, page } = await open("starter");
  for (const vp of [V.d1440, V.t1024, V.b879, V.m390]) {
    await step("new strategy blank", async () => {
      await visit(page, "/strategies/new", vp);
      await shot(page, { area: "strategies", name: "starter-new-blank", persona: "starter", state: "New strategy, blank", viewport: vp, section: "9 Strategies" });
    });
  }
  for (const vp of DM) {
    await step("builder build-up", async () => {
      await visit(page, "/strategies/new", vp);
      await page.getByRole("button", { name: /Add buy level/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "strategies", name: "starter-new-one-buy-level", persona: "starter", state: "After + Add buy level", viewport: vp, section: "9 Strategies" });
      await page.getByRole("button", { name: /Add trigger/ }).first().click();
      await page.getByRole("button", { name: /Add condition/ }).first().click();
      await page.getByRole("button", { name: /Add final exit/ }).click();
      await page.getByRole("button", { name: /Add OR rule/ }).click();
      await page.getByRole("button", { name: /Add OR rule/ }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "strategies", name: "starter-new-final-exit-three-rules", persona: "starter", state: "BUY with 2 conditions + trigger; FINAL EXIT with 3 OR rules", viewport: vp, section: "9 Strategies" });
      await page.getByRole("button", { name: "Remove exit rule 2" }).click();
      await page.waitForTimeout(300);
      await shot(page, { area: "strategies", name: "starter-new-final-exit-middle-removed", persona: "starter", state: "Exit rule 2 removed → renumbered", viewport: vp, section: "9 Strategies" });
      await page.getByRole("button", { name: /Save strategy/ }).click({ trial: true }).catch(() => {});
      const issues = page.getByRole("button", { name: /issues? to fix/ });
      if (await issues.count()) {
        await issues.click();
        await page.waitForTimeout(500);
        await shot(page, { area: "strategies", name: "starter-new-issues-revealed", persona: "starter", state: "Issue count pressed → issues revealed/focused", viewport: vp, section: "9 Strategies", fullPage: false });
      }
      await page.getByRole("combobox", { name: "Metric" }).first().focus();
      await page.waitForTimeout(300);
      await shot(page, { area: "strategies", name: "starter-new-metric-focus-help", persona: "starter", state: "Metric select focused → contextual explanation", viewport: vp, section: "9 Strategies / 7 Pickers", fullPage: false });
      const opts = await page.getByRole("combobox", { name: "Metric" }).first().evaluate((s) => [...s.querySelectorAll("optgroup")].map((g) => `${g.label}: ${[...g.querySelectorAll("option")].map((o) => o.textContent).join(", ")}`));
      console.log("    metric options:", JSON.stringify(opts));
    });
  }
  // Guard: dismiss the native "leave page?" confirm automatically.
  page.on("dialog", (d) => d.accept());
  const ladder = await byName("starter", "/strategies", "Value ladder");
  for (const vp of [V.d1440, V.d1280, V.t1024, V.b879, V.m390]) {
    await step("edit ladder", async () => {
      await visit(page, `/strategies/${ladder.id}`, vp, 1000);
      await shot(page, { area: "strategies", name: "starter-edit-ladder", persona: "starter", state: "Edit existing: 3 BUY, 2 SELL, FINAL EXIT with 3 rules", viewport: vp, section: "9 Strategies" });
    });
  }
  for (const vp of DM) {
    await step("dirty", async () => {
      await visit(page, `/strategies/${ladder.id}`, vp, 1000);
      await page.getByLabel("Name").first().fill("Value ladder (edited)");
      await page.waitForTimeout(300);
      await shot(page, { area: "strategies", name: "starter-edit-dirty-save-bar", persona: "starter", state: "Unsaved changes: save bar with Discard", viewport: vp, section: "9 Strategies", fullPage: false });
    });
  }
  await step("row menu + delete refused", async () => {
    await visit(page, "/strategies", V.d1440);
    await page.getByRole("button", { name: /More actions for Value ladder/ }).click();
    await page.waitForTimeout(200);
    await shot(page, { area: "strategies", name: "starter-row-overflow-open", persona: "starter", state: "Strategy row overflow", viewport: V.d1440, section: "19 Interaction", fullPage: false });
    await page.getByText("Delete", { exact: true }).last().click();
    await page.waitForTimeout(300);
    await shot(page, { area: "strategies", name: "starter-delete-confirm", persona: "starter", state: "Delete strategy confirmation", viewport: V.d1440, section: "19 Interaction", fullPage: false });
    await page.getByRole("dialog").getByRole("button", { name: /Delete strategy/ }).click();
    await page.waitForTimeout(900);
    await shot(page, { area: "strategies", name: "starter-delete-refused-in-use", persona: "starter", state: "Delete → real 409 (strategy used by a monitor; nothing deleted)", viewport: V.d1440, section: "17 Errors", fullPage: false, expectedFailures: ["/strategies/"] });
    await esc(page);
  });
  await step("rename dialog", async () => {
    await visit(page, "/strategies", V.m390);
    await page.getByRole("button", { name: /More actions for Value ladder/ }).click();
    await page.getByText("Rename", { exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, { area: "strategies", name: "starter-rename-dialog", persona: "starter", state: "Rename → 'Edit strategy' dialog", viewport: V.m390, section: "19 Interaction", fullPage: false });
    await esc(page);
  });
  await ctx.close();
}
{
  const { ctx, page } = await open("guest");
  const builtin = await byName("pro", "/strategies", "QA Built-in Trend");
  for (const vp of STD) {
    await step("guest builtin strategy", async () => {
      await visit(page, `/strategies/${builtin.id}`, vp);
      await shot(page, { area: "strategies", name: "guest-builtin-readonly", persona: "guest", state: "Built-in strategy read-only view", viewport: vp, section: "9 Strategies / 26 Built-ins", expectedFailures: ["/auth/me"] });
    });
  }
  await step("guest backtest this", async () => {
    await visit(page, `/strategies/${builtin.id}`, V.d1440);
    await page.getByRole("button", { name: "Backtest this strategy" }).click();
    await page.waitForTimeout(300);
    await shot(page, { area: "strategies", name: "guest-backtest-this-prompt", persona: "guest", state: "Guest presses Backtest this strategy", viewport: V.d1440, section: "25 Entitlements", fullPage: false, expectedFailures: ["/auth/me"] });
  });
  await step("guest new strategy prompt", async () => {
    await visit(page, "/strategies", V.m390);
    await page.getByRole("button", { name: "New strategy" }).click();
    await page.waitForTimeout(300);
    await shot(page, { area: "strategies", name: "guest-new-strategy-prompt", persona: "guest", state: "Guest presses New strategy", viewport: V.m390, section: "25 Entitlements", fullPage: false, expectedFailures: ["/auth/me"] });
  });
  await step("strategy not found", async () => {
    await visit(page, "/strategies/00000000-0000-4000-8000-000000000000", V.d1440);
    await shot(page, { area: "strategies", name: "guest-strategy-not-found", persona: "guest", state: "Unknown strategy id", viewport: V.d1440, section: "17 Errors", expectedFailures: ["/auth/me", "/strategies/"] });
  });
  await ctx.close();
}
{
  const { ctx, page } = await open("pro-heavy");
  page.on("dialog", (d) => d.accept());
  const long = await byName("pro-heavy", "/strategies", /^Margin-of-safety ladder/);
  for (const vp of DM) {
    await step("long strategy", async () => {
      await visit(page, `/strategies/${long.id}`, vp, 1000);
      await shot(page, { area: "strategies", name: "pro-heavy-long-name-editor", persona: "pro-heavy", state: "Editor for a strategy with 120-char name + long description", viewport: vp, section: "18 Density" });
    });
  }
  await ctx.close();
}
{
  const { ctx, page } = await open("master");
  page.on("dialog", (d) => d.accept());
  const builtin = await byName("master", "/strategies", "QA Built-in Trend");
  for (const vp of DM) {
    await step("master builtin strategy", async () => {
      await visit(page, `/strategies/${builtin.id}`, vp, 1000);
      await shot(page, { area: "strategies", name: "master-builtin-editable", persona: "master", state: "Administrator opens a built-in strategy (builder)", viewport: vp, section: "26 Built-in/admin" });
    });
  }
  await ctx.close();
}

saveManifest();
await browser.close();
