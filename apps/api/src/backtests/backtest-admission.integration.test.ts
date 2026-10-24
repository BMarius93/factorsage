import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  newYorkDate,
  STRATEGY_SCHEMA_VERSION,
  type BacktestRunDetailResponse,
  type StrategyDefinition,
  type UserPlan,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { BenchmarksModule } from "../benchmarks/benchmarks.module";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { EMAIL_SENDER } from "../email/email-sender";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { ListsModule } from "../lists/lists.module";
import { StrategiesModule } from "../strategies/strategies.module";
import { BacktestsModule } from "./backtests.module";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

/**
 * Cancellation and deployment-wide admission, over HTTP against real PostgreSQL
 * (`ai/architecture/backtest-execution.md`, "Cancellation" and "Global admission").
 *
 * No worker runs here: a job is put into its claimed state by hand where a case needs one, which
 * is how the API meets it in production — a row some worker process holds.
 */
describe("backtest admission and cancellation", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  let app: INestApplication;
  let prisma: PrismaService;

  const agents = new Map<string, ReturnType<typeof request.agent>>();
  const userIdOf = new Map<string, string>();
  const securityIds: string[] = [];

  function agentOf(name: string) {
    const agent = agents.get(name);
    if (!agent) {
      throw new Error(`Unknown persona ${name}`);
    }
    return agent;
  }

  function definition(): StrategyDefinition {
    return {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: `buy-${randomUUID()}`,
          percentage: 25,
          signal: {
            conditions: [
              {
                id: `condition-${randomUUID()}`,
                metric: { kind: "PRICE" },
                operator: "IS_BELOW",
                value: { kind: "SERIES", seriesId: "SMA_200D" },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    };
  }

  async function submission(as: string) {
    const endDate = newYorkDate(new Date());
    const start = new Date(`${endDate}T00:00:00.000Z`);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    const list = await agentOf(as)
      .post("/lists")
      .send({ name: `Universe ${randomUUID().slice(0, 8)}`, securityIds })
      .expect(201);
    const strategy = await agentOf(as)
      .post("/strategies")
      .send({ name: `Strategy ${randomUUID().slice(0, 8)}`, definition: definition() })
      .expect(201);
    return {
      strategyId: (strategy.body as { id: string }).id,
      stockListId: (list.body as { id: string }).id,
      startDate: start.toISOString().slice(0, 10),
      endDate,
      initialCapital: 100_000,
      monthlyContribution: 0,
      maximumPositions: 10,
    };
  }

  async function submit(as: string): Promise<BacktestRunDetailResponse> {
    const response = await agentOf(as)
      .post("/backtests")
      .send(await submission(as))
      .expect(202);
    return response.body as BacktestRunDetailResponse;
  }

  /** What a worker's claim does to the job and run rows. */
  async function markClaimed(runId: string): Promise<void> {
    const now = new Date();
    await prisma.backtestJob.update({
      where: { runId },
      data: {
        status: "CLAIMED",
        claimedBy: `admission-test-${suffix}`,
        claimedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        attempts: 1,
      },
    });
    await prisma.backtestRun.update({
      where: { id: runId },
      data: { status: "RUNNING", startedAt: now },
    });
  }

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET = "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        DatabaseModule,
        AuthModule,
        EntitlementsModule,
        ListsModule,
        StrategiesModule,
        BacktestsModule,
        BenchmarksModule,
      ],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue(new InMemoryEmailSender())
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);

    const personas: { name: string; plan: UserPlan }[] = [
      { name: "free", plan: "FREE" },
      { name: "other", plan: "FREE" },
      { name: "proplus", plan: "PRO_PLUS" },
    ];
    for (const persona of personas) {
      const email = `admission-${persona.name}-${suffix}@example.test`;
      const user = await prisma.user.create({
        data: { email, passwordHash, emailVerifiedAt: new Date(), plan: persona.plan },
        select: { id: true },
      });
      userIdOf.set(persona.name, user.id);
      const agent = request.agent(app.getHttpServer());
      await agent.post("/auth/login").send({ email, password }).expect(200);
      agents.set(persona.name, agent);
    }

    for (let index = 0; index < 2; index += 1) {
      const security = await prisma.security.create({
        data: {
          providerSymbol: `ADM${index}-${suffix}`,
          symbol: `ADM${index}-${suffix.slice(0, 6).toUpperCase()}`,
          name: `Admission Fixture ${index}`,
          exchangeCode: "NASDAQ",
          exchangeName: "NASDAQ Global Select",
          currency: "USD",
          type: "STOCK",
          isAdr: false,
          isActivelyTrading: true,
        },
        select: { id: true },
      });
      securityIds.push(security.id);
    }
  });

  afterEach(async () => {
    delete process.env.BACKTEST_QUEUE_MAX_QUEUED;
    await prisma.backtestRun.deleteMany({
      where: { userId: { in: [...userIdOf.values()] } },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.backtestRun.deleteMany({
        where: { userId: { in: [...userIdOf.values()] } },
      });
      await prisma.user.deleteMany({ where: { id: { in: [...userIdOf.values()] } } });
      await prisma.security.deleteMany({ where: { id: { in: securityIds } } });
    }
    if (app) {
      await app.close();
    }
  });

  it("cancels a queued run at once and gives the owner their slot back", async () => {
    const run = await submit("free");
    // FREE runs one at a time: a second submission is refused while the first is queued.
    await agentOf("free").post("/backtests").send(await submission("free")).expect(403);

    const cancelled = await agentOf("free").post(`/backtests/${run.id}/cancel`).expect(200);
    const body = cancelled.body as BacktestRunDetailResponse;
    expect(body.status).toBe("CANCELLED");
    expect(body.completedAt).not.toBeNull();
    expect(body.result).toBeNull();
    expect(body.cancellation).toBeUndefined();
    expect(
      (await prisma.backtestJob.findUniqueOrThrow({ where: { runId: run.id } })).status,
    ).toBe("CANCELLED");

    // The slot is free: a new run is admitted immediately.
    await agentOf("free").post("/backtests").send(await submission("free")).expect(202);
  });

  it("records a pending cancellation on an executing run, which keeps its slot until the worker stops", async () => {
    const run = await submit("free");
    await markClaimed(run.id);

    const response = await agentOf("free").post(`/backtests/${run.id}/cancel`).expect(200);
    const body = response.body as BacktestRunDetailResponse;
    expect(body.status).toBe("RUNNING");
    expect(body.cancellation?.requestedAt).toBeTruthy();
    const job = await prisma.backtestJob.findUniqueOrThrow({ where: { runId: run.id } });
    expect(job.status).toBe("CLAIMED");
    expect(job.cancelRequestedAt).not.toBeNull();

    // Still executing, so still in flight: the plan's one slot is not yet free.
    await agentOf("free").post("/backtests").send(await submission("free")).expect(403);
    // The polling payload says the same, so the running page can show it.
    const progress = await agentOf("free").get(`/backtests/${run.id}/progress`).expect(200);
    expect((progress.body as { cancellation?: unknown }).cancellation).toBeTruthy();
  });

  it("is idempotent", async () => {
    const run = await submit("free");
    await agentOf("free").post(`/backtests/${run.id}/cancel`).expect(200);
    const again = await agentOf("free").post(`/backtests/${run.id}/cancel`).expect(200);
    expect((again.body as BacktestRunDetailResponse).status).toBe("CANCELLED");
  });

  it("refuses to cancel a finished run", async () => {
    const run = await submit("free");
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    const refused = await agentOf("free").post(`/backtests/${run.id}/cancel`).expect(409);
    expect((refused.body as { code: string }).code).toBe("BACKTEST_NOT_CANCELLABLE");
  });

  it("answers another user's run exactly like a missing one", async () => {
    const run = await submit("free");
    await agentOf("other").post(`/backtests/${run.id}/cancel`).expect(404);
    await agentOf("other").post(`/backtests/${randomUUID()}/cancel`).expect(404);
    expect(
      (await prisma.backtestRun.findUniqueOrThrow({ where: { id: run.id } })).status,
    ).toBe("QUEUED");
  });

  it("refuses a submission with 503 and Retry-After while the deployment-wide queue is full", async () => {
    const queued = await prisma.backtestJob.count({ where: { status: "QUEUED" } });
    process.env.BACKTEST_QUEUE_MAX_QUEUED = String(queued + 1);

    await submit("proplus");
    const refused = await agentOf("proplus")
      .post("/backtests")
      .send(await submission("proplus"))
      .expect(503);
    expect((refused.body as { code: string }).code).toBe("BACKTEST_QUEUE_FULL");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // Nothing was created by the refused submission.
    expect(
      await prisma.backtestRun.count({ where: { userId: userIdOf.get("proplus") } }),
    ).toBe(1);
  });

  it("reports where a queued run stands, and nothing once it is executing", async () => {
    const run = await submit("free");
    expect(run.queue).toBeDefined();
    expect(run.queue?.capacity).toBeGreaterThan(0);
    expect(run.queue?.ahead).toBeGreaterThanOrEqual(0);

    await markClaimed(run.id);
    const detail = (await agentOf("free").get(`/backtests/${run.id}`).expect(200))
      .body as BacktestRunDetailResponse;
    expect(detail.queue).toBeUndefined();
  });

  it("lists cancelled runs under their own filter and not under ACTIVE", async () => {
    const run = await submit("free");
    await agentOf("free").post(`/backtests/${run.id}/cancel`).expect(200);

    const active = await agentOf("free").get("/backtests?status=ACTIVE").expect(200);
    expect((active.body as { id: string }[]).map((row) => row.id)).not.toContain(run.id);
    const cancelled = await agentOf("free").get("/backtests?status=CANCELLED").expect(200);
    expect((cancelled.body as { id: string }[]).map((row) => row.id)).toContain(run.id);
  });
});
