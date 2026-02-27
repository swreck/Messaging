import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export type ModelTier = 'fast' | 'deep';

function getModel(tier: ModelTier): string {
  return tier === 'fast' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
}

export async function callAI(
  systemPrompt: string,
  userMessage: string,
  tier: ModelTier = 'fast',
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [];

  if (conversationHistory) {
    for (const msg of conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  messages.push({ role: 'user', content: userMessage });

  const response = await anthropic.messages.create({
    model: getModel(tier),
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

export async function callAIWithJSON<T>(
  systemPrompt: string,
  userMessage: string,
  tier: ModelTier = 'fast'
): Promise<T> {
  const response = await callAI(
    systemPrompt + '\n\nYou MUST respond with valid JSON only. No markdown, no code fences, no explanation — just the JSON object.',
    userMessage,
    tier
  );

  // Strip any accidental markdown fences
  const cleaned = response.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned) as T;
}
