import { useEffect, useRef, useCallback, useState } from 'react';
import { api } from '../api/client';

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

export function useGuidedSession() {
  const [session, setSession] = useState<GuidedSessionData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const sessionIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUpdates = useRef<Partial<GuidedSessionData>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.get<GuidedSessionData>('/express/session');
        if (!cancelled) {
          setSession(data);
          sessionIdRef.current = data.id;
        }
      } catch (err) {
        console.error('[useGuidedSession] Failed to load session:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const flushSave = useCallback(async () => {
    const id = sessionIdRef.current;
    const updates = pendingUpdates.current;
    if (!id || Object.keys(updates).length === 0) return;
    pendingUpdates.current = {};
    try {
      await api.patch(`/express/session/${id}`, updates);
    } catch (err) {
      console.error('[useGuidedSession] Failed to save:', err);
    }
  }, []);

  const saveSession = useCallback((partial: Partial<GuidedSessionData>) => {
    Object.assign(pendingUpdates.current, partial);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 500);
  }, [flushSave]);

  const saveSessionImmediate = useCallback(async (partial: Partial<GuidedSessionData>) => {
    Object.assign(pendingUpdates.current, partial);
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
      console.error('[useGuidedSession] Failed to create new session:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const id = sessionIdRef.current;
      const updates = pendingUpdates.current;
      if (id && Object.keys(updates).length > 0) {
        navigator.sendBeacon?.(`/api/express/session/${id}/beacon`, JSON.stringify(updates));
      }
    };
  }, []);

  return { session, isLoading, saveSession, saveSessionImmediate, startNewSession };
}
