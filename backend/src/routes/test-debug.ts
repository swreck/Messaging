// Debug-only router — mounted only when TEST_MODE=true. Lets the
// failure-path test suite drive the Anthropic injection counter and
// inspect/reset circuit-breaker state. NEVER mounted in production
// (the import in index.ts is gated on TEST_MODE).
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  _testInjectFailures,
  _testFailuresPending,
  _testCircuitState,
  _testResetCircuit,
} from '../services/ai.js';

const router = Router();
router.use(requireAuth);

router.post('/inject-failures', (req: Request, res: Response) => {
  const n = Number(req.body?.count ?? 1);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    res.status(400).json({ error: 'count must be an integer 0-100' });
    return;
  }
  _testInjectFailures(n);
  res.json({ ok: true, pending: _testFailuresPending() });
});

router.post('/reset-circuit', (_req: Request, res: Response) => {
  _testResetCircuit();
  res.json({ ok: true, state: _testCircuitState() });
});

router.get('/circuit-state', (_req: Request, res: Response) => {
  res.json(_testCircuitState());
});

export default router;
