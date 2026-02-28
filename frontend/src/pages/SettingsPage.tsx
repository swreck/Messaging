import { useEffect } from 'react';
import { useMaria } from '../shared/MariaContext';

export function SettingsPage() {
  const { setPageContext } = useMaria();

  useEffect(() => {
    setPageContext({ page: 'settings' });
  }, [setPageContext]);

  return (
    <div className="page-container">
      <h1>Settings</h1>
      <p className="text-secondary" style={{ marginTop: '1rem' }}>
        No settings configured yet. Settings you add will appear here.
      </p>
    </div>
  );
}
