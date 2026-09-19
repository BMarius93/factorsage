import { launch, personaContext, watch, settle, shot, VIEWPORTS as V, saveManifest } from "./lib.mjs";
import { apiAs } from "./api.mjs";
const a = await apiAs("pro-heavy");
const list = (await a.get("/lists")).find((l) => l.ownership === "USER");
const strat = (await a.get("/strategies")).find((s) => s.ownership === "USER");
const mon = (await a.get("/monitors")).find((m) => m.ownership === "USER");
const run = (await a.get("/backtests"))[0];
await a.dispose();
const b = await launch();
const ctx = await personaContext(b, "starter");
const page = await ctx.newPage(); watch(page);
for (const [area, route] of [["lists", `/lists/${list.id}`], ["strategies", `/strategies/${strat.id}`], ["monitors", `/monitors/${mon.id}`], ["backtests", `/backtests/${run.id}`]]) {
  await page.goto(route); await settle(page, 900);
  const h1 = await page.locator("h1").first().textContent().catch(() => null);
  console.log(route.split("/")[1], "→", h1);
  await shot(page, { area, name: "starter-opens-other-accounts-object", persona: "starter", state: `Starter opens a Pro user's private ${area.slice(0, -1)} URL`, viewport: V.d1440, section: "3 Personas / 17 Errors (isolation)", expectedFailures: [route.split("/")[1]] });
}
saveManifest(); await b.close();
