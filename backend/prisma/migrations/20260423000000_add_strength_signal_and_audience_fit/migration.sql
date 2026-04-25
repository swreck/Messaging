-- AlterTable: add strength signal + failure pattern to Mapping (per-pairing truth-principle rating)
ALTER TABLE "Mapping" ADD COLUMN "strengthSignal" TEXT;
ALTER TABLE "Mapping" ADD COLUMN "failurePattern" TEXT;

-- AlterTable: add noStrongPairings flag to ThreeTierDraft (drives Maria's audience-fit conversation)
ALTER TABLE "ThreeTierDraft" ADD COLUMN "noStrongPairings" BOOLEAN;
