-- Add mfRationale to Mapping
-- Stores Maria's per-mapping reasoning: how a differentiator's MF principle applies to
-- the specific audience priority on this draft. Lets the user see WHY the mapping was made
-- and gives Maria a place to record her own thinking so future reasoning can build on it.

ALTER TABLE "Mapping" ADD COLUMN "mfRationale" TEXT NOT NULL DEFAULT '';
