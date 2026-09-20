-- CreateEnum
CREATE TYPE "BacktestTradeSource" AS ENUM ('STRATEGY', 'END_OF_BACKTEST');

-- AlterTable
ALTER TABLE "BacktestTrade" ADD COLUMN     "exitRuleId" TEXT,
ADD COLUMN     "source" "BacktestTradeSource" NOT NULL DEFAULT 'STRATEGY';

