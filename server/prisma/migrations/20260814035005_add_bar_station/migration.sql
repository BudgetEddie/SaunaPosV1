-- CreateEnum
CREATE TYPE "Station" AS ENUM ('KITCHEN', 'BAR');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "station" "Station" NOT NULL DEFAULT 'KITCHEN';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "station" "Station" NOT NULL DEFAULT 'KITCHEN';
