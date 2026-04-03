# April 3, 2026 — All Fixes, Before → After (User Perspective)

## Commit 1: Alert dialogs and MF dead end

**1. Any API error (generation timeout, network issue, save conflict)**
- Before: Browser froze with a white modal blocking the entire screen. User had to click OK to dismiss. If using Chrome automation, the extension lost connection and stopped working entirely. This happened on 22 different error paths.
- After: A brief red banner appears at the bottom of the screen for 6 seconds, then fades. Nothing freezes. User can keep working.

**2. Five Chapter Story — "Continue without it" button on the driver prompt**
- Before: Clicking "Continue without it" appeared to work (the prompt disappeared), but clicking "Generate All Chapters" triggered a browser-freezing alert saying a driver was still needed. The prompt never came back. The user was trapped — couldn't generate, couldn't access the "guess" option. Only escape was navigating to Audiences and manually adding a driver.
- After: The button is renamed "Just guess and go." Both buttons (this and "Go ahead and guess") derive the driver automatically and proceed to generation. Neither traps the user.

## Commit 2: Text and display fixes

**3. Step 1 capabilities count**
- Before: "3 capabilityies already captured" (broken pluralization)
- After: "3 capabilities already captured"

**4. Audience name possessive (5 locations)**
- Before: "VP of Operations - Hospital Systems's Priorities" (double possessive on names ending in 's')
- After: "VP of Operations - Hospital Systems' Priorities"
- Fixed in: Step 3 title, Step 4 completion text, priority reorder confirmation, mapping diagram audience header, mapping diagram offering header

**5. Workspace name capitalization**
- Before: "priya's Workspace" (lowercase username as workspace name)
- After: "Priya's Workspace" (capitalized)
- Fixed for new registrations (backend) and existing users (database migration)

**6. Raw code in Maria's chat**
- Before: Maria's action badge showed "[NAVIGATE:/three-tier/cmnj2v4b1001786z0cwqszsls] Started a Three Tier for ShiftSync → VP of Operations"
- After: Maria's action badge shows "Started a Three Tier for ShiftSync → VP of Operations" (NAVIGATE command stripped)

## Commit 3: Touch targets and deliverable names

**7. Expand arrows on audience/offering cards**
- Before: 12px font, 16px width — nearly invisible dot on iPad, easy to miss on desktop
- After: 16px font, 24px width — visually clear, easier to tap

**8. Custom deliverable card titles (Five Chapter Stories list page)**
- Before: A custom deliverable created through Maria chat showed the full description as the card title: "CEO-to-board email — executive and strategic tone, not sales. Audience is board members evaluating product strategy, not buyers." This wrapped to 6 lines and dominated the card.
- After: "CEO-to-board email" (truncated at first em-dash or period, capped at 35 characters)
- Fixed in 3 locations: Five Chapters list page cards, Five Chapter detail page tabs, "Draft the Next Piece" prompt text

## Commit 4: Scroll and padding

**9. Step 5 and Five Chapter pages — excessive gray space when scrolling**
- Before: The three-tier-shell had `min-height: calc(100vh - nav-height)` forcing the container to fill the viewport even when content was shorter. Scrolling down created a massive gray gap above the sticky header. The "Turn Into a Story" button and its refine nudge often rendered above the visible area after scrolling.
- After: Container height determined by content naturally. Bottom padding reduced from 80px to 40px.

## Commit 5: iPad/iPhone compatibility and Maria panel

**10. Version history navigation on iPad**
- Before: The version nav ("v2 of 2 — Maria's suggestion" with prev/next buttons) only appeared on mouse hover. iPads don't have hover. A user on iPad could never access version history — they wouldn't even know it existed.
- After: Version nav is always visible on touch devices (detected via `@media (hover: none)`). Desktop retains hover-only behavior.

**11. Tier 3 delete buttons on iPad**
- Before: The × delete buttons on Tier 3 proof points were standard browser-sized (roughly 20px). On iPad, hitting them accurately required precision tapping.
- After: 44px minimum touch target on tablet widths.

**12. Expand icon touch target on iPad**
- Before: Same issue as #7 but specifically on touch devices — the expand icon was already enlarged in commit 3 but didn't have the 44px minimum for tablet.
- After: 44px minimum on tablet widths.

**13. Text input zoom on iOS Safari**
- Before: Tapping into priority editing, capability editing, cell editing, copy-edit, and several other text fields triggered iOS Safari's auto-zoom because font size was under 16px. User had to pinch-zoom back out after every field interaction.
- After: All 10 affected input/textarea selectors set to 16px minimum at tablet width. No more auto-zoom.

**14. iPhone notch/Dynamic Island**
- Before: Nav bar could overlap with the iPhone notch or Dynamic Island status bar area.
- After: Nav bar respects `env(safe-area-inset-top)`.

**15. Maria panel empty on first open after registration**
- Before: Opening Maria's panel immediately after creating an account showed either an empty panel (no content at all) or a greeting with a blank name ("Hi — I'm Maria. Can I call you ?"). User would close the panel thinking it was broken.
- After: Shows "Loading..." briefly while the status API responds, then renders the correct intro with the user's name. Panel never appears empty or broken.

## Commit 6: Version history on Maria restructures

**16. Version history destroyed when Maria restructures Three Tier**
- Before: When a user asked Maria to restructure their Three Tier (e.g., "reorganize the columns"), Maria deleted all existing tier statements and created new ones. All version history (v1 → v2 → v3 edits) was permanently destroyed. The version navigator showed v1 with no ability to see what the text said before.
- After: New statements created during restructure get CellVersion v1 entries immediately. Version history builds properly from there. The pre-restructure state is preserved in a table-level snapshot for full restore.
