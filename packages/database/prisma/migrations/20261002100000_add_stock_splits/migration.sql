-- Valuation Ratios V1 (`docs/decisions/valuation-ratios-v1.md`, PR 2V).
--
-- `StockSplit` holds the provider's split list for a security, replaced whole each time it is read:
-- the only provider record of the adjustments folded into the research close. The valuation ratios'
-- price-basis rules read it to withhold the sessions a listed distribution makes unsafe; nothing
-- else does. Freshness is the existing `StockDatasetState` row of dataset `STOCK_SPLIT`.
--
-- Additive only. No existing row is touched, and no valuation value is stored: the ratios are
-- projected when they are read.

-- CreateTable
CREATE TABLE "StockSplit" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "numerator" DECIMAL(24,12) NOT NULL,
    "denominator" DECIMAL(24,12) NOT NULL,
    "label" TEXT,

    CONSTRAINT "StockSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockSplit_securityId_date_idx" ON "StockSplit"("securityId", "date");

-- AddForeignKey
ALTER TABLE "StockSplit" ADD CONSTRAINT "StockSplit_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

