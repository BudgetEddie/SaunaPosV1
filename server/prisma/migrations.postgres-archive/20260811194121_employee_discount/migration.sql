-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "discountKind" TEXT,
ADD COLUMN     "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0;
