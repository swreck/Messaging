import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

// Generate Maria 3 icons by compositing a "3" badge onto the existing production icons.
// Follows the same pattern as gen-icon-variants.ts (the "L" badge for local dev),
// but uses "3" in a different position so Maria 3.0 is visually distinct from both
// production Maria (no badge) and local dev Maria (L badge in top-left).
//
// The 3 badge lives in the TOP-RIGHT corner so it does not collide with the L badge
// if both are ever visible.

const PUBLIC_DIR = path.join(import.meta.dirname, '..', 'frontend', 'public');
const SOURCE_SIZES = [
  { name: 'icon-32.png', out: 'icon-32-maria3.png', size: 32 },
  { name: 'icon-192.png', out: 'icon-192-maria3.png', size: 192 },
  { name: 'icon-512.png', out: 'icon-512-maria3.png', size: 512 },
  { name: 'apple-touch-icon.png', out: 'apple-touch-icon-maria3.png', size: 180 },
];

// Badge style: white circle with blue "3" — matches the approved L badge style
// (white-blue) but positioned in the top-right corner and sized slightly larger
// so "3" is legible at small icon sizes.
const BADGE_SIZE_PCT = 0.22;  // 22% of icon size (slightly larger than L badge for legibility)
const BADGE_INSET_PCT = 0.06; // 6% inset from edges
const BADGE_FILL = '#ffffff';
const BADGE_LETTER_COLOR = '#2471cc';
const BADGE_LETTER_WEIGHT = '800';

async function generate() {
  for (const src of SOURCE_SIZES) {
    const sourcePath = path.join(PUBLIC_DIR, src.name);
    if (!fs.existsSync(sourcePath)) {
      console.log(`Skipping ${src.name} — source not found`);
      continue;
    }

    const iconSize = src.size;
    const diameter = Math.round(iconSize * BADGE_SIZE_PCT);
    const radius = diameter / 2;
    // Top-right positioning
    const cx = Math.round(iconSize - (iconSize * BADGE_INSET_PCT) - radius);
    const cy = Math.round(iconSize * BADGE_INSET_PCT + radius);
    const fontSize = Math.round(diameter * 0.62);
    const letterY = cy + fontSize * 0.36;

    const svg = `<svg width="${iconSize}" height="${iconSize}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${BADGE_FILL}"/>
      <text x="${cx}" y="${letterY}" text-anchor="middle"
            font-family="SF Pro Display, -apple-system, Helvetica Neue, Arial, sans-serif"
            font-size="${fontSize}" font-weight="${BADGE_LETTER_WEIGHT}"
            fill="${BADGE_LETTER_COLOR}">3</text>
    </svg>`;

    const overlay = Buffer.from(svg);
    const outputPath = path.join(PUBLIC_DIR, src.out);

    await sharp(sourcePath)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .toFile(outputPath);

    console.log(`Generated ${src.out} (${iconSize}x${iconSize})`);
  }

  console.log('\nMaria 3 icons generated. These will be used by the 3.0 deployment.');
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
