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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
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

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Serve static frontend
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// SPA fallback — Express 5 doesn't support app.get('*', ...)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(publicDir, 'index.html'));
  } else {
    next();
  }
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
