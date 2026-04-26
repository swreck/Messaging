import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth.js';
import {
  researchWebsite,
  researchAudience,
  researchSource,
  testDifferentiation,
} from '../services/research.js';

const router = Router();
router.use(requireAuth);

const anthropic = new Anthropic();

// Helper — fetch a URL and extract its text content for downstream Opus calls.
async function fetchPageText(url: string): Promise<string> {
  const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
  const response = await fetch(cleanUrl, {
    headers: { 'User-Agent': 'Maria-Research/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Could not access ${cleanUrl} (status ${response.status})`);
  const html = await response.text();
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

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
      model: 'claude-sonnet-4-6',
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

// Round E1 — structured website research returning offering/audience/differentiator
// candidates the user confirms. Distinct from the legacy /website endpoint above
// (which returns free-text findings); this one returns structured JSON the chat
// surface and Three Tier flow can act on.
router.post('/website-structured', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'URL is required' });
    return;
  }
  try {
    const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
    const pageText = await fetchPageText(cleanUrl);
    const result = await researchWebsite({ url: cleanUrl, pageText });
    res.json({ url: cleanUrl, ...result });
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Research failed' });
  }
});

// Round E1 — sub-segment audience research with citations.
router.post('/audience', async (req, res) => {
  const { audienceName, situation } = req.body;
  if (!audienceName || typeof audienceName !== 'string') {
    res.status(400).json({ error: 'audienceName required' });
    return;
  }
  try {
    const result = await researchAudience(audienceName, typeof situation === 'string' ? situation : undefined);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Research failed' });
  }
});

// Round E1 — find a citable source for a category-level claim. Integrated
// into the Round D Add-source flow as the "find one for me" sub-action.
// Honors the methodology guardrail: refuses to invent customer-specific
// numbers; returns supported=false with a clear reason instead.
router.post('/source', async (req, res) => {
  const { claim, context } = req.body;
  if (!claim || typeof claim !== 'string') {
    res.status(400).json({ error: 'claim required' });
    return;
  }
  try {
    const result = await researchSource({ claim, context: typeof context === 'string' ? context : undefined });
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Source research failed' });
  }
});

// Round E1 — competitive differentiation test. User supplies their claimed
// differentiators + a list of competitor URLs. We fetch each, then ask Opus
// to classify each claim as UNIQUE / COMMON / AMBIGUOUS.
router.post('/differentiation', async (req, res) => {
  const { claimedDifferentiators, competitors } = req.body as {
    claimedDifferentiators?: string[];
    competitors?: { name: string; url: string }[];
  };
  if (!Array.isArray(claimedDifferentiators) || claimedDifferentiators.length === 0) {
    res.status(400).json({ error: 'claimedDifferentiators (non-empty array) required' });
    return;
  }
  if (!Array.isArray(competitors) || competitors.length === 0) {
    res.status(400).json({ error: 'competitors (non-empty array) required' });
    return;
  }
  try {
    // Fetch each competitor's text in parallel; tolerate individual failures.
    const fetched = await Promise.all(competitors.map(async (c) => {
      try {
        const pageText = await fetchPageText(c.url);
        return { name: c.name || c.url, url: c.url, pageText };
      } catch (err) {
        console.error('[differentiation] competitor fetch failed:', c.url, err);
        return { name: c.name || c.url, url: c.url, pageText: '' };
      }
    }));
    const reachable = fetched.filter(c => c.pageText && c.pageText.length > 200);
    if (reachable.length === 0) {
      res.status(502).json({ error: "I couldn't read any of those competitor sites. Want to paste excerpts instead?" });
      return;
    }
    const result = await testDifferentiation({ claimedDifferentiators, competitors: reachable });
    res.json({ ...result, unreachable: fetched.filter(c => !c.pageText).map(c => c.url) });
  } catch (err: any) {
    res.status(502).json({ error: err.message || 'Differentiation test failed' });
  }
});

export default router;
