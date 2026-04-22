import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export interface GuidedSessionData {
  id: string;
  phase: string;
  completedStages: string[];
  messages: any[];
  intakeAnswers: { offering: string; audience: string; situation: string } | null;
  interpretation: any | null;
  situation: string | null;
  draftId: string | null;
  storyId: string | null;
  foundation: any | null;
  backlog: { text: string; phase: string }[];
  lastDraftText: string | null;
  completedAt: string | null;
}

interface GuidedSessionContextValue {
  session: GuidedSessionData | null;
  isLoading: boolean;
  saveSession: (partial: Partial<GuidedSessionData>) => void;
  saveSessionImmediate: (partial: Partial<GuidedSessionData>) => Promise<void>;
  startNewSession: () => Promise<void>;
  /** Active = user has meaningful progress (phase past greeting OR any messages). */
  hasActiveGuidedSession: boolean;
}

const GuidedSessionCtx = createContext<GuidedSessionContextValue>({
  session: null,
  isLoading: true,
  saveSession: () => {},
  saveSessionImmediate: async () => {},
  startNewSession: async () => {},
  hasActiveGuidedSession: false,
});

export function GuidedSessionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [session, setSession] = useState<GuidedSessionData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const sessionIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdates = useRef<Partial<GuidedSessionData>>({});

  // Load session on mount (once user is known). No user → no fetch.
  useEffect(() => {
    if (!user) {
      setSession(null);
      sessionIdRef.current = null;
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    api.get<GuidedSessionData>('/express/session')
      .then(data => {
        if (!cancelled) {
          setSession(data);
          sessionIdRef.current = data.id;
        }
      })
      .catch(err => {
        console.error('[GuidedSessionProvider] Failed to load session:', err);
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  const flushSave = useCallback(async () => {
    const id = sessionIdRef.current;
    const updates = pendingUpdates.current;
    if (!id || Object.keys(updates).length === 0) return;
    pendingUpdates.current = {};
    try {
      const updated = await api.patch<GuidedSessionData>(`/express/session/${id}`, updates);
      // Keep local mirror in sync so consumers see latest snapshot.
      setSession(prev => prev && prev.id === updated.id ? { ...prev, ...updated } : prev);
    } catch (err) {
      console.error('[GuidedSessionProvider] Failed to save:', err);
    }
  }, []);

  const saveSession = useCallback((partial: Partial<GuidedSessionData>) => {
    Object.assign(pendingUpdates.current, partial);
    // Optimistic local update so UI reflects immediately (e.g. messages list).
    setSession(prev => prev ? { ...prev, ...partial } as GuidedSessionData : prev);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 500);
  }, [flushSave]);

  const saveSessionImmediate = useCallback(async (partial: Partial<GuidedSessionData>) => {
    Object.assign(pendingUpdates.current, partial);
    setSession(prev => prev ? { ...prev, ...partial } as GuidedSessionData : prev);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await flushSave();
  }, [flushSave]);

  const startNewSession = useCallback(async () => {
    const id = sessionIdRef.current;
    if (id) {
      try {
        await api.patch(`/express/session/${id}`, { completedAt: new Date().toISOString() });
      } catch {}
    }
    setIsLoading(true);
    try {
      const data = await api.get<GuidedSessionData>('/express/session?forceNew=true');
      setSession(data);
      sessionIdRef.current = data.id;
    } catch (err) {
      console.error('[GuidedSessionProvider] Failed to create new session:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Beacon save on unload for anything in-flight.
  useEffect(() => {
    function onBeforeUnload() {
      const id = sessionIdRef.current;
      const updates = pendingUpdates.current;
      if (id && Object.keys(updates).length > 0) {
        navigator.sendBeacon?.(`/api/express/session/${id}/beacon`, JSON.stringify(updates));
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const hasActiveGuidedSession = Boolean(
    session &&
    !session.completedAt &&
    (session.phase !== 'greeting' || (session.messages && session.messages.length > 0))
  );

  return (
    <GuidedSessionCtx.Provider
      value={{ session, isLoading, saveSession, saveSessionImmediate, startNewSession, hasActiveGuidedSession }}
    >
      {children}
    </GuidedSessionCtx.Provider>
  );
}

export function useGuidedSessionContext() {
  return useContext(GuidedSessionCtx);
}
