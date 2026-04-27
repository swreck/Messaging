import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import offeringRoutes from './routes/offerings.js';
import audienceRoutes from './routes/audiences.js';
import draftRoutes from './routes/drafts.js';
import mappingRoutes from './routes/mappings.js';
import tierRoutes from './routes/tiers.js';
import storyRoutes from './routes/stories.js';
import versionRoutes from './routes/versions.js';
import aiRoutes from './routes/ai.js';
import assistantRoutes from './routes/assistant.js';
import partnerRoutes from './routes/partner.js';
import settingsRoutes from './routes/settings.js';
import workspaceRoutes from './routes/workspaces.js';
import shareRoutes from './routes/share.js';
import personalizeRoutes from './routes/personalize.js';
import expressFlowRoutes from './routes/express.js';
import researchRoutes from './routes/research.js';
import { defaultApiLimiter } from './middleware/rateLimit.js';

// Debug routes are only loaded when TEST_MODE is on. The dynamic import
// keeps the file out of the production code path entirely.
const TEST_MODE = process.env.TEST_MODE === 'true';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors({
  exposedHeaders: ['x-refreshed-token'],
}));
app.use(express.json({ limit: '50mb' }));

// Phase 1 hardening (Fix #8) — generous safety-net rate limit on all
// /api routes. Specific routes have stricter limits attached at the
// router. Runs before auth so unauthenticated traffic gets keyed by IP.
app.use('/api', defaultApiLimiter);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/offerings', offeringRoutes);
app.use('/api/audiences', audienceRoutes);
app.use('/api/drafts', draftRoutes);
app.use('/api/mappings', mappingRoutes);
app.use('/api/tiers', tierRoutes);
app.use('/api/stories', storyRoutes);
app.use('/api/versions', versionRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/partner', partnerRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/personalize', personalizeRoutes);
app.use('/api/express', expressFlowRoutes);
app.use('/api/research', researchRoutes);

if (TEST_MODE) {
  const { default: testDebugRoutes } = await import('./routes/test-debug.js');
  app.use('/api/_test', testDebugRoutes);
  console.log('[TEST_MODE] Debug routes mounted at /api/_test');
}

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Serve static frontend assets (icons, JS bundle, manifest.json, etc.)
// We disable express.static's automatic index.html so the SPA fallback below
// can transform the HTML per Host header for the Maria 3.0 dual deployment.
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: false }));

// ─── Maria 2.5 / Maria 3.0 dual deployment ─────────────────
// Both versions run from this same codebase on `main`. Two Railway services
// point their URLs at the same running image. We serve differentiated HTML
// (title + icons + manifest) based on the incoming Host header so iPhone/iPad
// PWA installs show the correct icon and title for each version.
//
// The underlying data is the same (shared Neon database, same users, same
// offerings/audiences/drafts). Only the HTML wrapper differs. Maria 3 icons
// and manifest-maria3.json live in public/ alongside their 2.5 counterparts
// and are served by express.static above when referenced by the 3.0 HTML.

function isMariaThreeHost(hostname: string): boolean {
  if (process.env.MARIA_3_HOST && hostname === process.env.MARIA_3_HOST) return true;
  // Match common naming variants for the Maria 3 Railway service URL:
  //   - mariamessaging3.up.railway.app           (current Railway-generated)
  //   - maria-messaging-3-production.up.railway.app  (alternate naming)
  //   - any host containing the "maria3" token
  return (
    hostname.includes('mariamessaging3') ||
    hostname.includes('maria-messaging-3') ||
    hostname.includes('maria3.')
  );
}

function transformToMaria3(html: string): string {
  return html
    // Strip the SVG favicon entirely on Maria 3 — we have no SVG variant of
    // the 3-badge icon. The PNG icon below carries the Maria 3 branding in
    // desktop browser tabs.
    .replace(/<link rel="icon" type="image\/svg\+xml" href="\/icon\.svg" \/>\s*/g, '')
    .replace(/href="\/icon-32\.png"/g, 'href="/icon-32-maria3.png"')
    .replace(/href="\/apple-touch-icon\.png"/g, 'href="/apple-touch-icon-maria3.png"')
    .replace(/href="\/manifest\.json"/g, 'href="/manifest-maria3.json"')
    .replace(/content="Maria"/g, 'content="Maria 3"')
    .replace(/<title>Maria<\/title>/g, '<title>Maria 3</title>');
}

// SPA fallback — Express 5 doesn't support app.get('*', ...).
// Phase 1 hardening (Fix #7) — in production we read index.html once at
// startup and serve from memory; the file never changes between deploys
// so per-request disk I/O is wasted work. In development we re-read per
// request so Vite hot-reload still propagates.
const isProd = process.env.NODE_ENV === 'production';
let cachedIndexMaria25: string | null = null;
let cachedIndexMaria3: string | null = null;

async function readIndexHtml(maria3: boolean): Promise<string> {
  const fs = await import('fs/promises');
  const raw = await fs.readFile(path.join(publicDir, 'index.html'), 'utf-8');
  return maria3 ? transformToMaria3(raw) : raw;
}

if (isProd) {
  cachedIndexMaria25 = await readIndexHtml(false);
  cachedIndexMaria3 = await readIndexHtml(true);
  console.log('[index.html] Cached at startup (prod mode).');
}

app.use(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    try {
      const wantMaria3 = isMariaThreeHost(req.hostname);
      let html: string;
      if (isProd) {
        html = (wantMaria3 ? cachedIndexMaria3 : cachedIndexMaria25) as string;
      } else {
        html = await readIndexHtml(wantMaria3);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      next(err);
    }
  } else {
    next();
  }
});

app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// AI routes (especially Five Chapter generation with voice check) can take 2-3 minutes.
// Node's default is 2 minutes which is too tight. Set to 5 minutes.
server.timeout = 5 * 60 * 1000;
server.keepAliveTimeout = 5 * 60 * 1000;
