-- CreateEnum
CREATE TYPE "VisitKind" AS ENUM ('STAY', 'TAKEOUT');

-- DropForeignKey
ALTER TABLE "Visit" DROP CONSTRAINT "Visit_customerId_fkey";

-- DropForeignKey
ALTER TABLE "Visit" DROP CONSTRAINT "Visit_lockerId_fkey";

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "kind" "VisitKind" NOT NULL DEFAULT 'STAY',
ADD COLUMN     "takeoutName" TEXT,
ADD COLUMN     "takeoutNumber" INTEGER,
ALTER COLUMN "customerId" DROP NOT NULL,
ALTER COLUMN "lockerId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_lockerId_fkey" FOREIGN KEY ("lockerId") REFERENCES "Locker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
