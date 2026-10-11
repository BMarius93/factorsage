-- ETF market data V1 (`docs/decisions/etf-market-data-v1.md`).
--
-- `BenchmarkSeriesPriceBasis` and `BenchmarkPriceBasisEvent` give the ETF benchmark series the
-- re-base protection `docs/decisions/historical-price-basis-v1.md` §12 requires before another ETF
-- proxy is added: a generation that increases on every replacement of a series' stored history
-- after a measured split re-base, and the append-only record of what each replacement measured.
-- They mirror `SecurityPriceBasis` and `PriceBasisEvent`, keyed by series because a benchmark is
-- never a `Security`, and reuse the `PriceBasisEventKind` enum.
--
-- `MarketDataRefreshSchedule` is the singleton durable claim the worker's market-data child takes
-- to refresh the ETF histories: the third instance of the `FOR UPDATE SKIP LOCKED` + renewable
-- lease idiom (`AGENTS.md` invariant 15), with the same columns as `MonitorScanSchedule`.
--
-- Additive only. No existing row or column is touched, no backfill is needed: a series without a
-- basis row is generation 0, and the schedule row is created by the first market-data child with
-- `INSERT ... ON CONFLICT DO NOTHING`. `BENCHMARK_PRICE_DATASET_VERSION` is unchanged, so no
-- coverage is invalidated and nothing is re-fetched.

-- CreateTable
CREATE TABLE "BenchmarkSeriesPriceBasis" (
    "seriesId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "replacedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenchmarkSeriesPriceBasis_pkey" PRIMARY KEY ("seriesId")
);

-- CreateTable
CREATE TABLE "BenchmarkPriceBasisEvent" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "kind" "PriceBasisEventKind" NOT NULL,
    "effectiveDate" DATE,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "priceRatio" DECIMAL(24,12),
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "BenchmarkPriceBasisEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketDataRefreshSchedule" (
    "id" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "runSequence" INTEGER NOT NULL DEFAULT 0,
    "lastStartedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketDataRefreshSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BenchmarkPriceBasisEvent_seriesId_generation_idx" ON "BenchmarkPriceBasisEvent"("seriesId", "generation");

-- CreateIndex
CREATE INDEX "MarketDataRefreshSchedule_dueAt_idx" ON "MarketDataRefreshSchedule"("dueAt");

-- AddForeignKey
ALTER TABLE "BenchmarkSeriesPriceBasis" ADD CONSTRAINT "BenchmarkSeriesPriceBasis_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "BenchmarkSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkPriceBasisEvent" ADD CONSTRAINT "BenchmarkPriceBasisEvent_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "BenchmarkSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

