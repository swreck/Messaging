import { prisma } from './prisma.js';

export interface LearningData {
  questionsSeen: number;
  questionsConfirmed: number;
  questionThreshold: number;
  columnEdits: Record<string, number>;
  corrections: { aiText: string; userText: string; column: string; createdAt: string }[];
}

const DEFAULT_LEARNING: LearningData = {
  questionsSeen: 0,
  questionsConfirmed: 0,
  questionThreshold: 0.75,
  columnEdits: {},
  corrections: [],
};

export async function getLearning(userId: string): Promise<LearningData> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  return { ...DEFAULT_LEARNING, ...(settings.learning || {}) };
}

export async function updateLearning(userId: string, updates: Partial<LearningData>): Promise<void> {
  const current = await getLearning(userId);
  const merged = { ...current, ...updates };

  // Keep corrections list manageable — last 100
  if (merged.corrections.length > 100) {
    merged.corrections = merged.corrections.slice(-100);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};

  await prisma.user.update({
    where: { id: userId },
    data: { settings: { ...settings, learning: merged } },
  });
}

export async function resetLearning(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { settings: true },
  });
  const settings = (user?.settings as Record<string, any>) || {};
  delete settings.learning;

  await prisma.user.update({
    where: { id: userId },
    data: { settings },
  });
}

export function buildLearningPromptBlock(learning: LearningData): string {
  const lines: string[] = [];

  // Column attention — flag columns with 3+ edits
  const entries = Object.entries(learning.columnEdits).filter(([, count]) => count >= 3);
  if (entries.length > 0) {
    entries.sort((a, b) => b[1] - a[1]);
    const topColumns = entries.slice(0, 2).map(([col]) => col);
    lines.push(`This user frequently refines the ${topColumns.join(' and ')} column${topColumns.length > 1 ? 's' : ''} after generation — give ${topColumns.length > 1 ? 'them' : 'it'} extra care.`);
  }

  if (lines.length === 0) return '';
  return `\nUSER PREFERENCES (learned from previous sessions):\n${lines.join('\n')}`;
}
