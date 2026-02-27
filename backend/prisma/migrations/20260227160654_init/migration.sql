-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InviteCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "usedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InviteCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offering" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "smeRole" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offering_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferingElement" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OfferingElement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audience" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Audience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Priority" (
    "id" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "isSpoken" BOOLEAN NOT NULL DEFAULT true,
    "motivatingFactor" TEXT NOT NULL DEFAULT '',
    "whatAudienceThinks" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Priority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreeTierDraft" (
    "id" TEXT NOT NULL,
    "offeringId" TEXT NOT NULL,
    "audienceId" TEXT NOT NULL,
    "currentStep" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreeTierDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mapping" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "priorityId" TEXT NOT NULL,
    "elementId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "status" TEXT NOT NULL DEFAULT 'suggested',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tier1Statement" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "Tier1Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tier2Statement" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "priorityId" TEXT,

    CONSTRAINT "Tier2Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tier3Bullet" (
    "id" TEXT NOT NULL,
    "tier2Id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Tier3Bullet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiveChapterStory" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "medium" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "emphasis" TEXT NOT NULL DEFAULT '',
    "blendedText" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiveChapterStory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChapterContent" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "chapterNum" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "ChapterContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CellVersion" (
    "id" TEXT NOT NULL,
    "tier1Id" TEXT,
    "tier2Id" TEXT,
    "tier3Id" TEXT,
    "text" TEXT NOT NULL,
    "versionNum" INTEGER NOT NULL,
    "changeSource" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CellVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TableVersion" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "versionNum" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TableVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_code_key" ON "InviteCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_usedById_key" ON "InviteCode"("usedById");

-- CreateIndex
CREATE UNIQUE INDEX "ThreeTierDraft_offeringId_audienceId_key" ON "ThreeTierDraft"("offeringId", "audienceId");

-- CreateIndex
CREATE UNIQUE INDEX "Tier1Statement_draftId_key" ON "Tier1Statement"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "ChapterContent_storyId_chapterNum_key" ON "ChapterContent"("storyId", "chapterNum");

-- AddForeignKey
ALTER TABLE "InviteCode" ADD CONSTRAINT "InviteCode_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offering" ADD CONSTRAINT "Offering_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingElement" ADD CONSTRAINT "OfferingElement_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Audience" ADD CONSTRAINT "Audience_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Priority" ADD CONSTRAINT "Priority_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "Audience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreeTierDraft" ADD CONSTRAINT "ThreeTierDraft_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "Offering"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreeTierDraft" ADD CONSTRAINT "ThreeTierDraft_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "Audience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mapping" ADD CONSTRAINT "Mapping_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ThreeTierDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mapping" ADD CONSTRAINT "Mapping_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "Priority"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mapping" ADD CONSTRAINT "Mapping_elementId_fkey" FOREIGN KEY ("elementId") REFERENCES "OfferingElement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tier1Statement" ADD CONSTRAINT "Tier1Statement_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ThreeTierDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tier2Statement" ADD CONSTRAINT "Tier2Statement_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ThreeTierDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tier2Statement" ADD CONSTRAINT "Tier2Statement_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "Priority"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tier3Bullet" ADD CONSTRAINT "Tier3Bullet_tier2Id_fkey" FOREIGN KEY ("tier2Id") REFERENCES "Tier2Statement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiveChapterStory" ADD CONSTRAINT "FiveChapterStory_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ThreeTierDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChapterContent" ADD CONSTRAINT "ChapterContent_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "FiveChapterStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellVersion" ADD CONSTRAINT "CellVersion_tier1Id_fkey" FOREIGN KEY ("tier1Id") REFERENCES "Tier1Statement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellVersion" ADD CONSTRAINT "CellVersion_tier2Id_fkey" FOREIGN KEY ("tier2Id") REFERENCES "Tier2Statement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CellVersion" ADD CONSTRAINT "CellVersion_tier3Id_fkey" FOREIGN KEY ("tier3Id") REFERENCES "Tier3Bullet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TableVersion" ADD CONSTRAINT "TableVersion_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ThreeTierDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ThreeTierDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
