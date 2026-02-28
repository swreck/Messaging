-- Five Chapter Story overhaul: new medium types, add stage and joinedText

-- Add new columns
ALTER TABLE "FiveChapterStory" ADD COLUMN "stage" TEXT NOT NULL DEFAULT 'chapters';
ALTER TABLE "FiveChapterStory" ADD COLUMN "joinedText" TEXT NOT NULL DEFAULT '';

-- Remap old medium values to new content format types
UPDATE "FiveChapterStory" SET "medium" = CASE
  WHEN "medium" = '15s' THEN 'social'
  WHEN "medium" = '1m' THEN 'email'
  WHEN "medium" = '5m' THEN 'blog'
  ELSE "medium"
END;
