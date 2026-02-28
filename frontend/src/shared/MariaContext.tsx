import { createContext, useContext, useState, useCallback, useRef } from 'react';

export interface PageContext {
  page: string;
  storyId?: string;
  draftId?: string;
  audienceId?: string;
  offeringId?: string;
}

export function pageKey(ctx: PageContext): string {
  // Key on page route only — NOT entity IDs. Expanding a different audience card
  // or switching offerings shouldn't clear the conversation.
  // For 3T and 5CS detail pages, include draftId/storyId since those are separate routes.
  return `${ctx.page}:${ctx.draftId || ''}:${ctx.storyId || ''}`;
}

interface MariaContextType {
  pageContext: PageContext;
  setPageContext: (ctx: PageContext) => void;
  refreshPage: () => void;
  registerRefresh: (fn: () => void) => void;
}

const MariaCtx = createContext<MariaContextType>({
  pageContext: { page: 'dashboard' },
  setPageContext: () => {},
  refreshPage: () => {},
  registerRefresh: () => {},
});

export function MariaProvider({ children }: { children: React.ReactNode }) {
  const [pageContext, setPageContext] = useState<PageContext>({ page: 'dashboard' });
  const refreshRef = useRef<(() => void) | null>(null);

  const registerRefresh = useCallback((fn: () => void) => {
    refreshRef.current = fn;
  }, []);

  const refreshPage = useCallback(() => {
    refreshRef.current?.();
  }, []);

  return (
    <MariaCtx.Provider value={{ pageContext, setPageContext, refreshPage, registerRefresh }}>
      {children}
    </MariaCtx.Provider>
  );
}

export function useMaria() {
  return useContext(MariaCtx);
}
