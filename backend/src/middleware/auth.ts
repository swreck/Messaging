import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface AuthPayload {
  userId: string;
  username: string;
  isAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

// Tokens older than this (in seconds) get silently refreshed
const REFRESH_AFTER_SECONDS = 3 * 24 * 60 * 60; // 3 days

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const token = header.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as AuthPayload & { iat?: number };
    const { iat, ...payload } = decoded;
    req.user = payload;

    // Sliding window refresh: if token is more than half its lifetime old, issue a fresh one
    if (iat && (Math.floor(Date.now() / 1000) - iat) > REFRESH_AFTER_SECONDS) {
      const freshToken = signToken(payload);
      res.setHeader('x-refreshed-token', freshToken);
    }

    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
