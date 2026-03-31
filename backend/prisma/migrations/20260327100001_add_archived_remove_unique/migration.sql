-- AlterTable
ALTER TABLE "ThreeTierDraft" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex
DROP INDEX IF EXISTS "ThreeTierDraft_offeringId_audienceId_key";
