import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * Live probes of submission admission and entitlement enforcement against a running API
 * (`docs/production/benchmarks.md`, "Failure tests"): what the integration suites prove inside one
 * process, observed over HTTP the way a browser — or someone scripting one — reaches it.
 *
 * ```bash
 * LOAD_TEST_PASSWORD=… pnpm --filter @intrinsic/api exec tsx src/load-test/submission-probes.ts \
 *   --base-url http://127.0.0.1:3101
 * ```
 *
 * Uses the `load-user-NNN` accounts `load:interactive setup` creates (user 1 Free, 5 Starter, 8 Pro,
 * 10 Pro+). For each plan it fires several identical submissions at once — many browser tabs — and
 * counts how many the API accepted against the plan's concurrent-run allowance; then it tries the
 * bypasses a client could attempt. Every accepted run is cancelled before it exits.
 */

type Arguments = {
  baseUrl: string;
  tabs: number;
  report: string;
  saturate: number;
};

function parseArguments(argv: readonly string[]): Arguments {
  const parsed: Arguments = {
    baseUrl: "http://127.0.0.1:3101",
    tabs: 6,
    report: "docs/production/benchmark-results/submission-probes.jsonl",
    saturate: 0,
  };
  const rest = argv.filter((value) => value !== "--");
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--base-url") parsed.baseUrl = value.replace(/\/$/, "");
    else if (flag === "--tabs") parsed.tabs = Number(value);
    else if (flag === "--report") parsed.report = value;
    else if (flag === "--saturate") parsed.saturate = Number(value);
    else throw new Error(`Unknown argument ${flag}`);
  }
  return parsed;
}

type Reply = { status: number; body: unknown };

class Client {
  cookie = "";
  constructor(private readonly baseUrl: string) {}

  async send(path: string, init: RequestInit = {}): Promise<Reply> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(init.headers ?? {}),
      },
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) {
      this.cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON.
    }
    return { status: response.status, body };
  }
}

const codeOf = (reply: Reply): string | null => {
  const body = reply.body as {
    code?: unknown;
    error?: { code?: unknown };
  } | null;
  const code =
    body && typeof body === "object" ? (body.code ?? body.error?.code) : null;
  return typeof code === "string" ? code : null;
};

function email(index: number): string {
  return `load-user-${String(index).padStart(3, "0")}@factorsage.invalid`;
}

const PLANS = [
  { plan: "FREE", user: 1, concurrent: 1 },
  { plan: "STARTER", user: 5, concurrent: 1 },
  { plan: "PRO", user: 8, concurrent: 1 },
  { plan: "PRO_PLUS", user: 10, concurrent: 2 },
] as const;

async function signedIn(
  baseUrl: string,
  index: number,
  password: string,
): Promise<Client> {
  const client = new Client(baseUrl);
  const reply = await client.send("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: email(index), password }),
  });
  if (reply.status >= 400) {
    throw new Error(`${email(index)} could not sign in (${reply.status})`);
  }
  return client;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const password = process.env.LOAD_TEST_PASSWORD?.trim();
  if (!password) {
    throw new Error("LOAD_TEST_PASSWORD is required");
  }
  const endDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const startDate = `${Number(endDate.slice(0, 4)) - 1}${endDate.slice(4)}`;
  const results: Record<string, unknown>[] = [];
  const accepted: { client: Client; runId: string }[] = [];

  // A Guest submits nothing: the route requires a session.
  const guest = new Client(args.baseUrl);
  const guestReply = await guest.send("/backtests", {
    method: "POST",
    body: JSON.stringify({}),
  });
  results.push({
    probe: "guest-submission",
    expected: 401,
    status: guestReply.status,
    pass: guestReply.status === 401,
  });
  // A forged session cookie is a Guest.
  const forged = new Client(args.baseUrl);
  forged.cookie =
    "intrinsic_auth=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.forged";
  const forgedReply = await forged.send("/backtests");
  results.push({
    probe: "forged-cookie",
    expected: 401,
    status: forgedReply.status,
    pass: forgedReply.status === 401,
  });

  for (const entry of PLANS) {
    const client = await signedIn(args.baseUrl, entry.user, password);
    const lists = (await client.send("/lists")).body as {
      id: string;
      itemCount?: number;
    }[];
    const strategies = (await client.send("/strategies")).body as {
      id: string;
    }[];
    const list = lists[0];
    const strategy = strategies.at(-1);
    if (!list || !strategy) {
      throw new Error(`${entry.plan}: the setup's list or strategy is missing`);
    }
    // Several tabs at the same instant.
    const body = JSON.stringify({
      strategyId: strategy.id,
      stockListId: list.id,
      startDate,
      endDate,
      initialCapital: 100_000,
    });
    const replies = await Promise.all(
      Array.from({ length: args.tabs }, () =>
        client.send("/backtests", { method: "POST", body }),
      ),
    );
    const ok = replies.filter((reply) => reply.status === 202);
    for (const reply of ok) {
      accepted.push({ client, runId: (reply.body as { id: string }).id });
    }
    results.push({
      probe: "parallel-tabs",
      plan: entry.plan,
      tabs: args.tabs,
      allowance: entry.concurrent,
      accepted: ok.length,
      refusals: replies
        .filter((reply) => reply.status !== 202)
        .map(
          (reply) =>
            `${reply.status}${codeOf(reply) ? ` ${codeOf(reply)}` : ""}`,
        ),
      pass: ok.length === entry.concurrent,
    });

    // A client-declared plan is not read: the body is parsed strictly, and the plan is the server's.
    const declared = await client.send("/backtests", {
      method: "POST",
      body: JSON.stringify({
        strategyId: strategy.id,
        stockListId: list.id,
        startDate,
        endDate,
        initialCapital: 100_000,
        plan: "PRO_PLUS",
        concurrentBacktests: 99,
      }),
    });
    results.push({
      probe: "client-declared-plan",
      plan: entry.plan,
      status: declared.status,
      code: codeOf(declared),
      pass: declared.status !== 202 || entry.concurrent > ok.length,
    });
    if (declared.status === 202) {
      accepted.push({ client, runId: (declared.body as { id: string }).id });
    }
    // Another user's list is not found, never run.
    const other = PLANS.find((candidate) => candidate.user !== entry.user)!;
    const otherClient = await signedIn(args.baseUrl, other.user, password);
    const otherList = (
      (await otherClient.send("/lists")).body as { id: string }[]
    )[0];
    const foreign = await client.send("/backtests", {
      method: "POST",
      body: JSON.stringify({
        strategyId: strategy.id,
        stockListId: otherList?.id,
        startDate,
        endDate,
        initialCapital: 100_000,
      }),
    });
    results.push({
      probe: "foreign-list",
      plan: entry.plan,
      status: foreign.status,
      code: codeOf(foreign),
      pass: foreign.status === 404 || foreign.status === 400,
    });
    if (foreign.status === 202) {
      accepted.push({ client, runId: (foreign.body as { id: string }).id });
    }
  }

  // Free: an eleventh security on a ten-security List is refused at the List.
  const free = await signedIn(args.baseUrl, 1, password);
  const freeList = ((await free.send("/lists")).body as { id: string }[])[0];
  const candidate = (await free.send("/stocks/SYN0700")).body as {
    id?: string;
    security?: { id?: string };
  };
  const securityId = candidate?.security?.id ?? candidate?.id;
  if (freeList && securityId) {
    const add = await free.send(`/lists/${freeList.id}/items`, {
      method: "POST",
      body: JSON.stringify({ securityIds: [securityId] }),
    });
    results.push({
      probe: "free-list-over-limit",
      status: add.status,
      code: codeOf(add),
      pass: add.status === 403 || add.status === 409 || add.status === 422,
    });
  } else {
    results.push({
      probe: "free-list-over-limit",
      skipped: "no list or security id",
      pass: null,
    });
  }

  // Queue saturation (`--saturate N`, run with no worker executing): one submission from each of N
  // users, a second from each Pro+ user, at once. Beyond `BACKTEST_QUEUE_MAX_QUEUED` waiting runs
  // the API must refuse with 503 BACKTEST_QUEUE_FULL and a Retry-After, and accept nothing more.
  if (args.saturate > 0) {
    const clients = await Promise.all(
      Array.from({ length: args.saturate }, (_, index) =>
        signedIn(args.baseUrl, index + 1, password),
      ),
    );
    const submissions = await Promise.all(
      clients.flatMap((client, index) => {
        const plan = [
          "FREE",
          "FREE",
          "FREE",
          "FREE",
          "STARTER",
          "STARTER",
          "STARTER",
          "PRO",
          "PRO",
          "PRO_PLUS",
        ][index % 10];
        return Array.from({ length: plan === "PRO_PLUS" ? 2 : 1 }, async () => {
          const lists = (await client.send("/lists")).body as { id: string }[];
          const strategies = (await client.send("/strategies")).body as {
            id: string;
          }[];
          const response = await fetch(`${args.baseUrl}/backtests`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              cookie: client.cookie,
            },
            body: JSON.stringify({
              strategyId: strategies.at(-1)?.id,
              stockListId: lists[0]?.id,
              startDate,
              endDate,
              initialCapital: 100_000,
            }),
          });
          const text = await response.text();
          const body = (() => {
            try {
              return JSON.parse(text) as { id?: string; code?: string };
            } catch {
              return {};
            }
          })();
          if (response.status === 202 && body.id) {
            accepted.push({ client, runId: body.id });
          }
          return {
            status: response.status,
            code: body.code ?? null,
            retryAfter: response.headers.get("retry-after"),
          };
        });
      }),
    );
    const statuses: Record<string, number> = {};
    for (const entry of submissions) {
      const key = `${entry.status}${entry.code ? ` ${entry.code}` : ""}`;
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    const full = submissions.filter((entry) => entry.status === 503);
    results.push({
      probe: "queue-saturation",
      submissions: submissions.length,
      statuses,
      retryAfter: [...new Set(full.map((entry) => entry.retryAfter))],
      accepted: submissions.filter((entry) => entry.status === 202).length,
      pass: full.length > 0 && full.every((entry) => entry.retryAfter !== null),
    });
  }

  // Clean up: every accepted run is cancelled.
  const cancelled = await Promise.all(
    accepted.map(
      async ({ client, runId }) =>
        (await client.send(`/backtests/${runId}/cancel`, { method: "POST" }))
          .status,
    ),
  );
  const report = {
    recordedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    probes: results,
    passed: results.filter((entry) => entry.pass === true).length,
    failed: results.filter((entry) => entry.pass === false).length,
    cancelledRuns: cancelled.length,
    cancelStatuses: [...new Set(cancelled)],
  };
  const path = resolve(repositoryRoot(), args.report);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(report)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
