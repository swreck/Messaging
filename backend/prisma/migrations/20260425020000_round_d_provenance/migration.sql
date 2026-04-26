-- Round D — Phase-3 provenance system.
-- Per-claim origin tagging on chapter content. Origin classifies what backs
-- each claim (USER_WORDS / USER_DOC / RESEARCH / INFERENCE / AUTHORED).
-- State tracks resolution (OPEN / RESOLVED_EDITED / RESOLVED_CUT /
-- RESOLVED_SOURCED / RESOLVED_OWNED).

CREATE TABLE "Claim" (
  "id"               TEXT      NOT NULL,
  "chapterContentId" TEXT      NOT NULL,
  "sentence"         TEXT      NOT NULL,
  "charOffset"       INTEGER   NOT NULL DEFAULT 0,
  "origin"           TEXT      NOT NULL DEFAULT 'INFERENCE',
  "sourceRef"        TEXT      NOT NULL DEFAULT '',
  "state"            TEXT      NOT NULL DEFAULT 'OPEN',
  "resolvedAt"       TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Claim_chapterContentId_state_idx" ON "Claim"("chapterContentId", "state");

ALTER TABLE "Claim"
  ADD CONSTRAINT "Claim_chapterContentId_fkey"
  FOREIGN KEY ("chapterContentId")
  REFERENCES "ChapterContent"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
