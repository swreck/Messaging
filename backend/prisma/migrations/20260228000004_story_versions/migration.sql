-- Add StoryVersion model for Five Chapter Story version history
CREATE TABLE "StoryVersion" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "versionNum" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryVersion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "StoryVersion" ADD CONSTRAINT "StoryVersion_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "FiveChapterStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
