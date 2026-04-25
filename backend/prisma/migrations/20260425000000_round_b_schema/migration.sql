-- Round B4 — pre-Chapter-4 peer prompt: store the user's named-peer context
-- and a flag so Maria doesn't re-ask once the user has answered (or skipped).
ALTER TABLE "FiveChapterStory"
  ADD COLUMN "peerInfo" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "peerAsked" BOOLEAN NOT NULL DEFAULT false;
