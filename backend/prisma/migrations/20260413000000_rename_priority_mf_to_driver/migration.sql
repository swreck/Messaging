-- Rename Priority.motivatingFactor to Priority.driver
-- Semantically this field has always been a Driver (persona-specific "why this priority matters").
-- MF is the terminology for OfferingElement (differentiator-level "why someone would crave this").
-- This rename aligns the schema with the locked terminology.

ALTER TABLE "Priority" RENAME COLUMN "motivatingFactor" TO "driver";
