-- Change 3: Contrarian question support on Offering
ALTER TABLE "Offering" ADD COLUMN "contrarianScenario" TEXT;
ALTER TABLE "Offering" ADD COLUMN "contrarianAsked" BOOLEAN NOT NULL DEFAULT false;

-- Change 5: Audience-specific situation (durable memory beyond drivers)
ALTER TABLE "Audience" ADD COLUMN "situation" TEXT;

-- Change 10: Observation model (per-cell persistent suggestions on Three Tier)
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "cellType" TEXT NOT NULL,
    "cellId" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Observation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Observation_draftId_state_idx" ON "Observation"("draftId", "state");
CREATE INDEX "Observation_cellType_cellId_idx" ON "Observation"("cellType", "cellId");

ALTER TABLE "Observation" ADD CONSTRAINT "Observation_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ThreeTierDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
