-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "refundReason" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BillLineItem" ADD COLUMN     "visitCreditsGranted" INTEGER NOT NULL DEFAULT 0;
