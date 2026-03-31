-- AlterTable
ALTER TABLE "InviteCode" ADD COLUMN "inviteeName" TEXT NOT NULL DEFAULT '',
ADD COLUMN "inviteeEmail" TEXT NOT NULL DEFAULT '',
ADD COLUMN "role" TEXT NOT NULL DEFAULT 'editor',
ADD COLUMN "shortCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "InviteCode_shortCode_key" ON "InviteCode"("shortCode");
