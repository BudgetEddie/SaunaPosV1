-- AlterTable
ALTER TABLE "Visit" ADD COLUMN     "passUsedCustomerId" INTEGER;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_passUsedCustomerId_fkey" FOREIGN KEY ("passUsedCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
