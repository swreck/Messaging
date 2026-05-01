// Shared partner-settings reader.
//
// Extracted from backend/src/routes/partner.ts so the route layer and the
// background pipeline (backend/src/lib/expressPipeline.ts) can both read the
// "Let Maria lead" toggle from the same source of truth: the persisted
// User.settings.partner.consultation field on the User row.
//
// Phase 2 — Redline #3: the express pipeline reads this BEFORE EACH milestone
// narration, not once at job start. The toggle is a live promise; flipping it
// mid-pipeline takes effect on the next milestone.

import { prisma } from './prisma.js';

export interface PartnerSettings {
  username: string;
  displayName: string | undefined;
  introduced: boolean;
  introStep: number;
  lastVisitAt: string | undefined;
  consultation: 'on' | 'off';
}

export async function getPartnerSettings(userId: string): Promise<PartnerSettings> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  const rawConsultation = settings.partner?.consultation;
  const consultation: 'on' | 'off' = rawConsultation === 'off' ? 'off' : 'on';
  return {
    username: user?.username || '',
    displayName: settings.partner?.displayName as string | undefined,
    introduced: !!settings.partner?.introduced,
    introStep: (settings.partner?.introStep as number) ?? 0,
    lastVisitAt: settings.partner?.lastVisitAt as string | undefined,
    consultation,
  };
}

// Live consultation read — used by the express pipeline before each milestone
// narration write. Cheaper than getPartnerSettings (single field) and tightly
// scoped so callers don't accidentally rely on stale display-name etc.
export async function getConsultationLive(userId: string): Promise<'on' | 'off'> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  const raw = settings.partner?.consultation;
  return raw === 'off' ? 'off' : 'on';
}
