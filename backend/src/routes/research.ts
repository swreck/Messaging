import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const anthropic = new Anthropic();

router.post('/website', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
    const response = await fetch(cleanUrl, {
      headers: { 'User-Agent': 'Maria-Research/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.json({ error: `Could not access ${cleanUrl} (status ${response.status})`, findings: null });
    }

    const html = await response.text();
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);

    const aiResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Analyze this website content and extract:
1. What the company/product does (2-3 sentences)
2. Key differentiators mentioned (bullet list)
3. Target audiences mentioned or implied
4. Any specific claims, metrics, or proof points

Be factual. Only report what the content says. Do not infer or add.

Website content:
${textContent}`,
      }],
    });

    const findings = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : '';
    res.json({ findings, url: cleanUrl });
  } catch (err: any) {
    res.json({ error: `Could not read that website: ${err.message}`, findings: null });
  }
});

export default router;
