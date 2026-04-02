-- Add motivatingFactor to OfferingElement (differentiators)
-- Motivating factors answer "why would someone crave this differentiator?"
ALTER TABLE "OfferingElement" ADD COLUMN "motivatingFactor" TEXT NOT NULL DEFAULT '';
