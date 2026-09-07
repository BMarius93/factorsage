-- CreateTable
CREATE TABLE "Strategy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Strategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StrategyVersion" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Strategy_userId_idx" ON "Strategy"("userId");

-- CreateIndex
CREATE INDEX "Strategy_userId_updatedAt_idx" ON "Strategy"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "StrategyVersion_strategyId_idx" ON "StrategyVersion"("strategyId");

-- CreateIndex
CREATE UNIQUE INDEX "StrategyVersion_strategyId_versionNumber_key" ON "StrategyVersion"("strategyId", "versionNumber");

-- AddForeignKey
ALTER TABLE "Strategy" ADD CONSTRAINT "Strategy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StrategyVersion" ADD CONSTRAINT "StrategyVersion_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
