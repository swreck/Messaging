-- Round E2 — Maria learns from your edits.
-- UserStyleRule stores per-user voice rules Maria detected from repeated
-- edit patterns and the user explicitly approved. Rules are scoped to the
-- audience-type and/or format Maria observed the pattern in; the user can
-- broaden them later. The refine/copy-edit pipeline reads matching rules
-- and layers them on top of the active base style + Personalize profile.

CREATE TABLE "UserStyleRule" (
  "id"                TEXT      NOT NULL,
  "userId"            TEXT      NOT NULL,
  "rule"              TEXT      NOT NULL,
  "scopeAudienceType" TEXT      NOT NULL DEFAULT '',
  "scopeFormat"       TEXT      NOT NULL DEFAULT '',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastApplied"       TIMESTAMP(3),
  CONSTRAINT "UserStyleRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserStyleRule_userId_idx" ON "UserStyleRule"("userId");

ALTER TABLE "UserStyleRule"
  ADD CONSTRAINT "UserStyleRule_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "User"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
