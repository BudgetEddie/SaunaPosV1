-- ============================================================================
-- MULTI-LOCATION, STAGE 1 — give the business more than one bathhouse.
--
-- This is a DATA migration as much as a shape one, and the order below matters.
-- The naive auto-generated version fails: Category.locationId is required, but
-- there are already rows, so the column has to be added empty, backfilled to a
-- location, and only THEN made NOT NULL.
--
-- What it does, in order:
--   1. Create the Location table.
--   2. Create one location, "Mississauga", copying the old house-wide cash
--      discount off Settings so nothing about today's single site changes.
--   3. Point every existing Category at Mississauga, then lock the column down.
--   4. Swap Category's global name-uniqueness for per-location uniqueness.
--   5. Drop the cash-discount columns from Settings (they now live on Location).
-- ============================================================================

-- 1. The new table. -----------------------------------------------------------
CREATE TABLE "Location" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cashDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cashDiscountMinEntry" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Location_name_key" ON "Location"("name");

-- 2. The one location that exists today. Its cash discount is whatever the
--    house-wide setting was, so the single live site is untouched. COALESCE
--    covers a fresh database that never wrote a Settings row.
INSERT INTO "Location" ("name", "cashDiscount", "cashDiscountMinEntry")
SELECT
    'Mississauga',
    COALESCE((SELECT "cashDiscount" FROM "Settings" WHERE "id" = 1), 0),
    COALESCE((SELECT "cashDiscountMinEntry" FROM "Settings" WHERE "id" = 1), 0);

-- 3. Category.locationId: add empty, backfill to the only location, then require
--    it. The subquery picks the lowest-id active location, which is Mississauga.
ALTER TABLE "Category" ADD COLUMN "locationId" INTEGER;

UPDATE "Category"
SET "locationId" = (SELECT "id" FROM "Location" ORDER BY "id" ASC LIMIT 1)
WHERE "locationId" IS NULL;

ALTER TABLE "Category" ALTER COLUMN "locationId" SET NOT NULL;

-- 4. Uniqueness moves from "name" alone to "(locationId, name)".
DROP INDEX "Category_name_key";
CREATE UNIQUE INDEX "Category_locationId_name_key" ON "Category"("locationId", "name");

ALTER TABLE "Category"
    ADD CONSTRAINT "Category_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. The cash discount now lives on Location, not Settings.
ALTER TABLE "Settings" DROP COLUMN "cashDiscount";
ALTER TABLE "Settings" DROP COLUMN "cashDiscountMinEntry";
