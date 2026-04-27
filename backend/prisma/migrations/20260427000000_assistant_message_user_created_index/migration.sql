-- Phase 1 production hardening (Fix #6) — composite index on
-- AssistantMessage(userId, createdAt DESC). The partner channel runs
-- findMany({ where: { userId, ... }, orderBy: { createdAt: 'desc' },
-- take: 200 }) on every turn; without this index Postgres scans by
-- userId and re-sorts by createdAt per request. Pure additive change.

CREATE INDEX "AssistantMessage_userId_createdAt_idx"
  ON "AssistantMessage" ("userId", "createdAt" DESC);
