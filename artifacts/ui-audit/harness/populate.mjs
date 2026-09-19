// Audit-only: populates the four audit personas through the product's public API (the same
// validation, entitlement guards and persistence a real user goes through). Hermetic stack only.
//   free-empty   — nothing
//   free-normal  — a small, realistic Free account
//   starter      — a normal Starter account
//   pro-heavy    — a dense Pro account with pathological names/descriptions
import { apiAs } from "./api.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT } from "./lib.mjs";

const LONG_120 =
  "Global dividend aristocrats with twenty-five consecutive years of increases — core income sleeve, rebalanced every quarter".slice(0, 120);
const ONLY = process.env.ONLY;
const LONG_DESC =
  "A deliberately long description used by the UI audit to see how collections, detail headers, pickers and mobile cards cope with several lines of prose. It keeps going past the point where most layouts would truncate, mentions tickers like BRK-B and GOOGL, and ends with a very-long-unbroken-token-to-test-wrapping-behaviour-in-narrow-columns.";

const f = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const yearsAgo = (n) => {
  const d = new Date(today);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cond = (id, metric, operator, value) => ({ id, metric, operator, value });
const PRICE = { kind: "PRICE" };
const MA = (s) => ({ kind: "MOVING_AVERAGE", seriesId: s });
const OSC = (s) => ({ kind: "OSCILLATOR", seriesId: s });
const MOS = (s) => ({ kind: "MARGIN_OF_SAFETY", sourceId: s });
const SER = (s) => ({ kind: "SERIES", seriesId: s });
const NUM = (v) => ({ kind: "NUMBER", value: v });
const PCT = (v) => ({ kind: "PERCENT", value: v });

const DEFS = {
  trend: {
    schemaVersion: 2,
    buyLevels: [{ id: "b1", percentage: 100, signal: { conditions: [cond("b1c1", MA("SMA_50D"), "IS_ABOVE", SER("SMA_200D")), cond("b1c2", PRICE, "IS_ABOVE", SER("SMA_200D"))], trigger: cond("b1t", PRICE, "CROSSES_ABOVE", SER("SMA_20D")) } }],
    sellLevels: [],
    finalExit: { id: "fx", rules: [{ id: "fx1", signal: { conditions: [], trigger: cond("fx1t", PRICE, "CROSSES_BELOW", SER("SMA_200D")) } }] },
  },
  simple: {
    schemaVersion: 2,
    buyLevels: [{ id: "b1", percentage: 100, signal: { conditions: [cond("b1c1", PRICE, "IS_ABOVE", SER("SMA_200D"))] } }],
    sellLevels: [],
  },
  ladder: {
    schemaVersion: 2,
    buyLevels: [
      { id: "b1", percentage: 25, signal: { conditions: [cond("b1c1", MOS("BALANCED"), "IS_ABOVE", PCT(10))] } },
      { id: "b2", percentage: 25, signal: { conditions: [cond("b2c1", MOS("BALANCED"), "IS_ABOVE", PCT(20)), cond("b2c2", OSC("RSI_14D"), "IS_BELOW", NUM(40))] } },
      { id: "b3", percentage: 50, signal: { conditions: [cond("b3c1", MOS("BALANCED"), "IS_ABOVE", PCT(30))], trigger: cond("b3t", PRICE, "CROSSES_ABOVE", SER("EMA_20D")) } },
    ],
    sellLevels: [
      { id: "s1", percentage: 25, signal: { conditions: [cond("s1c1", { kind: "GAIN" }, "IS_ABOVE", PCT(25))] } },
      { id: "s2", percentage: 50, signal: { conditions: [cond("s2c1", OSC("RSI_14D"), "IS_ABOVE", NUM(70))] } },
    ],
    finalExit: {
      id: "fx",
      rules: [
        { id: "fx1", signal: { conditions: [], trigger: cond("fx1t", PRICE, "CROSSES_BELOW", SER("SMA_200D")) } },
        { id: "fx2", signal: { conditions: [cond("fx2c", { kind: "LOSS" }, "IS_ABOVE", PCT(15))] } },
        { id: "fx3", signal: { conditions: [cond("fx3c", MOS("BALANCED"), "IS_BELOW", PCT(-10)), cond("fx3c2", OSC("RSI_14D"), "IS_ABOVE", NUM(75))] } },
      ],
    },
  },
  meanRev: {
    schemaVersion: 2,
    buyLevels: [{ id: "b1", percentage: 50, signal: { conditions: [cond("b1c1", OSC("RSI_7D"), "IS_BELOW", NUM(30)), cond("b1c2", PRICE, "IS_ABOVE", SER("SMA_200W"))] } }],
    sellLevels: [{ id: "s1", percentage: 75, signal: { conditions: [cond("s1c1", OSC("RSI_7D"), "IS_ABOVE", NUM(65))] } }],
    finalExit: { id: "fx", rules: [{ id: "fx1", signal: { conditions: [cond("fx1c", { kind: "LOSS" }, "IS_ABOVE", PCT(8))] } }, { id: "fx2", signal: { conditions: [cond("fx2c", PRICE, "IS_BELOW", SER("SMA_200D"))] } }] },
  },
};

const report = {};
async function trying(label, fn) {
  try {
    return await fn();
  } catch (e) {
    console.log(`  ✗ ${label}: ${e.message}`);
    (report.errors ??= []).push(`${label}: ${e.message}`);
    return null;
  }
}

async function ids(a, symbols) {
  const out = [];
  for (const s of symbols) {
    const r = await a.get(`/stocks/search?q=${encodeURIComponent(s)}`);
    const hit = r.find((x) => x.symbol === s);
    if (hit) out.push(hit.id);
    else console.log(`  (no catalog row for ${s})`);
  }
  return out;
}
async function entfIds(a, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const s = `ENTF${String(i).padStart(3, "0")}`;
    const r = await a.get(`/stocks/search?q=${s}`);
    const hit = r.find((x) => x.symbol === s);
    if (hit) out.push(hit.id);
  }
  return out;
}

async function reset(a) {
  for (const m of (await a.get("/monitors")).filter((m) => m.ownership === "USER")) await a.del(`/monitors/${m.id}`);
  for (const s of (await a.get("/strategies")).filter((s) => s.ownership === "USER")) await trying(`delete strategy ${s.name}`, () => a.del(`/strategies/${s.id}`));
  for (const l of (await a.get("/lists")).filter((l) => l.ownership === "USER")) await trying(`delete list ${l.name}`, () => a.del(`/lists/${l.id}`));
}

async function runAndWait(a, body, label) {
  const run = await trying(`backtest ${label}`, () => a.post("/backtests", body));
  if (!run) return null;
  const t0 = Date.now();
  for (;;) {
    const st = await a.get(`/backtests/${run.id}`);
    if (["COMPLETED", "FAILED"].includes(st.status) || Date.now() - t0 > 240000) {
      console.log(`  run ${label}: ${st.status} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      return st;
    }
    await sleep(1500);
  }
}

const BLUE_CHIPS = ["KO", "JNJ", "PG", "MMM", "IBM", "MRK", "NKE", "WMT", "XOM", "CVX", "HD", "JPM", "GS", "HON", "UNH", "TRV", "SHW", "BA", "AXP", "ADBE", "AMGN", "CSCO", "CAT", "DIS", "AMZN", "NVDA", "MCD"];

// ── free-normal ────────────────────────────────────────────────────────────
if (!ONLY || ONLY === "free-normal") {
  const a = await apiAs("free-normal");
  console.log("free-normal");
  await reset(a);
  const [q1, q2] = await ids(a, ["QATEST1", "QATEST2"]);
  const staples = await ids(a, ["KO", "PG", "JNJ", "WMT", "MCD"]);
  const L1 = await trying("list core", () => a.post("/lists", { name: "Core research", description: "The two names I follow most closely.", securityIds: [q1, q2] }));
  const L2 = await trying("list staples", () => a.post("/lists", { name: "Consumer staples", securityIds: staples }));
  if (L1) {
    const item = L1.items.find((i) => i.securityId === q2) ?? L1.items[1];
    await trying("buy window", () => a.put(`/lists/${L1.id}/items/${item.id}/buy-windows`, { mode: "CUSTOM", ranges: [{ startDate: f(yearsAgo(2)), endDate: null }] }));
  }
  const S1 = await trying("strategy trend", () => a.post("/strategies", { name: "My trend follower", description: "Buys above the 200-day average, exits on a cross below.", definition: DEFS.trend }));
  await trying("strategy simple", () => a.post("/strategies", { name: "Above the 200-day", definition: DEFS.simple }));
  if (S1 && L1) {
    await trying("monitor", () => a.post("/monitors", { name: "Trend on core research", strategyId: S1.id, stockListId: L1.id, enabled: true }));
    await runAndWait(a, { strategyId: S1.id, stockListId: L1.id, startDate: f(yearsAgo(2)), endDate: f(today), initialCapital: 10000, maximumPositions: 5 }, "free-normal trend");
  }
  if (q1) await trying("recent", () => a.post("/recent-searches", { securityId: q1 }));
  for (const id of staples.slice(0, 2)) await trying("recent", () => a.post("/recent-searches", { securityId: id }));
  await a.dispose();
}

// ── starter ────────────────────────────────────────────────────────────────
if (!ONLY || ONLY === "starter") {
  const a = await apiAs("starter");
  console.log("starter");
  await reset(a);
  const [q1, q2] = await ids(a, ["QATEST1", "QATEST2"]);
  const chips = await ids(a, BLUE_CHIPS.slice(0, 20));
  const entf = await entfIds(a, 45);
  const L1 = await trying("list", () => a.post("/lists", { name: "QA pair", securityIds: [q1, q2] }));
  await trying("list", () => a.post("/lists", { name: "Dow blue chips", description: "Twenty large US industrials and consumer names.", securityIds: chips }));
  await trying("list", () => a.post("/lists", { name: "Wide research universe (45)", securityIds: entf }));
  await trying("list", () => a.post("/lists", { name: "Empty draft list" }));
  const S1 = await trying("strategy", () => a.post("/strategies", { name: "Value ladder", description: "Three BUY levels on margin of safety, two SELL levels, three exit rules.", definition: DEFS.ladder }));
  const S2 = await trying("strategy", () => a.post("/strategies", { name: "Trend confirmation", definition: DEFS.trend }));
  await trying("strategy", () => a.post("/strategies", { name: "RSI mean reversion", definition: DEFS.meanRev }));
  if (L1 && S1) {
    await trying("monitor", () => a.post("/monitors", { name: "Value ladder · QA pair", strategyId: S1.id, stockListId: L1.id, enabled: true }));
    await trying("monitor", () => a.post("/monitors", { name: "Trend · QA pair (paused)", strategyId: S2.id, stockListId: L1.id, enabled: false }));
    await runAndWait(a, { strategyId: S1.id, stockListId: L1.id, startDate: f(yearsAgo(3)), endDate: f(today), initialCapital: 25000, monthlyContribution: 500, maximumPositions: 4 }, "starter ladder");
    await runAndWait(a, { strategyId: S2.id, stockListId: L1.id, startDate: f(yearsAgo(1)), endDate: f(today), initialCapital: 10000, maximumPositions: 2 }, "starter trend");
  }
  await a.dispose();
}

// ── pro-heavy ──────────────────────────────────────────────────────────────
if (!ONLY || ONLY === "pro-heavy") {
  const a = await apiAs("pro-heavy");
  console.log("pro-heavy");
  await reset(a);
  const [q1, q2] = await ids(a, ["QATEST1", "QATEST2"]);
  const chips = await ids(a, BLUE_CHIPS);
  const entf = await entfIds(a, 100);
  const lists = [];
  lists.push(await trying("list long", () => a.post("/lists", { name: LONG_120, description: LONG_DESC, securityIds: [q1, q2] })));
  lists.push(await trying("list max", () => a.post("/lists", { name: "At the Pro limit — 100 symbols", securityIds: entf })));
  lists.push(await trying("list chips", () => a.post("/lists", { name: "Blue chips", securityIds: chips })));
  for (let i = 1; i <= 27; i++) {
    const n = (i * 7) % 23;
    lists.push(await trying(`list ${i}`, () => a.post("/lists", { name: `Research universe ${String(i).padStart(2, "0")}`, description: i % 3 === 0 ? "Sector sleeve for the quarterly review." : undefined, securityIds: [q1, ...chips.slice(0, n)] })));
  }
  // Several membership windows on the long list.
  if (lists[0]) {
    const item = lists[0].items[0];
    await trying("multi-period window", () => a.put(`/lists/${lists[0].id}/items/${item.id}/buy-windows`, { mode: "CUSTOM", ranges: [{ startDate: "2015-01-02", endDate: "2018-06-29" }, { startDate: "2020-03-02", endDate: "2022-12-30" }, { startDate: f(yearsAgo(1)), endDate: null }] }));
  }
  const strategies = [];
  strategies.push(await trying("strategy long", () => a.post("/strategies", { name: "Margin-of-safety ladder with RSI confirmation, staged profit taking and three alternative final-exit rules", description: LONG_DESC, definition: DEFS.ladder })));
  strategies.push(await trying("strategy trend", () => a.post("/strategies", { name: "Trend confirmation", definition: DEFS.trend })));
  strategies.push(await trying("strategy mr", () => a.post("/strategies", { name: "RSI mean reversion", definition: DEFS.meanRev })));
  for (let i = 1; i <= 22; i++) {
    const def = [DEFS.simple, DEFS.trend, DEFS.meanRev, DEFS.ladder][i % 4];
    strategies.push(await trying(`strategy ${i}`, () => a.post("/strategies", { name: `Variant ${String(i).padStart(2, "0")} — ${["simple", "trend", "mean reversion", "ladder"][i % 4]}`, definition: def })));
  }
  const qaList = lists[0];
  const monitorNames = [
    "Monitor with a very long name to test truncation in the dashboard, the collection table and the phone record card layout",
    "Ladder · long list", "Trend · long list", "Mean reversion · long list", "Wide universe trend", "Wide universe ladder",
    "Universe 01 trend", "Universe 02 trend", "Universe 03 trend", "Universe 04 trend",
    "Paused — universe 05", "Paused — universe 06", "Paused — universe 07",
  ];
  for (let i = 0; i < monitorNames.length; i++) {
    const s = strategies[i % 3];
    const l = i < 4 ? qaList : lists[1]; // fixture-only universes keep the Monitor worker hermetic
    if (!s || !l) continue;
    await trying(`monitor ${i}`, () => a.post("/monitors", { name: monitorNames[i], strategyId: s.id, stockListId: l.id, enabled: i < 10 }));
  }
  // Backtest history: completed runs over the QA list, plus failed runs over data-less lists.
  if (qaList) {
    const configs = [
      [strategies[0], qaList, 3, 100000, 1000, 10],
      [strategies[1], qaList, 2, 50000, 0, 5],
      [strategies[2], qaList, 1, 10000, 250, 2],
      [strategies[1], qaList, 3, 1000000, 0, 20],
      [strategies[0], qaList, 2, 25000, 500, 1],
      [strategies[2], qaList, 3, 5000, 100, 3],
    ];
    let n = 0;
    for (const [s, l, years, cap, contrib, maxPos] of configs) {
      if (!s) continue;
      await runAndWait(a, { strategyId: s.id, stockListId: l.id, startDate: f(yearsAgo(years)), endDate: f(today), initialCapital: cap, ...(contrib ? { monthlyContribution: contrib } : {}), maximumPositions: maxPos }, `pro-heavy #${++n}`);
    }
    // Data-less universes fail with DATA_UNAVAILABLE: a real, product-produced failure state.
    if (lists[1] && strategies[1]) await runAndWait(a, { strategyId: strategies[1].id, stockListId: lists[1].id, startDate: f(yearsAgo(1)), endDate: f(today), initialCapital: 10000, maximumPositions: 10 }, "pro-heavy fail (100 ENTF)");
    if (lists[2] && strategies[0]) await runAndWait(a, { strategyId: strategies[0].id, stockListId: lists[2].id, startDate: f(yearsAgo(1)), endDate: f(today), initialCapital: 10000, maximumPositions: 10 }, "pro-heavy blue chips");
  }
  for (const id of [q1, q2, ...chips.slice(0, 6)]) await trying("recent", () => a.post("/recent-searches", { securityId: id }));
  await a.dispose();
}

if (report.errors?.length) console.log(JSON.stringify(report, null, 2));
console.log("done");
