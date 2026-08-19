-- AlterTable
ALTER TABLE "BillLineItem" ADD COLUMN     "isAdmission" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "isAdmission" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "visitPassBalance" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "redeemsPass" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "visitCredits" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "defaultAdmissionItemId" INTEGER;

-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "redeemsPass" BOOLEAN NOT NULL DEFAULT false;
