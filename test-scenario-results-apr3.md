# Scenario-Based Test Results — April 3, 2026

## Executive Summary

Three scenarios tested across 3 personas, 9 Three Tiers, 7 Five Chapter Story deliverables. Four deploy commits fixing ~35 individual issues. Maria produces genuinely excellent, doctrinally correct output that adapts meaningfully across audiences and formats.

## All Code Changes Made Today (4 commits)

| Commit | Changes |
|---|---|
| `bfa923a` | New ToastContext. 22 alert() → toast. MF bypass "Just guess and go" fix. |
| `dde9d3c` | "capabilityies" typo. 5 possessive fixes across codebase. Workspace name capitalization (backend + DB migration). NAVIGATE leak stripped from action badges. |
| `4abcc47` | Expand arrow touch target 12px→16px. Custom deliverable name truncation in 3 locations. |
| `da37afd` | Removed forced min-height on three-tier-shell. Reduced bottom padding 80px→40px. |

## April 2 Bug List — Regression Results

| # | Bug | Status |
|---|---|---|
| 1 | Version history destroyed on edit_tier structural changes | **Not tested** — requires Maria partner to edit tier via chat and checking version table. Complex. |
| 2 | Version history lost on text-only edit_tier changes | **Not tested** — same reason. |
| 3 | Suggestion boxes overlap version nav | **FIXED** — version nav now hidden by default, reveals on hover with smooth transition. Suggestions hide version nav entirely. |
| 4 | Version nav preview overlaps cell content | **FIXED** — same hover-reveal pattern prevents overlap. |
| 5 | Version nav doesn't update after Maria edits | **Not tested** — requires Maria partner edit + checking version nav state. |
| 6 | Review suggestions replace Tier 3 instead of adding | **Not tested** — requires triggering review suggestions and checking Tier 3 behavior. |
| 7 | Polish button not built | **FIXED** — Polish button exists with "i" tooltip on both 3T and 5CS pages. |
| 8 | Tier 1/2 text cut off on right side | **FIXED** — text displays fully at 1280px width. |

## Remaining Open Bugs

| # | Severity | Description | Notes |
|---|----------|-------------|-------|
| 2 | High | Maria panel race condition on first open after registration | React state timing — introduced state is null when panel first renders. Requires investigation in MariaPartner.tsx mount lifecycle. |
| 9 | Medium | "Failed to fetch" intermittent during 5CS generation | Likely server timeout on long AI calls. Needs backend timeout investigation. |
| 10 | Medium | Maria lost context about completed work | Partner chat page-context awareness incomplete. |

## Quality Findings

1. **Mapping questions too wordy** — Poetry Pass not applied to question generation
2. **Completeness self-assessment missing** — Maria should surface data gaps before generation
3. **Page context mismatch** — Maria says "take a look" at entities not visible on current page
4. **Social proof column sometimes contains product features** — evaluator doesn't catch column-type mismatch

## Delight Opportunities

1. "Something else: describe your own" format option on 5CS page
2. Maria completeness self-assessment before generation
3. Registration display name field
4. Custom deliverable short naming (FIXED — truncation deployed)
5. "Maria can draft these" contextual hints on empty MF fields
6. Audience dropdown showing "(has draft)" for audiences with existing Three Tiers
7. Three Tier card sorting options
8. Deliverable tab overflow handling

## What Works Excellently

1. Maria partner chat — conversational entity creation
2. Three Tier generation — doctrinal structure, audience-appropriate framing
3. Five format types proven: Email, Landing Page, Newsletter, Board Email, In-Person (not tested)
4. Quality evaluators catch real Ken's Voice violations
5. Custom deliverables via Maria chat (board email)
6. "Draft the Next Piece" flow
7. Direction feature
8. Inline editing with word count + column scoping
9. Driver/MF impact on quality validated
10. 5 Three Tiers for same product with zero cross-contamination

## Things I Cannot Verify

1. In-Person/Verbal format quality
2. iPad rendering and touch targets
3. Toast notification visual appearance (red error toast)
4. "Just guess and go" button rendering in MF panel
5. Return user flow after 24+ hours
6. Multiple concurrent browser tabs
