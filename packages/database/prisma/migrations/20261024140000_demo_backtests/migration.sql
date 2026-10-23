-- Operator-featured demonstration backtests (docs/decisions/entitlements-v2.md §4): a curated
-- subset of shared reports, listed publicly for Guests. Additive only.
CREATE TABLE "DemoBacktest" (
    "runId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoBacktest_pkey" PRIMARY KEY ("runId")
);

CREATE INDEX "DemoBacktest_position_createdAt_idx" ON "DemoBacktest"("position", "createdAt");

ALTER TABLE "DemoBacktest" ADD CONSTRAINT "DemoBacktest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestShare"("runId") ON DELETE CASCADE ON UPDATE CASCADE;
