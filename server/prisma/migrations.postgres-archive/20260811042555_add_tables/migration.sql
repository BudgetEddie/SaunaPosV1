-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'MAINTENANCE');

-- CreateTable
CREATE TABLE "Table" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "seats" INTEGER,
    "status" "TableStatus" NOT NULL DEFAULT 'AVAILABLE',
    "occupiedSince" TIMESTAMP(3),
    "maintenanceNote" TEXT,

    CONSTRAINT "Table_pkey" PRIMARY KEY ("id")
);
