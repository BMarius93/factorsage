-- CreateEnum
CREATE TYPE "FinancialStatementType" AS ENUM ('INCOME', 'BALANCE_SHEET', 'CASH_FLOW');

-- CreateEnum
CREATE TYPE "FinancialPeriod" AS ENUM ('FY', 'Q1', 'Q2', 'Q3', 'Q4');

-- CreateTable
CREATE TABLE "FinancialStatement" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "statementType" "FinancialStatementType" NOT NULL,
    "fiscalDate" DATE NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "period" "FinancialPeriod" NOT NULL,
    "reportedCurrency" TEXT NOT NULL,
    "filingDate" DATE NOT NULL,
    "availableFromDate" DATE NOT NULL,
    "providerAcceptedDate" TEXT,
    "contentHash" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "values" JSONB NOT NULL,

    CONSTRAINT "FinancialStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialStatement_securityId_statementType_fiscalDate_period_filingDate_contentHash_key" ON "FinancialStatement"("securityId", "statementType", "fiscalDate", "period", "filingDate", "contentHash");
CREATE INDEX "FinancialStatement_securityId_statementType_period_fiscalDate_idx" ON "FinancialStatement"("securityId", "statementType", "period", "fiscalDate");
CREATE INDEX "FinancialStatement_securityId_statementType_period_availableFromDate_idx" ON "FinancialStatement"("securityId", "statementType", "period", "availableFromDate");

-- AddForeignKey
ALTER TABLE "FinancialStatement" ADD CONSTRAINT "FinancialStatement_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;