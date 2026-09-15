import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_POLICIES,
  UNDECLARED_ROUTE_POLICY,
  type RateLimitPolicy,
  type RateLimitPolicyName,
} from "./rate-limit-policies";

/**
 * Keeps the engineering documentation's policy table honest.
 *
 * The table in `ai/architecture/rate-limiting.md` is genuinely useful — an engineer wants the whole
 * catalog at a glance without reading TypeScript — but a table of numbers copied out of code is a
 * drift machine. This review found it had already drifted: the catalog moved from ten to twenty
 * attempts and the table still said ten, because nothing checked it.
 *
 * So the values stay in the document and are parsed back out of it here. Prose elsewhere in the
 * repository no longer restates an allowance at all; this table is the single documented copy, and
 * it is the one copy that is verified.
 */

function workspaceRoot(): string {
  let current = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the workspace root");
    }
    current = parent;
  }
}

const DOC_PATH = "ai/architecture/rate-limiting.md";

/** `min` / `hr` / `s`, as the table spells them. */
const UNIT_SECONDS: Readonly<Record<string, number>> = {
  s: 1,
  sec: 1,
  min: 60,
  hr: 3600,
};

type ParsedBucket = { points: number; durationSeconds: number };

/** `20 / 5 min` -> 20 points over 300 s. `120 / min` -> 120 over 60 s. `—` -> no bucket. */
function parseAllowance(cell: string): ParsedBucket | null {
  const text = cell.trim();
  if (text === "—" || text === "-" || text === "") {
    return null;
  }
  const match = /^(\d+)\s*\/\s*(?:(\d+)\s*)?([a-z]+)$/i.exec(text);
  if (!match) {
    throw new Error(`Unparseable allowance cell in ${DOC_PATH}: "${cell}"`);
  }
  const unit = UNIT_SECONDS[(match[3] as string).toLowerCase()];
  if (unit === undefined) {
    throw new Error(`Unknown time unit in ${DOC_PATH}: "${cell}"`);
  }
  return {
    points: Number(match[1]),
    durationSeconds: Number(match[2] ?? 1) * unit,
  };
}

type DocumentedRow = {
  policy: string;
  primary: ParsedBucket | null;
  secondary: ParsedBucket | null;
  actor: string;
  onRedisFailure: string;
};

function documentedRows(): DocumentedRow[] {
  const source = readFileSync(join(workspaceRoot(), DOC_PATH), "utf8");
  const lines = source.split("\n");

  // Matched on collapsed whitespace: Prettier re-pads markdown table columns whenever a cell's
  // width changes, and a parser that depended on that padding would break on formatting alone.
  const headerIndex = lines.findIndex(
    (line) =>
      line.replace(/\s+/g, " ").trim() ===
      "| Policy | Per actor | Shared per-IP bucket | Actor | On Redis failure | Applies to |",
  );
  expect(
    headerIndex,
    `${DOC_PATH} no longer contains the policy table`,
  ).toBeGreaterThan(-1);

  const rows: DocumentedRow[] = [];
  for (const line of lines.slice(headerIndex)) {
    if (!line.startsWith("| `")) {
      if (rows.length > 0 && !line.startsWith("|")) {
        break;
      }
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    rows.push({
      policy: (cells[0] as string).replace(/`/g, ""),
      primary: parseAllowance(cells[1] as string),
      secondary: parseAllowance(cells[2] as string),
      actor: cells[3] as string,
      onRedisFailure: (cells[4] as string).replace(/\*/g, ""),
    });
  }
  return rows;
}

/** How the table spells an actor, for the two kinds the catalog has. */
function documentedActor(policy: RateLimitPolicy): string {
  return policy.actor === "ip" ? "IP" : "user→IP";
}

describe("the documented policy table matches the catalog", () => {
  const rows = documentedRows();
  const declarable = Object.keys(RATE_LIMIT_POLICIES).filter(
    (name) => name !== UNDECLARED_ROUTE_POLICY,
  ) as RateLimitPolicyName[];

  it("documents every declarable policy, and nothing that does not exist", () => {
    expect(rows.map((row) => row.policy).sort()).toEqual(
      [...declarable].sort(),
    );
  });

  it("states each policy's real allowance, actor and failure mode", () => {
    for (const row of rows) {
      const policy = RATE_LIMIT_POLICIES[row.policy as RateLimitPolicyName];
      expect(policy, `${row.policy} is not in the catalog`).toBeDefined();

      expect(row.primary, `${row.policy}: per-actor allowance`).toEqual({
        points: policy.points,
        durationSeconds: policy.durationSeconds,
      });

      const secondary = "secondary" in policy ? policy.secondary : undefined;
      expect(row.secondary, `${row.policy}: shared bucket`).toEqual(
        secondary
          ? {
              points: secondary.points,
              durationSeconds: secondary.durationSeconds,
            }
          : null,
      );

      expect(row.actor, `${row.policy}: actor`).toBe(documentedActor(policy));
      expect(row.onRedisFailure, `${row.policy}: failure mode`).toBe(
        policy.onRedisFailure,
      );
    }
  });
});
