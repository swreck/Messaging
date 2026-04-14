/**
 * Express Flow Extraction Spike
 *
 * Throwaway scratch script to answer ONE question before committing to Express Flow
 * architecture: can a single Sonnet prompt reliably extract offering facts + audience
 * facts + primary medium from a realistic free-form user description?
 *
 * Not production code. Run once, look at output, decide, delete (or keep as a
 * reference while the extraction prompt is calibrated).
 *
 * Run: npx tsx test-express-extraction-spike.ts
 *
 * Output goes to stdout. No DB writes, no state changes.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@prisma/client';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const prisma = new PrismaClient();

// ─── The candidate silent-extraction prompt ────────────────────────────

const EXTRACTION_SYSTEM = `You are the silent extractor for Maria's Express Flow.

A user has written a free-form message describing their offering and what they
want to communicate. Your job is to extract structured facts so the downstream
pipeline (Three Tier builder, Five Chapter Story generator) can run without
asking any follow-up questions.

═══ WHAT TO EXTRACT ═══

1. OFFERING
   - name (or a plausible short name if not stated)
   - one-paragraph description written in the user's own terms
   - 4-10 differentiators/capabilities — things the offering actually does or is

2. AUDIENCES (usually 1, sometimes 2 if the user clearly describes more than one)
   - name (e.g. "CISO at mid-size bank", "Oncologist at academic hospital")
   - short description of who they are and what they do
   - 4-6 priorities (what they care about, in their language — THEIR concerns, not
     product features reflected back)

3. PRIMARY MEDIUM — what the user most likely needs right now, picked from:
   email | pitch deck | landing page | blog post | press release |
   talking points (in-person meeting) | newsletter | one-pager | report

═══ RULES ═══

- Use the user's own words when you can. Do not polish or marketing-ify.
- Tag every item as "stated" (user said it directly) or "inferred" (you're guessing
  from context). Be honest about which is which. Downstream the user may want to
  edit the inferred ones.
- Never invent claims the user did not make.
- Priorities are the AUDIENCE'S strategic concerns (things they stay up at night
  about, things they'd say to a peer). Not features. Not what the product does.
- If the user was explicit about their audience ("I'm writing to CFOs of community
  banks"), use that. If they were vague ("our customers"), infer a plausible primary
  audience and mark it inferred.
- If the user said what medium they need, use it (stated). If they didn't, infer
  from context and mark it inferred.

═══ OUTPUT FORMAT ═══

Return ONLY valid JSON in this exact shape (no markdown, no code fences):

{
  "offering": {
    "name": "...",
    "nameSource": "stated" | "inferred",
    "description": "...",
    "differentiators": [
      { "text": "...", "source": "stated" | "inferred" }
    ]
  },
  "audiences": [
    {
      "name": "...",
      "description": "...",
      "source": "stated" | "inferred",
      "priorities": [
        { "text": "...", "source": "stated" | "inferred" }
      ]
    }
  ],
  "primaryMedium": {
    "value": "email",
    "source": "stated" | "inferred",
    "reasoning": "one short sentence on why this medium"
  },
  "confidenceNotes": "one sentence on overall confidence — were you mostly reading stated facts, or mostly inferring? Flag any place where you felt the description was too thin to extract reliably."
}`;

const JSON_SUFFIX = '\n\nYou MUST respond with valid JSON only. No markdown, no code fences, no explanation.';

// ─── Helper ─────────────────────────────────────────────────────────────

async function runExtraction(userMessage: string) {
  const start = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM + JSON_SUFFIX,
    messages: [{ role: 'user', content: userMessage }],
  });
  const elapsed = Date.now() - start;

  const textBlock = response.content.find((b) => b.type === 'text');
  const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
  const cleaned = text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();

  try {
    return { ok: true, elapsed, parsed: JSON.parse(cleaned) };
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return { ok: true, elapsed, parsed: JSON.parse(match[0]) };
      } catch {
        // fall through
      }
    }
    return { ok: false, elapsed, error: (e as Error).message, raw: text };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Pull candidate offerings that have real descriptions and enough differentiators
  const offerings = await prisma.offering.findMany({
    include: { elements: { orderBy: { sortOrder: 'asc' } } },
    take: 50,
  });

  const candidates = offerings.filter(
    (o) => o.description.length > 100 && o.elements.length >= 4
  );

  // Pick 5 from different offerings
  const samples = candidates.slice(0, 5);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`EXPRESS FLOW EXTRACTION SPIKE`);
  console.log(`Testing ${samples.length} real offering descriptions from production`);
  console.log(`Model: claude-sonnet-4-6`);
  console.log(`${'='.repeat(80)}\n`);

  for (const offering of samples) {
    // Construct a realistic "user message" — combine the offering description
    // with a few differentiator texts, framed as something a user would actually
    // type in a free-form chat.
    const userMessage = `Hi Maria. I'm trying to figure out how to communicate about ${offering.name}. Here's what it does:

${offering.description}

Some of the key things that make it different:
${offering.elements.slice(0, 5).map((e) => `- ${e.text}`).join('\n')}

I need to write an outreach email to potential customers to get them interested in a conversation. Can you help?`;

    console.log(`${'─'.repeat(80)}`);
    console.log(`OFFERING: ${offering.name}`);
    console.log(`Real description length: ${offering.description.length} chars`);
    console.log(`Real differentiator count: ${offering.elements.length}`);
    console.log(`${'─'.repeat(80)}\n`);

    console.log('INPUT (simulated free-form user message):');
    console.log(userMessage);
    console.log();

    const result = await runExtraction(userMessage);

    if (!result.ok) {
      console.log(`❌ EXTRACTION FAILED`);
      console.log(`Error: ${(result as any).error}`);
      console.log(`Raw response: ${(result as any).raw?.slice(0, 500)}`);
    } else {
      console.log(`✓ EXTRACTION OK (${result.elapsed}ms)`);
      console.log();
      const p = (result as any).parsed;
      console.log(`OFFERING NAME: "${p.offering?.name}" (${p.offering?.nameSource})`);
      console.log(`OFFERING DESC: ${p.offering?.description?.slice(0, 200)}`);
      console.log();
      console.log(`DIFFERENTIATORS (${p.offering?.differentiators?.length || 0}):`);
      for (const d of p.offering?.differentiators || []) {
        console.log(`  [${d.source}] ${d.text}`);
      }
      console.log();
      console.log(`AUDIENCES (${p.audiences?.length || 0}):`);
      for (const a of p.audiences || []) {
        console.log(`  ${a.name} [${a.source}]`);
        console.log(`    ${a.description}`);
        console.log(`    Priorities:`);
        for (const pr of a.priorities || []) {
          console.log(`      [${pr.source}] ${pr.text}`);
        }
      }
      console.log();
      console.log(`PRIMARY MEDIUM: ${p.primaryMedium?.value} [${p.primaryMedium?.source}]`);
      console.log(`  Reasoning: ${p.primaryMedium?.reasoning}`);
      console.log();
      console.log(`CONFIDENCE NOTES: ${p.confidenceNotes}`);
    }
    console.log();
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
