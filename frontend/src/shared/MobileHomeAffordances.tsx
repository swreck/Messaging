// Mobile home-screen affordances. iPhone (and any small layout under
// MOBILE_HOME_BREAKPOINT_PX) sees two large buttons on the dashboard:
// "Take a look" — opens the most-recent deliverable for reading.
// "Work with Maria" — opens the chat panel.
//
// Phase 2 — Redlines #10, #13, #14:
//   - Wording is verbatim from the locked frontend mirror of milestoneCopy.
//   - Component renders only on the dashboard route (see DashboardPage mount).
//   - Toggle does NOT appear here; the toggle's home on iPhone is the chat
//     panel header. The home screen has these two buttons and nothing else.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { MOBILE_HOME_BREAKPOINT_PX } from './breakpoints';
import {
  IPHONE_AFFORDANCE_TAKE_A_LOOK,
  IPHONE_AFFORDANCE_WORK_WITH_MARIA,
} from './milestoneCopy';

interface Props {
  // The most-recently touched draft. When undefined, the "Take a look"
  // button is hidden — there is nothing to look at yet, and the user
  // should land in chat to start something.
  mostRecentDraftId?: string;
}

export function MobileHomeAffordances({ mostRecentDraftId }: Props) {
  const navigate = useNavigate();
  const [isSmall, setIsSmall] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth <= MOBILE_HOME_BREAKPOINT_PX;
  });

  useEffect(() => {
    function update() {
      setIsSmall(window.innerWidth <= MOBILE_HOME_BREAKPOINT_PX);
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  if (!isSmall) return null;

  function openMaria() {
    try {
      document.dispatchEvent(
        new CustomEvent('maria-toggle', { detail: { open: true } }),
      );
    } catch { /* non-critical */ }
  }

  return (
    <div
      className="mobile-home-affordances"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '20px 16px',
      }}
    >
      {mostRecentDraftId && (
        <button
          type="button"
          className="btn btn-primary"
          style={{
            minHeight: 56,
            fontSize: 17,
            borderRadius: 14,
            width: '100%',
          }}
          onClick={() => navigate(`/three-tier/${mostRecentDraftId}`)}
        >
          {IPHONE_AFFORDANCE_TAKE_A_LOOK}
        </button>
      )}
      <button
        type="button"
        className="btn btn-primary"
        style={{
          minHeight: 56,
          fontSize: 17,
          borderRadius: 14,
          width: '100%',
        }}
        onClick={openMaria}
      >
        {IPHONE_AFFORDANCE_WORK_WITH_MARIA}
      </button>
    </div>
  );
}
