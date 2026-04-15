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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors({
  exposedHeaders: ['x-refreshed-token'],
}));
app.use(express.json({ limit: '1mb' }));

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

// SPA fallback — Express 5 doesn't support app.get('*', ...)
app.use(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    try {
      const fs = await import('fs/promises');
      let html = await fs.readFile(path.join(publicDir, 'index.html'), 'utf-8');
      if (isMariaThreeHost(req.hostname)) {
        html = transformToMaria3(html);
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
