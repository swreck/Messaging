import { useState } from 'react';

interface InlineBannerProps {
  message: string;
  storageKey?: string;
  dismissLabel?: string;
}

export function InlineBanner({ message, storageKey, dismissLabel = 'Got it' }: InlineBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    if (storageKey) return localStorage.getItem(storageKey) === 'true';
    return false;
  });

  if (dismissed) return null;

  function handleDismiss(dontRemind: boolean) {
    if (dontRemind && storageKey) {
      localStorage.setItem(storageKey, 'true');
    }
    setDismissed(true);
  }

  return (
    <div className="inline-banner">
      <p>{message}</p>
      <div className="inline-banner-actions">
        <label className="inline-banner-checkbox">
          <input
            type="checkbox"
            onChange={e => {
              if (e.target.checked && storageKey) {
                localStorage.setItem(storageKey, 'true');
              }
            }}
          />
          Don't remind me again
        </label>
        <button className="btn btn-ghost btn-sm" onClick={() => handleDismiss(false)}>{dismissLabel}</button>
      </div>
    </div>
  );
}
