// Deterministic mocked read models, each derived from a REAL response captured from the hermetic
// stack (fixtures/*.json) so the shapes stay contract-true. Used only for states the seeded stack
// cannot produce on demand (many signals, SELL + FINAL EXIT rows, stale scans, queued runs...).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fx = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

const SEC = [
  ["QATEST1", "QA Test Alpha Corporation"],
  ["QATEST2", "QA Test Beta Corporation"],
  ["IBM", "International Business Machines Corporation"],
  ["UNH", "UnitedHealth Group Incorporated"],
  ["TRV", "The Travelers Companies, Inc."],
  ["GS", "The Goldman Sachs Group, Inc."],
  ["BRK-B", "Berkshire Hathaway Inc. Class B"],
  ["GOOGL", "Alphabet Inc. Class A"],
  ["KO", "The Coca-Cola Company"],
  ["NVDA", "NVIDIA Corporation"],
];
const sec = (i) => ({ id: `sec-${i}`, symbol: SEC[i % SEC.length][0], name: SEC[i % SEC.length][1], exchangeCode: "NYSE", exchangeName: "New York Stock Exchange" });

const LONG_MONITOR = "Monitor with a very long name to test truncation in the dashboard, the collection table and the phone card";

export function dashboardMany() {
  const base = fx("dashboard-pro");
  const mons = [
    { ...base.monitors[0] },
    { ...base.monitors[1] },
    { ...base.monitors[0], id: "m-own-1", name: "Value ladder · core", ownership: "USER", control: "MONITOR_ENABLED", strategy: { id: "s1", name: "Margin-of-safety ladder with RSI confirmation" }, stockList: { id: "l1", name: "Global dividend aristocrats — core income sleeve" } },
    { ...base.monitors[0], id: "m-own-2", name: LONG_MONITOR, ownership: "USER", control: "MONITOR_ENABLED", strategy: { id: "s2", name: "RSI mean reversion" }, stockList: { id: "l2", name: "Blue chips" } },
  ];
  const rows = [];
  const kinds = [
    ["BUY", 1, 25, "ACTIVE"],
    ["BUY", 2, 50, "PENDING_TRIGGER"],
    ["SELL", 1, 25, "ACTIVE"],
    ["SELL", 2, 50, "ACTIVE"],
    ["FINAL_EXIT", 1, null, "ACTIVE"],
    ["BUY", 1, 100, "ACTIVE"],
  ];
  for (let i = 0; i < 24; i++) {
    const [levelKind, levelIndex, levelPercentage, state] = kinds[i % kinds.length];
    const m = mons[i % mons.length];
    const reason =
      levelKind === "FINAL_EXIT"
        ? { exitRule: (i % 3) + 1, conditions: ["Loss is above 15%"], waitingForTrigger: false }
        : levelKind === "SELL"
          ? { conditions: ["Gain is above 25%", "RSI 14D is above 70"], waitingForTrigger: false }
          : { conditions: ["Margin of safety (Balanced) is above 20%", "RSI 14D is below 40"], trigger: "Price crosses above EMA 20D", waitingForTrigger: state === "PENDING_TRIGGER" };
    rows.push({
      id: `row-${i}`,
      state,
      security: sec(i % 7),
      levelKind,
      levelIndex,
      ...(levelPercentage ? { levelPercentage } : {}),
      reasons: levelKind === "FINAL_EXIT" && i % 2 ? [reason, { exitRule: 3, conditions: ["Margin of safety (Balanced) is below -10%", "RSI 14D is above 75"], waitingForTrigger: false }] : [reason],
      monitor: { id: m.id, name: m.name, ownership: m.ownership },
      strategy: m.strategy,
      stockList: m.stockList,
      price: [48.75, 102.5, 1234.56, 0.87, 98765.43, 12.3, 250][i % 7],
      observationDate: "2026-09-18",
      since: new Date(Date.UTC(2026, 8, 18 - (i % 9), 15)).toISOString(),
      reconstructed: i % 5 === 0,
    });
  }
  return { ...base, monitors: mons.map((m) => ({ ...m, activeCount: 5, pendingCount: 1 })), rows };
}

export function dashboardWith({ freshness, rows, monitors }) {
  const base = fx("dashboard-pro");
  const out = clone(base);
  if (monitors) out.monitors = monitors;
  if (freshness) out.monitors = out.monitors.map((m) => ({ ...m, freshness, lastScanAt: freshness === "NOT_SCANNED" ? null : "2026-09-18T13:02:00.000Z" }));
  if (rows) out.rows = rows;
  return out;
}

export function marketUnavailable() {
  const m = clone(fx("market-overview"));
  m.items = m.items.map((it) => ({ code: it.code, label: it.label, status: "UNAVAILABLE", sparkline: [] }));
  return m;
}

export function monitorDetailMany() {
  const base = clone(fx("monitor-builtin-b"));
  const statuses = ["MATCHED", "WAITING_FOR_TRIGGER", "NO_MATCH", "NOT_EVALUABLE", "NOT_CHECKED"];
  base.securityCount = 30;
  base.activeSignalCount = 9;
  base.securities = Array.from({ length: 30 }, (_, i) => {
    const status = statuses[i % statuses.length];
    return {
      security: { ...sec(i), id: `sec-${i}` },
      status,
      matchedLevels: status === "MATCHED" ? [{ levelId: "b1", levelKind: i % 2 ? "SELL" : "BUY", kind: i % 3 ? "CONDITION" : "TRIGGER", signalId: `sig-${i}`, observationPrice: 100 + i, detectedAt: "2026-09-17T15:00:00.000Z" }, ...(i % 4 === 0 ? [{ levelId: "fx", levelKind: "FINAL_EXIT", kind: "CONDITION", signalId: `sig-f-${i}`, observationPrice: 100 + i, detectedAt: "2026-09-18T15:00:00.000Z" }] : [])] : [],
      waitingLevels: status === "WAITING_FOR_TRIGGER" ? [{ levelId: "b2", levelKind: "BUY" }] : [],
      statusSince: "2026-09-18T15:00:00.000Z",
    };
  });
  const reasons = ["CONDITIONS_ENDED", "EVENT_SESSION_ENDED", "BUY_WINDOW_CLOSED", "LOGIC_CHANGED", "MEMBER_REMOVED", "MONITOR_REBOUND"];
  base.signals = Array.from({ length: 100 }, (_, i) => ({
    id: `sig-h-${i}`,
    security: sec(i),
    levelKind: ["BUY", "SELL", "FINAL_EXIT"][i % 3],
    levelId: "b1",
    kind: i % 2 ? "TRIGGER" : "CONDITION",
    observationDate: new Date(Date.UTC(2026, 8, 18 - Math.floor(i / 4))).toISOString().slice(0, 10),
    observationPrice: 50 + i * 3.17,
    detectedAt: new Date(Date.UTC(2026, 8, 18 - Math.floor(i / 4), 15)).toISOString(),
    ...(i % 3 === 0 ? {} : { resolvedAt: new Date(Date.UTC(2026, 8, 19 - Math.floor(i / 4), 15)).toISOString(), resolutionReason: reasons[i % reasons.length] }),
    reconstructed: i % 7 === 0,
  }));
  return base;
}

export function monitorDetailEmpty() {
  const base = clone(fx("monitor-builtin-b"));
  base.securities = [];
  base.signals = [];
  base.securityCount = 0;
  base.activeSignalCount = 0;
  base.lastScanAt = null;
  return base;
}

export function backtestQueued() {
  const r = clone(fx("backtest-running"));
  r.status = "QUEUED";
  r.startedAt = null;
  if (r.progress) r.progress = { ...r.progress, percent: 0, phase: "QUEUED", message: null };
  if (r.live) r.live = null;
  r.milestones = [];
  return r;
}

export function backtestsAllStatuses() {
  const base = fx("backtests-pro-heavy");
  const done = base.find((r) => r.status === "COMPLETED");
  const statuses = ["QUEUED", "PREPARING_DATA", "RUNNING", "FINALIZING", "COMPLETED", "FAILED"];
  return statuses.map((s, i) => ({
    ...done,
    id: `${done.id.slice(0, -2)}${String(i).padStart(2, "0")}`,
    status: s,
    progressPercent: ["QUEUED", "PREPARING_DATA"].includes(s) ? 0 : s === "RUNNING" ? 57 : s === "FINALIZING" ? 99 : 100,
    progressMessage: s === "RUNNING" ? "Simulating 2025" : s === "PREPARING_DATA" ? "Loading prices for 42 stocks" : null,
    completedAt: ["COMPLETED", "FAILED"].includes(s) ? done.completedAt : null,
    portfolioReturnPercent: s === "COMPLETED" ? done.portfolioReturnPercent : null,
    benchmarkReturnPercent: s === "COMPLETED" ? done.benchmarkReturnPercent : null,
    alphaPercent: s === "COMPLETED" ? done.alphaPercent : null,
  }));
}

export function backtestsMany(n = 60) {
  const base = fx("backtests-pro-heavy");
  return Array.from({ length: n }, (_, i) => {
    const r = clone(base[i % base.length]);
    r.id = `${r.id.slice(0, -3)}${String(i).padStart(3, "0")}`;
    if (i === 3) r.strategyName = "Margin-of-safety ladder with RSI confirmation, staged profit taking and three alternative final-exit rules";
    if (r.status === "COMPLETED") {
      r.portfolioReturnPercent = [-43.21, 1287.5, 3.14159, 0, -0.01, 12.5][i % 6];
      r.alphaPercent = [-50.2, 1200.1, -2.1, 0, 0.004, 4.5][i % 6];
    }
    return r;
  });
}

export const BILLING_CATALOG = [
  { key: "STARTER_MONTHLY", plan: "STARTER", interval: "MONTH", amountMinorUnits: 900, currency: "usd", lookupKey: "factorsage_starter_monthly" },
  { key: "STARTER_YEARLY", plan: "STARTER", interval: "YEAR", amountMinorUnits: 9900, currency: "usd", lookupKey: "factorsage_starter_yearly" },
  { key: "PRO_MONTHLY", plan: "PRO", interval: "MONTH", amountMinorUnits: 2900, currency: "usd", lookupKey: "factorsage_pro_monthly" },
  { key: "PRO_YEARLY", plan: "PRO", interval: "YEAR", amountMinorUnits: 29900, currency: "usd", lookupKey: "factorsage_pro_yearly" },
];
const sub = (plan, interval, extra = {}) => ({ plan, interval, status: "ACTIVE", currentPeriodEnd: interval === "YEAR" ? "2027-09-19T00:00:00.000Z" : "2026-10-19T00:00:00.000Z", cancelAtPeriodEnd: false, cancelAt: null, pendingChange: null, ...extra });
const paid = (plan, s, extra = {}) => ({ plan, billingEnabled: true, subscription: s, canStartCheckout: false, canOpenPortal: true, canChangePlan: true, catalog: BILLING_CATALOG, ...extra });
export const BILLING = {
  "free": { plan: "FREE", billingEnabled: true, subscription: null, canStartCheckout: true, canOpenPortal: false, canChangePlan: false, catalog: BILLING_CATALOG },
  "free-billing-disabled": { plan: "FREE", billingEnabled: false, subscription: null, canStartCheckout: false, canOpenPortal: false, canChangePlan: false, catalog: BILLING_CATALOG },
  "starter-monthly": paid("STARTER", sub("STARTER", "MONTH")),
  "starter-annual": paid("STARTER", sub("STARTER", "YEAR")),
  "pro-monthly": paid("PRO", sub("PRO", "MONTH")),
  "pro-annual": paid("PRO", sub("PRO", "YEAR")),
  "pro-cancel-pending": paid("PRO", sub("PRO", "MONTH", { cancelAtPeriodEnd: true, cancelAt: "2026-10-19T00:00:00.000Z" })),
  "pro-scheduled-downgrade": paid("PRO", sub("PRO", "MONTH", { pendingChange: { plan: "STARTER", interval: "MONTH", effectiveAt: "2026-10-19T00:00:00.000Z" } })),
  "starter-past-due": paid("STARTER", sub("STARTER", "MONTH", { status: "PAST_DUE", currentPeriodEnd: "2026-09-18T00:00:00.000Z" })),
  "free-incomplete": { ...paid("FREE", sub("STARTER", "MONTH", { status: "INCOMPLETE" })), canStartCheckout: false },
  "free-canceled-pro-annual": { ...paid("FREE", sub("PRO", "YEAR", { status: "CANCELED", currentPeriodEnd: "2026-09-01T00:00:00.000Z", cancelAt: "2026-09-01T00:00:00.000Z" })), canStartCheckout: true, canChangePlan: false },
  "pro-unrecognised-price": paid("PRO", sub(null, null), { canChangePlan: false }),
};
