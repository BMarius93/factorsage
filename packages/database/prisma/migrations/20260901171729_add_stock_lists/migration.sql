-- CreateEnum
CREATE TYPE "BuyWindowMode" AS ENUM ('FULL', 'CUSTOM');

-- CreateTable
CREATE TABLE "StockList" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockListItem" (
    "id" TEXT NOT NULL,
    "stockListId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "buyWindowMode" "BuyWindowMode" NOT NULL DEFAULT 'FULL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockListItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockListBuyWindow" (
    "id" TEXT NOT NULL,
    "stockListItemId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,

    CONSTRAINT "StockListBuyWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockList_userId_idx" ON "StockList"("userId");

-- CreateIndex
CREATE INDEX "StockListItem_securityId_idx" ON "StockListItem"("securityId");

-- CreateIndex
CREATE UNIQUE INDEX "StockListItem_stockListId_securityId_key" ON "StockListItem"("stockListId", "securityId");

-- CreateIndex
CREATE UNIQUE INDEX "StockListBuyWindow_stockListItemId_startDate_key" ON "StockListBuyWindow"("stockListItemId", "startDate");

-- AddForeignKey
ALTER TABLE "StockList" ADD CONSTRAINT "StockList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockListItem" ADD CONSTRAINT "StockListItem_stockListId_fkey" FOREIGN KEY ("stockListId") REFERENCES "StockList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockListItem" ADD CONSTRAINT "StockListItem_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockListBuyWindow" ADD CONSTRAINT "StockListBuyWindow_stockListItemId_fkey" FOREIGN KEY ("stockListItemId") REFERENCES "StockListItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "FinancialStatement_securityId_statementType_fiscalDate_period_f" RENAME TO "FinancialStatement_securityId_statementType_fiscalDate_peri_key";

-- RenameIndex
ALTER INDEX "FinancialStatement_securityId_statementType_period_availableFro" RENAME TO "FinancialStatement_securityId_statementType_period_availabl_idx";

-- RenameIndex
ALTER INDEX "FinancialStatement_securityId_statementType_period_fiscalDate_i" RENAME TO "FinancialStatement_securityId_statementType_period_fiscalDa_idx";
