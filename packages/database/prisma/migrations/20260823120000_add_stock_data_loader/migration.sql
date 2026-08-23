-- CreateEnum
CREATE TYPE "SecurityType" AS ENUM ('STOCK', 'ETF', 'FUND');

-- CreateEnum
CREATE TYPE "StockDataset" AS ENUM ('SECURITY_PROFILE', 'DAILY_PRICE', 'DAILY_TECHNICAL', 'WEEKLY_PRICE', 'WEEKLY_TECHNICAL', 'INCOME_STATEMENT', 'BALANCE_SHEET', 'CASH_FLOW', 'DIVIDEND', 'STOCK_SPLIT', 'INTRINSIC_VALUE', 'INTRINSIC_VALUE_BLEND');

-- CreateEnum
CREATE TYPE "MovingAverageType" AS ENUM ('SMA', 'EMA');

-- CreateEnum
CREATE TYPE "IntrinsicValueModel" AS ENUM ('DCF_FCFF', 'RESIDUAL_INCOME', 'DDM', 'GRAHAM');

-- CreateEnum
CREATE TYPE "IntrinsicValueBlendId" AS ENUM ('BALANCED', 'CONSERVATIVE', 'DIVIDEND');

-- CreateTable
CREATE TABLE "Security" (
    "id" TEXT NOT NULL,
    "providerSymbol" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "exchangeCode" TEXT NOT NULL,
    "exchangeName" TEXT,
    "currency" TEXT NOT NULL,
    "cik" TEXT,
    "isin" TEXT,
    "cusip" TEXT,
    "country" TEXT,
    "sector" TEXT,
    "industry" TEXT,
    "ipoDate" DATE,
    "type" "SecurityType" NOT NULL,
    "isAdr" BOOLEAN NOT NULL,
    "isActivelyTrading" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Security_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityProfile" (
    "securityId" TEXT NOT NULL,
    "description" TEXT,
    "website" TEXT,
    "logoUrl" TEXT,
    "ceo" TEXT,
    "employees" INTEGER,
    "addressStreet" TEXT,
    "addressCity" TEXT,
    "addressState" TEXT,
    "postalCode" TEXT,
    "addressCountry" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityProfile_pkey" PRIMARY KEY ("securityId")
);

-- CreateTable
CREATE TABLE "StockDatasetState" (
    "securityId" TEXT NOT NULL,
    "dataset" "StockDataset" NOT NULL,
    "variant" TEXT NOT NULL DEFAULT '',
    "earliestDate" DATE,
    "latestDate" DATE,
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "calculationVersion" INTEGER,

    CONSTRAINT "StockDatasetState_pkey" PRIMARY KEY ("securityId","dataset","variant")
);

-- CreateTable
CREATE TABLE "DailyPrice" (
    "securityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" DECIMAL(20,8) NOT NULL,
    "high" DECIMAL(20,8) NOT NULL,
    "low" DECIMAL(20,8) NOT NULL,
    "close" DECIMAL(20,8) NOT NULL,
    "volume" BIGINT NOT NULL,
    "vwap" DECIMAL(20,8),

    CONSTRAINT "DailyPrice_pkey" PRIMARY KEY ("securityId","date")
);

-- CreateTable
CREATE TABLE "DailyTechnical" (
    "securityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sma20d" DECIMAL(20,8),
    "sma50d" DECIMAL(20,8),
    "sma100d" DECIMAL(20,8),
    "sma200d" DECIMAL(20,8),
    "ema20d" DECIMAL(20,8),
    "ema50d" DECIMAL(20,8),
    "ema200d" DECIMAL(20,8),
    "calculationVersion" INTEGER NOT NULL,

    CONSTRAINT "DailyTechnical_pkey" PRIMARY KEY ("securityId","date","calculationVersion")
);

-- CreateTable
CREATE TABLE "WeeklyPrice" (
    "securityId" TEXT NOT NULL,
    "weekStartDate" DATE NOT NULL,
    "weekEndDate" DATE NOT NULL,
    "eligibleDate" DATE NOT NULL,
    "open" DECIMAL(20,8) NOT NULL,
    "high" DECIMAL(20,8) NOT NULL,
    "low" DECIMAL(20,8) NOT NULL,
    "close" DECIMAL(20,8) NOT NULL,
    "volume" BIGINT NOT NULL,
    "calculationVersion" INTEGER NOT NULL,

    CONSTRAINT "WeeklyPrice_pkey" PRIMARY KEY ("securityId","weekStartDate","calculationVersion")
);

-- CreateTable
CREATE TABLE "WeeklyTechnical" (
    "securityId" TEXT NOT NULL,
    "weekStartDate" DATE NOT NULL,
    "eligibleDate" DATE NOT NULL,
    "type" "MovingAverageType" NOT NULL,
    "period" INTEGER NOT NULL,
    "value" DECIMAL(20,8) NOT NULL,
    "calculationVersion" INTEGER NOT NULL,

    CONSTRAINT "WeeklyTechnical_pkey" PRIMARY KEY ("securityId","weekStartDate","type","period","calculationVersion")
);

-- CreateTable
CREATE TABLE "IntrinsicValue" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "valuationDate" DATE NOT NULL,
    "sourceDataAsOf" TIMESTAMP(3) NOT NULL,
    "model" "IntrinsicValueModel" NOT NULL,
    "valuePerShare" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "calculationVersion" INTEGER NOT NULL,

    CONSTRAINT "IntrinsicValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntrinsicValueBlend" (
    "id" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "valuationDate" DATE NOT NULL,
    "sourceDataAsOf" TIMESTAMP(3) NOT NULL,
    "blendId" "IntrinsicValueBlendId" NOT NULL,
    "valuePerShare" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "calculationVersion" INTEGER NOT NULL,
    "blendVersion" INTEGER NOT NULL,

    CONSTRAINT "IntrinsicValueBlend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Security_providerSymbol_key" ON "Security"("providerSymbol");
CREATE INDEX "Security_symbol_idx" ON "Security"("symbol");
CREATE UNIQUE INDEX "Security_symbol_exchangeCode_key" ON "Security"("symbol", "exchangeCode");
CREATE INDEX "DailyPrice_securityId_date_idx" ON "DailyPrice"("securityId", "date");
CREATE INDEX "DailyTechnical_securityId_calculationVersion_date_idx" ON "DailyTechnical"("securityId", "calculationVersion", "date");
CREATE INDEX "WeeklyPrice_securityId_eligibleDate_idx" ON "WeeklyPrice"("securityId", "eligibleDate");
CREATE INDEX "WeeklyTechnical_securityId_type_period_eligibleDate_idx" ON "WeeklyTechnical"("securityId", "type", "period", "eligibleDate");
CREATE UNIQUE INDEX "IntrinsicValue_securityId_valuationDate_sourceDataAsOf_model_calculationVersion_key" ON "IntrinsicValue"("securityId", "valuationDate", "sourceDataAsOf", "model", "calculationVersion");
CREATE INDEX "IntrinsicValue_securityId_model_valuationDate_sourceDataAsOf_idx" ON "IntrinsicValue"("securityId", "model", "valuationDate", "sourceDataAsOf");
CREATE UNIQUE INDEX "IntrinsicValueBlend_securityId_valuationDate_sourceDataAsOf_blendId_blendVersion_calculationVersion_key" ON "IntrinsicValueBlend"("securityId", "valuationDate", "sourceDataAsOf", "blendId", "blendVersion", "calculationVersion");
CREATE INDEX "IntrinsicValueBlend_securityId_blendId_blendVersion_valuationDate_sourceDataAsOf_idx" ON "IntrinsicValueBlend"("securityId", "blendId", "blendVersion", "valuationDate", "sourceDataAsOf");

-- AddForeignKey
ALTER TABLE "SecurityProfile" ADD CONSTRAINT "SecurityProfile_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockDatasetState" ADD CONSTRAINT "StockDatasetState_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyPrice" ADD CONSTRAINT "DailyPrice_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyTechnical" ADD CONSTRAINT "DailyTechnical_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeeklyPrice" ADD CONSTRAINT "WeeklyPrice_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WeeklyTechnical" ADD CONSTRAINT "WeeklyTechnical_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntrinsicValue" ADD CONSTRAINT "IntrinsicValue_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntrinsicValueBlend" ADD CONSTRAINT "IntrinsicValueBlend_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;