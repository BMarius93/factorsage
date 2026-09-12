-- CreateEnum
CREATE TYPE "UserPlan" AS ENUM ('FREE', 'STARTER', 'PRO');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plan" "UserPlan" NOT NULL DEFAULT 'FREE';
