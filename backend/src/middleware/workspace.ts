import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';

// Extend Express Request to include workspaceId
declare global {
  namespace Express {
    interface Request {
      workspaceId?: string;
    }
  }
}

/**
 * Middleware that reads x-workspace-id header, verifies user is a member,
 * and attaches workspaceId to the request.
 */
export async function requireWorkspace(req: Request, res: Response, next: NextFunction) {
  const workspaceId = req.headers['x-workspace-id'] as string;
  if (!workspaceId) {
    // Fallback: find the user's first workspace (for backward compatibility)
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'asc' },
    });
    if (membership) {
      req.workspaceId = membership.workspaceId;
      next();
      return;
    }
    res.status(400).json({ error: 'No workspace specified and user has no workspaces' });
    return;
  }

  // Verify membership
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: req.user!.userId } },
  });
  if (!membership) {
    res.status(403).json({ error: 'Not a member of this workspace' });
    return;
  }

  req.workspaceId = workspaceId;
  next();
}

/**
 * Middleware that blocks viewers from mutation routes.
 * Must run after requireWorkspace (needs req.workspaceId).
 */
export async function requireEditor(req: Request, res: Response, next: NextFunction) {
  if (!req.workspaceId) {
    res.status(400).json({ error: 'No workspace context' });
    return;
  }
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: req.workspaceId, userId: req.user!.userId } },
  });
  if (!membership || membership.role === 'viewer') {
    res.status(403).json({ error: 'View-only access — ask the workspace owner to change your role' });
    return;
  }
  next();
}
