-- Backtest cancellation and deployment-wide admission (ai/architecture/backtest-execution.md,
-- "Global admission" and "Cancellation"). Additive: no existing row changes status.

-- A run its owner stopped. Terminal: no result, never reclaimed, never requeued.
-- AlterEnum
ALTER TYPE "BacktestRunStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "BacktestJobStatus" ADD VALUE 'CANCELLED';

-- A cancellation requested while a worker holds the job. The job stays CLAIMED, and keeps its
-- execution slot, until the holder stops at a checkpoint or its lease expires.
-- AlterTable
ALTER TABLE "BacktestJob" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3);
