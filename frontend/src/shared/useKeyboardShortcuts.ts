import { useEffect } from 'react';

export function useKeyboardShortcuts(shortcuts: Record<string, () => void>) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      // Don't trigger when typing in inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const key = [
        e.metaKey ? 'cmd' : '',
        e.ctrlKey ? 'ctrl' : '',
        e.shiftKey ? 'shift' : '',
        e.key.toLowerCase(),
      ].filter(Boolean).join('+');

      if (shortcuts[key]) {
        e.preventDefault();
        shortcuts[key]();
      }
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [shortcuts]);
}
