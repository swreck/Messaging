import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 5 * 60 * 1000, // 5 minutes — Opus calls with voice check can take 2-3 minutes
});

export type ModelTier = 'fast' | 'deep' | 'elite';

// Quality-floor principle (CLAUDE.md):
// Sonnet is the floor. Opus is used for reasoning, judgment, voice-shaping.
// Haiku is not used in this product. The 'fast' tier name is preserved for
// callers that want the lightest acceptable model, but it now resolves to
// Sonnet — no Haiku in production paths.
function getModel(tier: ModelTier): string {
  if (tier === 'elite') return 'claude-opus-4-6';
  return 'claude-sonnet-4-6';
}

export async function callAI(
  systemPrompt: string,
  userMessage: string | Anthropic.ContentBlockParam[],
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
  userMessage: string | Anthropic.ContentBlockParam[],
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
    try {
      return JSON.parse(retryCleaned) as T;
    } catch {
      throw new Error('AI response was not valid JSON after retry');
    }
  }
}
