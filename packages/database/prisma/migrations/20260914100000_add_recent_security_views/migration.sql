-- CreateTable
CREATE TABLE "RecentSecurityView" (
    "userId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentSecurityView_pkey" PRIMARY KEY ("userId","securityId")
);

-- CreateIndex
CREATE INDEX "RecentSecurityView_userId_viewedAt_idx" ON "RecentSecurityView"("userId", "viewedAt" DESC);

-- AddForeignKey
ALTER TABLE "RecentSecurityView" ADD CONSTRAINT "RecentSecurityView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentSecurityView" ADD CONSTRAINT "RecentSecurityView_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "Security"("id") ON DELETE CASCADE ON UPDATE CASCADE;

