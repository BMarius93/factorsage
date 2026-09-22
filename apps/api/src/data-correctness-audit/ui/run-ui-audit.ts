import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";

/**
 * The browser stage: `apps/web/e2e/data-correctness/data-correctness.audit.spec.ts` against the
 * audit stack, reading the expectations the earlier sections wrote and recording what it saw.
 */
export async function runUiSection(input: {
  root: string;
  writer: AuditWriter;
  log: (line: string) => void;
}): Promise<{ ledger: ComparisonLedger; detail: Record<string, unknown> }> {
  const ledger = new ComparisonLedger(300);
  const observedPath = input.writer.path("ui/observed.json");
  rmSync(observedPath, { force: true });
  for (const name of [
    "backtest-expectations.json",
    "stock-details-expectations.json",
    "dashboard-expectations.json",
  ]) {
    if (!existsSync(input.writer.path(`ui/${name}`))) {
      ledger.skip("ui", name, "the section that writes it did not run");
      return { ledger, detail: { skipped: `missing ${name}` } };
    }
  }
  const run = spawnSync(
    "pnpm",
    [
      "--filter",
      "@intrinsic/web",
      "exec",
      "playwright",
      "test",
      "-c",
      "playwright.data-correctness.config.ts",
    ],
    {
      cwd: input.root,
      encoding: "utf8",
      env: { ...process.env, AUDIT_ARTIFACTS: input.writer.root },
    },
  );
  input.log(run.stdout.split("\n").slice(-25).join("\n"));
  // Playwright keeps page snapshots (which can include the persona's password) on failure.
  rmSync(join(input.root, "apps", "web", "test-results"), {
    recursive: true,
    force: true,
  });
  if (!existsSync(observedPath)) {
    ledger.check(
      "ui",
      "Playwright produced observations",
      true,
      false,
      "exact-number",
    );
    return {
      ledger,
      detail: { exitCode: run.status, stderr: run.stderr.slice(-2000) },
    };
  }
  const observed = JSON.parse(readFileSync(observedPath, "utf8")) as {
    checks: {
      area: string;
      id: string;
      expected: string;
      actual: string | null;
    }[];
  };
  const byArea: Record<string, number> = {};
  for (const check of observed.checks) {
    const category = check.area.startsWith("backtest")
      ? "ui-backtests"
      : check.area.startsWith("stock")
        ? "ui-stock-details"
        : "ui-dashboard";
    byArea[category] = (byArea[category] ?? 0) + 1;
    ledger.check(
      category,
      `${check.area}: ${check.id}`,
      check.expected,
      check.actual,
      "exact-text",
    );
  }
  input.writer.writeJson("ui/summary.json", {
    playwrightExitCode: run.status,
    comparisons: ledger.totals(),
    byCategory: ledger.byCategory(),
    differences: ledger.differences,
  });
  return { ledger, detail: { playwrightExitCode: run.status, byArea } };
}
