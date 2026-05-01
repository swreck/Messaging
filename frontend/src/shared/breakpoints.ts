// Single source of the small-layout cutoff used by both MariaPartner.tsx
// (for the compact panel size default) and MobileHomeAffordances.tsx (for
// the iPhone home-screen two-button layout). Phase 2 — Redline #14.
//
// The 600px value matches the existing compact-panel default in
// MariaPartner.tsx; importing the constant keeps the two screens in sync
// so a future tweak only changes one number.

export const MOBILE_HOME_BREAKPOINT_PX = 600;
