-- CreateTable
CREATE TABLE "StockDatasetCoverage" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "dataset" "StockDataset" NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "lastSuccessfulSyncAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockDatasetCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockDatasetCoverage_range_key" ON "StockDatasetCoverage"("securityId", "dataset", "variant", "fromDate", "toDate");
CREATE INDEX "StockDatasetCoverage_lookup_idx" ON "StockDatasetCoverage"("securityId", "dataset", "variant", "fromDate", "toDate");

-- AddForeignKey
ALTER TABLE "StockDatasetCoverage" ADD CONSTRAINT "StockDatasetCoverage_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;