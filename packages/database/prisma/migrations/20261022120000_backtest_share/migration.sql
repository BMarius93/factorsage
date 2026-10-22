-- Additive: one public, read-only link per completed backtest run, while its owner shares it
-- (docs/decisions/backtest-sharing-v1.md). Revoking deletes the row, so the token stops resolving
-- immediately; sharing again inserts a new row with a new token. The run id is the primary key, so
-- a run can never hold two active links. Nothing is copied from the run and no existing row changes.
-- CreateTable
CREATE TABLE "BacktestShare" (
    "runId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestShare_pkey" PRIMARY KEY ("runId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BacktestShare_token_key" ON "BacktestShare"("token");

-- AddForeignKey
ALTER TABLE "BacktestShare" ADD CONSTRAINT "BacktestShare_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BacktestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
