-- CreateTable
CREATE TABLE "GuidedSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'greeting',
    "completedStages" JSONB NOT NULL DEFAULT '[]',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "intakeAnswers" JSONB,
    "interpretation" JSONB,
    "situation" TEXT,
    "draftId" TEXT,
    "storyId" TEXT,
    "foundation" JSONB,
    "backlog" JSONB NOT NULL DEFAULT '[]',
    "lastDraftText" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidedSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuidedSession_userId_workspaceId_idx" ON "GuidedSession"("userId", "workspaceId");
