// Round B5 — pitch-deck export to .pptx.
//
// Generates a 12-15 slide first-draft skeleton from a Five Chapter Story.
// Each chapter maps to 2-3 slides; sub-section headers become slide titles
// (the landing-message of the slide, NOT a label like "Operational Pain"); bullets
// are 3-7 word noun/imperative phrases (NOT full sentences).
//
// The deck ships unstyled — generic PowerPoint defaults. The user applies
// their org template (Design → Themes) after download.

import PptxGenJS from 'pptxgenjs';
import { callAIWithJSON } from './ai.js';
import type { ChapterContent } from '@prisma/client';

interface PptxStorySource {
  storyTitle: string;     // human-readable title shown on cover slide
  audienceName: string;   // e.g., "Navarro Board of Directors"
  cta: string;            // first slide / final slide reference
  chapters: ChapterContent[];
}

interface SkeletonSlide {
  title: string;          // landing-message; never a label
  bullets: string[];      // 3-7 word phrases
  chapterNum?: number;    // origin chapter for the slide (1-5), or undefined for cover/CTA
}

interface SkeletonResult {
  slides: SkeletonSlide[];
}

const SKELETON_SYSTEM = `You convert a Five Chapter Story into a 13-slide pitch-deck skeleton.

The output is the SHAPE of a deck — slide titles and bullet phrases — not a finished deck. The user opens the .pptx in PowerPoint or Keynote and applies their org template; styling is theirs to add.

OUTPUT RULES (NON-NEGOTIABLE):
1. Total slide count: 12-15. Aim for 13.
2. Slide order: 1 cover, 2-3 from Ch1 (pain/category), 2-3 from Ch2 (solution/value), 2 from Ch3 (trust/de-risking), 2 from Ch4 (proof/peers), 1-2 from Ch5 (CTA + next steps).
3. SLIDE TITLE IS A LANDING-MESSAGE, NOT A LABEL.
   - GOOD: "Cedar Ridge loses 47 minutes per shift"
   - BAD: "Operational Pain"
   - GOOD: "Same data plane. New cost ceiling."
   - BAD: "Solution Overview"
4. BULLETS ARE 3-7 WORD NOUN OR IMPERATIVE PHRASES.
   - GOOD bullet: "Live MTTR under 30 minutes"
   - BAD bullet: "We help your team get to live MTTR under 30 minutes."
   - GOOD bullet: "Cut Splunk bill in half"
   - BAD bullet: "Customers tell us they've cut their Splunk bill in half within 6 months."
5. 3-5 bullets per slide. Never more than 5.
6. Cover slide: title is the headline of the pitch (the strongest single line from the story). Bullets list the 3-4 key takeaways.
7. CTA slide(s): title is the action; bullets are the first concrete steps.
8. NEVER invent facts. Use only content from the source chapters.
9. NEVER number slides in the title (the deck tool numbers them).

Return JSON with shape:
{ "slides": [ { "title": "...", "bullets": ["...", "..."], "chapterNum": 1 }, ... ] }
`;

export async function generateSkeleton(source: PptxStorySource): Promise<SkeletonResult> {
  const userMessage = `STORY TITLE: ${source.storyTitle}
AUDIENCE: ${source.audienceName}
CTA: ${source.cta}

CHAPTERS:
${source.chapters
  .sort((a, b) => a.chapterNum - b.chapterNum)
  .map((c) => `[Ch ${c.chapterNum}: ${c.title}]\n${c.content}`)
  .join('\n\n')}

Convert this into a 12-15 slide skeleton following the rules.`;

  const result = await callAIWithJSON<SkeletonResult>(SKELETON_SYSTEM, userMessage, 'elite');
  return { slides: Array.isArray(result.slides) ? result.slides : [] };
}

// Render the skeleton into a real .pptx file. Generic styling — user applies
// their template (Design → Themes) after download.
export async function renderPptx(source: PptxStorySource, skeleton: SkeletonResult): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 inches
  pptx.title = source.storyTitle;
  pptx.subject = `Pitch deck for ${source.audienceName}`;

  for (const slide of skeleton.slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, {
      x: 0.5,
      y: 0.4,
      w: 12.3,
      h: 1.0,
      fontSize: 32,
      bold: true,
      color: '111111',
      valign: 'top',
    });
    if (slide.bullets && slide.bullets.length > 0) {
      s.addText(
        slide.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 20, color: '333333' } })),
        {
          x: 0.7,
          y: 1.7,
          w: 12.0,
          h: 5.4,
          paraSpaceAfter: 12,
        }
      );
    }
  }

  const data = (await pptx.write({ outputType: 'nodebuffer' })) as unknown;
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  // pptxgenjs node bundle returns a Buffer when outputType=nodebuffer
  return data as Buffer;
}
