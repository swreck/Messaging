import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export type ModelTier = 'fast' | 'deep' | 'elite';

function getModel(tier: ModelTier): string {
  if (tier === 'elite') return 'claude-opus-4-6';
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
  tier: ModelTier = 'fast',
  conversationHistory?: { role: 'user' | 'assistant'; content: string }[]
): Promise<T> {
  const jsonSuffix = '\n\nYou MUST respond with valid JSON only. No markdown, no code fences, no explanation — just the JSON object.';

  const response = await callAI(
    systemPrompt + jsonSuffix,
    userMessage,
    tier,
    conversationHistory
  );

  // Strip any accidental markdown fences
  const cleaned = response.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try to extract JSON from the response (model may have added text around it)
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch {
        // Fall through to retry
      }
    }

    // Retry once with a stronger nudge
    const retryResponse = await callAI(
      systemPrompt + jsonSuffix,
      `Your previous response was not valid JSON. Respond with ONLY a JSON object, nothing else.\n\nOriginal request: ${userMessage}`,
      tier
    );
    const retryCleaned = retryResponse.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(retryCleaned) as T;
  }
}
