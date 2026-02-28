import { createContext, useContext, useState, useCallback, useRef } from 'react';

export interface PageContext {
  page: string;
  storyId?: string;
  draftId?: string;
  audienceId?: string;
  offeringId?: string;
}

export function pageKey(ctx: PageContext): string {
  return `${ctx.page}:${ctx.draftId || ''}:${ctx.storyId || ''}:${ctx.audienceId || ''}:${ctx.offeringId || ''}`;
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
