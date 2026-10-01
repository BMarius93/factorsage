-- Re-base-safe price loading (`docs/decisions/historical-price-basis-v1.md`, PR 1).
--
-- `SecurityPriceBasis` is one row per security whose stored research history the loader has
-- verified against the provider's. Its `generation` increases on every replacement of that history
-- after a re-base; a backtest pins it and a Monitor cycle compares it, so one generation is one
-- consistent price basis. `PriceBasisEvent` records, append-only, each step the comparison of a
-- re-based history with the stored one measured: its effective date (or the interval it lies in
-- when it fell between two reads) and the stored close over the new close of the rows before it,
-- or an unexplained change.
--
-- Additive only. No existing row is touched: a security gets its basis row the first time the
-- loader verifies it, and `DailyPrice`, `WeeklyPrice` and `PRICE_DATASET_VERSION` are unchanged.

-- CreateEnum
CREATE TYPE "PriceBasisEventKind" AS ENUM ('MEASURED', 'UNEXPLAINED');

-- CreateTable
CREATE TABLE "SecurityPriceBasis" (
    "securityId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityPriceBasis_pkey" PRIMARY KEY ("securityId")
);

-- CreateTable
CREATE TABLE "PriceBasisEvent" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "kind" "PriceBasisEventKind" NOT NULL,
    "effectiveDate" DATE,
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "priceRatio" DECIMAL(24,12),
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "PriceBasisEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceBasisEvent_securityId_generation_idx" ON "PriceBasisEvent"("securityId", "generation");

-- AddForeignKey
ALTER TABLE "SecurityPriceBasis" ADD CONSTRAINT "SecurityPriceBasis_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceBasisEvent" ADD CONSTRAINT "PriceBasisEvent_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

