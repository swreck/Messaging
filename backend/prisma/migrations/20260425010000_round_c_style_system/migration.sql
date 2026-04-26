-- Round C — Engineering Table style system.
-- Per-user default style, org-level default style (override for new users in
-- the org), and per-deliverable style override. Empty string = unset; effective
-- style resolves at generation time as deliverable.style ?? user.defaultStyle
-- ?? workspace.defaultStyle ?? "TABLE_FOR_2".

ALTER TABLE "User"
  ADD COLUMN "defaultStyle" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Workspace"
  ADD COLUMN "defaultStyle" TEXT NOT NULL DEFAULT '';

ALTER TABLE "FiveChapterStory"
  ADD COLUMN "style" TEXT NOT NULL DEFAULT '';
