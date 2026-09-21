-- CreateEnum
CREATE TYPE "LegalDocumentKind" AS ENUM ('TERMS', 'PRIVACY', 'COOKIES', 'RISK_DISCLOSURE', 'CANCELLATION_AND_REFUNDS', 'CONTACT');

-- CreateEnum
CREATE TYPE "LegalRecordKind" AS ENUM ('ACCEPTED', 'NOTICE_PRESENTED');

-- CreateEnum
CREATE TYPE "LegalAcceptanceSurface" AS ENUM ('EMAIL_ACTIVATION', 'GOOGLE_ONBOARDING', 'EXISTING_ACCOUNT');

-- CreateEnum
CREATE TYPE "LegalRequestKind" AS ENUM ('PRIVACY_REQUEST', 'WITHDRAWAL', 'NONCONFORMITY', 'SUPPORT');

-- CreateEnum
CREATE TYPE "LegalRequestStatus" AS ENUM ('RECEIVED');

-- CreateTable
CREATE TABLE "LegalRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentKind" "LegalDocumentKind" NOT NULL,
    "documentVersion" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "record" "LegalRecordKind" NOT NULL,
    "surface" "LegalAcceptanceSurface" NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LegalRequestKind" NOT NULL,
    "status" "LegalRequestStatus" NOT NULL DEFAULT 'RECEIVED',
    "details" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalRecord_userId_idx" ON "LegalRecord"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalRecord_userId_documentKind_documentVersion_key" ON "LegalRecord"("userId", "documentKind", "documentVersion");

-- CreateIndex
CREATE UNIQUE INDEX "LegalRequest_reference_key" ON "LegalRequest"("reference");

-- CreateIndex
CREATE INDEX "LegalRequest_userId_submittedAt_idx" ON "LegalRequest"("userId", "submittedAt");

-- AddForeignKey
ALTER TABLE "LegalRecord" ADD CONSTRAINT "LegalRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalRequest" ADD CONSTRAINT "LegalRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

