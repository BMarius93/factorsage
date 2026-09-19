// UI/UX audit harness — shared helpers. Audit-only: never imported by the product.
//
// Runs against the hermetic E2E stack (fixture FMP, SMTP/Google off, Stripe inert, egress guard).
// Every screenshot is recorded in artifacts/ui-audit/manifest.json together with automated
// layout/accessibility checks taken at the moment of capture.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../../..");
export const OUT = resolve(here, "..");
const require = createRequire(join(ROOT, "apps/web/package.json"));
export const { chromium } = require("@playwright/test");

export const WEB = "http://localhost:3000";
export const API = "http://localhost:3001";

export const VIEWPORTS = {
  d1440: { width: 1440, height: 900, label: "desktop-1440" },
  d1280: { width: 1280, height: 800, label: "desktop-1280" },
  t1024: { width: 1024, height: 768, label: "tablet-1024" },
  b880: { width: 880, height: 900, label: "boundary-880" },
  b879: { width: 879, height: 900, label: "boundary-879" },
  m390: { width: 390, height: 844, label: "mobile-390" },
};

// ── Environment / credentials (never printed) ─────────────────────────────────
function loadEnv() {
  const env = {};
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  return env;
}
const ENV = loadEnv();

// Audit personas' password: never committed. Set UI_AUDIT_PASSWORD (same value used by seed-audit-users.ts).
export const AUDIT_PASSWORD = process.env.UI_AUDIT_PASSWORD ?? ENV.UI_AUDIT_PASSWORD;

export const PERSONAS = {
  guest: { tier: "GUEST", creds: null },
  "free-limit": { tier: "FREE", creds: () => [ENV.QA_FREE_EMAIL, ENV.QA_FREE_PASSWORD] },
  "starter-limit": { tier: "STARTER", creds: () => [ENV.QA_STARTER_EMAIL, ENV.QA_STARTER_PASSWORD] },
  pro: { tier: "PRO", creds: () => [ENV.QA_USER_EMAIL, ENV.QA_USER_PASSWORD] },
  master: { tier: "FREE+ADMIN", creds: () => [ENV.QA_ADMIN_EMAIL, ENV.QA_ADMIN_PASSWORD] },
  downgraded: { tier: "FREE (downgraded)", creds: () => [ENV.QA_DOWNGRADED_EMAIL, ENV.QA_DOWNGRADED_PASSWORD] },
  "free-empty": { tier: "FREE", creds: () => ["audit-free-empty@factorsage.test", AUDIT_PASSWORD] },
  "free-normal": { tier: "FREE", creds: () => ["audit-free-normal@factorsage.test", AUDIT_PASSWORD] },
  starter: { tier: "STARTER", creds: () => ["audit-starter@factorsage.test", AUDIT_PASSWORD] },
  "pro-heavy": { tier: "PRO", creds: () => ["audit-pro-heavy@factorsage.test", AUDIT_PASSWORD] },
};

// ── Manifest ──────────────────────────────────────────────────────────────────
const manifestPath = join(OUT, "manifest.json");
export const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { generatedBy: "artifacts/ui-audit/harness", entries: [] };

const captured = new Map();
/** Merge-on-write: re-reads the manifest so separate capture scripts never drop each other's rows. */
export function saveManifest() {
  const disk = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { generatedBy: manifest.generatedBy, entries: [] };
  const byFile = new Map(disk.entries.map((e) => [e.file, e]));
  for (const [file, e] of captured) byFile.set(file, e);
  disk.entries = [...byFile.values()].filter((e) => existsSync(join(OUT, e.file))).sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(manifestPath, JSON.stringify(disk, null, 2) + "\n");
}

// ── Browser/session ───────────────────────────────────────────────────────────
export async function launch() {
  return chromium.launch({ headless: true });
}

/** A context for one persona; signs in through the real API so the HttpOnly cookie is genuine. */
export async function personaContext(browser, persona, viewport = VIEWPORTS.d1440) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    baseURL: WEB,
    timezoneId: "America/New_York",
    locale: "en-US",
  });
  // Same logo stub the E2E suite installs: the real UX-005 miss, so no CDN is contacted.
  await context.route("**/api/logo/**", (route) =>
    route.fulfill({ status: 204, headers: { "Cache-Control": "public, max-age=3600" }, body: "" }),
  );
  await context.route(/financialmodelingprep\.com/, (route) => route.abort("blockedbyclient"));
  // Hide the Next.js dev-mode indicator: it is not product UI and would appear in every capture.
  await context.addInitScript(() => {
    const hide = () => {
      if (document.getElementById("__audit_hide_dev")) return;
      const s = document.createElement("style");
      s.id = "__audit_hide_dev";
      s.textContent = "nextjs-portal{display:none!important}";
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hide);
    else hide();
  });
  const p = PERSONAS[persona];
  if (p?.creds) {
    const [email, password] = p.creds();
    if (!email || !password) throw new Error(`missing credentials for ${persona} (QA_* in .env, or UI_AUDIT_PASSWORD for audit personas)`);
    const res = await context.request.post(`${API}/auth/login`, {
      data: { email, password },
      headers: { Origin: WEB },
    });
    if (res.status() !== 200) throw new Error(`login ${persona} -> ${res.status()}`);
  }
  return context;
}

/** Collects console errors, page errors and failed requests for the page, reset per capture. */
export function watch(page) {
  const issues = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on("console", (m) => m.type() === "error" && issues.consoleErrors.push(m.text().slice(0, 300)));
  page.on("pageerror", (e) => issues.pageErrors.push(String(e.message).slice(0, 300)));
  page.on("requestfailed", (r) => {
    const t = r.failure()?.errorText;
    if (t === "net::ERR_ABORTED") return;
    issues.failedRequests.push(`${r.method()} ${r.url()} (${t})`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) issues.failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.__issues = issues;
  return issues;
}

export async function settle(page, ms = 600) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {}
  await page.waitForTimeout(ms);
}

// Automated checks evaluated in the page at capture time.
async function layoutChecks(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const doc = document.documentElement;
    const result = {
      horizontalOverflowPx: Math.max(0, doc.scrollWidth - vw),
      outsideViewport: [],
      duplicateIds: [],
      unnamedControls: [],
      ambiguousLabels: [],
      h1Count: document.querySelectorAll("h1").length,
    };
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const describe = (el) => {
      const t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
      const cls = (el.className && typeof el.className === "string" ? el.className.split(" ")[0] : "") || "";
      return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls ? "." + cls : ""} "${t}"`;
    };
    // Elements that stick out past the right edge (and are not inside a horizontal scroller).
    const scrollerOf = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p !== document.body && p !== doc) return p;
      }
      return null;
    };
    for (const el of document.body.querySelectorAll("*")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) {
        if (r.right <= 0) continue; // visually-hidden technique (e.g. skip link parked off-screen)
        if (scrollerOf(el)) continue;
        if (el.closest("[aria-hidden=true]")) continue;
        result.outsideViewport.push(`${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
        if (result.outsideViewport.length >= 8) break;
      }
    }
    const ids = {};
    for (const el of document.querySelectorAll("[id]")) ids[el.id] = (ids[el.id] || 0) + 1;
    result.duplicateIds = Object.entries(ids).filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
    const nameOf = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
        if (t) return t;
      }
      if (el.labels && el.labels.length) return Array.from(el.labels).map((l) => l.textContent).join(" ").trim();
      const title = el.getAttribute("title");
      const text = (el.innerText || el.textContent || "").trim();
      if (text) return text;
      const img = el.querySelector("img[alt]");
      if (img && img.alt.trim()) return img.alt.trim();
      if (el.placeholder) return el.placeholder;
      return title || "";
    };
    for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=combobox], [role=switch], [role=tab]")) {
      if (!visible(el)) continue;
      const n = nameOf(el);
      if (!n) result.unnamedControls.push(describe(el));
      else if (/^(click here|here|more|open|view|edit|delete|remove|x|×|\.\.\.|…)$/i.test(n)) result.ambiguousLabels.push(n);
    }
    result.ambiguousLabels = [...new Set(result.ambiguousLabels)].slice(0, 12);
    result.unnamedControls = result.unnamedControls.slice(0, 12);
    return result;
  });
}

/**
 * Captures one screenshot + manifest entry.
 * meta: { area, name, persona, route?, state, viewport (VIEWPORTS key object), fixture?, mocks?, section, fullPage? }
 */
export async function shot(page, meta) {
  const vp = meta.viewport;
  const file = `${meta.area}/${meta.name}-${vp.label}.png`;
  const abs = join(OUT, file);
  mkdirSync(dirname(abs), { recursive: true });
  let checks = null;
  try {
    checks = await layoutChecks(page);
  } catch (e) {
    checks = { error: String(e).slice(0, 200) };
  }
  await page.screenshot({ path: abs, fullPage: meta.fullPage !== false, animations: "disabled" });
  const issues = page.__issues ?? { consoleErrors: [], pageErrors: [], failedRequests: [] };
  const entry = {
    file,
    route: meta.route ?? new URL(page.url()).pathname + new URL(page.url()).search,
    persona: meta.persona,
    tier: PERSONAS[meta.persona]?.tier ?? meta.persona,
    viewport: `${vp.width}x${vp.height}`,
    state: meta.state,
    fixture: meta.fixture ?? "hermetic E2E seed (pnpm test:personas:seed) + audit seed",
    mocks: meta.mocks ?? [],
    section: meta.section,
    checks,
    consoleErrors: [...issues.consoleErrors],
    pageErrors: [...issues.pageErrors],
    failedRequests: [...issues.failedRequests].filter((r) => !(meta.expectedFailures ?? []).some((x) => r.includes(x))),
  };
  manifest.entries = manifest.entries.filter((e) => e.file !== file);
  manifest.entries.push(entry);
  captured.set(file, entry);
  issues.consoleErrors.length = 0;
  issues.pageErrors.length = 0;
  issues.failedRequests.length = 0;
  const flag = [];
  if (checks?.horizontalOverflowPx) flag.push(`OVERFLOW ${checks.horizontalOverflowPx}px`);
  if (checks?.outsideViewport?.length) flag.push(`outside:${checks.outsideViewport.length}`);
  if (checks?.duplicateIds?.length) flag.push(`dupIds:${checks.duplicateIds.join(",")}`);
  if (checks?.unnamedControls?.length) flag.push(`unnamed:${checks.unnamedControls.length}`);
  if (entry.consoleErrors.length) flag.push(`console:${entry.consoleErrors.length}`);
  if (entry.pageErrors.length) flag.push(`pageErr:${entry.pageErrors.length}`);
  if (entry.failedRequests.length) flag.push(`failedReq:${entry.failedRequests.length}`);
  console.log(`  📸 ${file}${flag.length ? "  ⚠ " + flag.join(" ") : ""}`);
  return entry;
}

/** Visit a route at several viewports and capture each. */
export async function captureRoute(page, route, metaBase, viewports, before) {
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    if (route) await page.goto(route, { waitUntil: "domcontentloaded" });
    await settle(page);
    if (before) await before(page, vp);
    await shot(page, { ...metaBase, viewport: vp });
  }
}

/** Route interceptor helpers for deterministic mocked states. */
export function jsonRoute(body, status = 200, delayMs = 0) {
  return async (route) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      status,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": WEB, "Access-Control-Allow-Credentials": "true" },
      body: JSON.stringify(body),
    });
  };
}
export function hangRoute() {
  return () => new Promise(() => {});
}

export function apiUrl(pathRegexSource) {
  return new RegExp(`^${API.replace(/[.:/]/g, (c) => "\\" + c)}${pathRegexSource}(\\?.*)?$`);
}
