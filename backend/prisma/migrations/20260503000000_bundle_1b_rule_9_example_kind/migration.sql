-- Bundle 1B Rule 9 — example deliverables visually distinguished from
-- user-built content. Adds `kind` column to ThreeTierDraft and
-- FiveChapterStory. Existing rows backfill to 'real' via the column
-- DEFAULT. Frontend reads this to render the EXAMPLE tag and to filter
-- examples out of work counts.
--
-- This migration is destructive-class per CLAUDE.md global rules.
-- Pre-flight tag pre-bundle-1b-2026-05-03 and DB snapshot
-- maria-db-snapshot-2026-05-03T23-24-32-719Z.json captured before
-- prisma migrate deploy. A fresh snapshot must be taken IMMEDIATELY
-- before running this migration against production per Cowork's
-- staging-recommendation note.
--
-- Tested on schema only — applied to production after Ken's explicit
-- confirmation.

-- AlterTable
ALTER TABLE "ThreeTierDraft" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'real';

-- AlterTable
ALTER TABLE "FiveChapterStory" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'real';
