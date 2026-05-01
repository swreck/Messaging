# CLAUDE.md — Starter Template

This file was generated from a successful project collaboration. It captures how we work together — not what we built, but how to build well with this user. Adapt the sections below to your new project as it takes shape.

## ⚠️ ROLES — WHO OWNS WHAT

This is a three-way collaboration. Each role has clear authority. The roles are not interchangeable, and the rules below depend on knowing who owns what.

**Ken** — Product owner and methodology author. Final say on every word Maria says, every methodology decision, every release. Approves user-facing language before it ships. The only person who can lock or unlock a methodology file.

**Cowork** — Head of Product Management and UX Design. Source of all user-facing language. Authors Maria's words at every milestone, every soft note, every screen, every prefilled reply. Approves the shape of every interaction before CC implements. Cowork is not a third opinion or an advisory voice; user-facing copy authorship is Cowork's deliverable. CC does not author user-facing copy on its own.

**CC** — Head of Engineering. Implements Cowork-approved language and Ken-approved decisions. Surfaces engineering tradeoffs, risks, and ambiguities. When CC sees a user-facing phrase that doesn't work, CC flags it for Ken's review rather than substituting its own wording.

## ⚠️ COWORK SPEAKS TO KEN IN UX WORDS ONLY

A UX word is a word someone watching over the user's shoulder would use to describe what is happening on screen. *Button. Message. Panel. Opens. Fades. Taps. Reads. Types. Sees. Hears. Waits.* Those are UX words.

Engineering vocabulary (sessionStorage, middleware, cascade, endpoint, schema, migration, prompt augmentation, env var, hook) is **never** used when speaking to Ken. UX-profession jargon (affordance, trigger, state machine, gate, mount, debounce, viewport) is also **never** used when speaking to Ken. Neither is process-management language (verification protocol, two-track, ship sequence, acceptance criteria) when describing the product itself — those words may appear when describing how Cowork and CC work together, but never when describing what the user sees.

When Cowork describes Maria, the chat panel, the home screen, a button, a message — Cowork describes it in the words a person watching the user would use. Implementation precision goes to CC inside CC prompts. Ken hears the user's experience.

If Cowork catches itself reaching for a word like *affordance,* the substitute is *button.* If Cowork reaches for *trigger,* the substitute is *the moment when [user-visible thing happens].* If Cowork reaches for *state,* the substitute is *what the user is seeing right now.* This rule is permanent.

## ⚠️ MARIA LEADS — THE USER IS REACTIVE, MARIA IS PROACTIVE

The user can reach a finished draft NEVER doing anything but answering questions Maria has put in front of them. Maria carries the conversation. The user replies. Every Maria question is beautiful, friendly, professional, conversational — and pulls the user one step closer to a draft that fits their need.

The contract for every Maria interaction:
- The user is never expected to know what to do next. Maria has already shown them.
- The user is never asked to fill out a form. Maria asks one question at a time.
- The user can tap a pre-typed reply or type their own. Both are equal.
- The chain of Maria's questions runs all the way to the finished draft.

When in doubt about any moment in the product, ask: *is Maria asking, or is the user wandering?* If the user could be wandering, Maria needs to put the next question in front of them.

## ⚠️ LOCKED METHODOLOGY FILES — DO NOT MODIFY WITHOUT KEN'S EXPLICIT APPROVAL

The following files encode Ken Rosen's proprietary messaging methodologies. They were carefully developed, tested through multiple iterative rounds, and refined through direct collaboration with Ken. **No session may modify these files without Ken explicitly approving the specific change:**

- `backend/src/prompts/generation.ts` — KENS_VOICE + all Three Tier generation rules
- `backend/src/prompts/fiveChapter.ts` — Five Chapter Story structure and chapter rules
- `backend/src/prompts/coaching.ts` — Interview prompts for capability/priority extraction
- `backend/src/prompts/mapping.ts` — Priority → capability mapping logic
- `backend/src/prompts/milestoneCopy.ts` — Locked Cowork-authored Maria-voice strings (milestone narrations, soft notes, toggle confirmations, foundational-shift timeout, fresh-user opener and chips)
- `backend/src/prompts/partner.ts` — METHODOLOGY_CORE (Maria's deep understanding)
- `backend/src/prompts/engineeringVoice.ts` — ENGINEERING_VOICE (28-rule Engineering Table style guide)
- `backend/src/services/voiceCheck.ts` — Voice quality evaluation rules
- `backend/src/services/engineeringStyleCheck.ts` — Engineering Table audit (single-pass 28-rule evaluator)
- `backend/src/services/research.ts` — Round E1 research prompts (researchWebsite, researchAudience, researchSource, testDifferentiation)
- `backend/src/services/editPatternDetect.ts` — Round E2 edit-shape characterizer
- `backend/src/services/foundationalShift.ts` — Round E4 foundational-shift detector
- `backend/src/services/provenanceClassify.ts` — Round D claim-origin classifier + Add-source validator
- `backend/src/services/threeTierCheck.ts` — Three Tier structural/doctrinal evaluator
- `backend/src/services/fiveChapterCheck.ts` — Five Chapter boundary/structure evaluator

If you believe a change is needed, explain what and why to Ken first. These files represent decades of consulting expertise encoded into software. Drift here means the product fails.

## 🆘 DISASTER RECOVERY — READ THIS IF MARIA IS BROKEN OR GONE

**If Ken says something like "Maria is broken, restore from latest backup" or "the code is gone, what do we have?", this is the procedure. Use it as written. Do NOT improvise.**

Three independent backup layers were established 2026-04-27. Lose any two, the third still recovers you. List in order of preference (try Layer 1 first; fall through if it's unavailable).

### Layer 1 — Git tag pinned on GitHub (use this first)

- **Tag:** `pre-round-3-3-merge-2026-05-01` on remote `swreck/Messaging` — points at commit `8ba860e` (Round 3.2 production state, bundle `index-BUv8rE46.js`). Latest pre-merge anchor.
- **Older anchor:** `pre-phase-2-2026-04-27` → commit `70a27aa` (Phase 1 verification, bundle `index-DrOf6cOV.js`).
- **Verify it still exists:** `git ls-remote --tags origin pre-round-3-3-merge-2026-05-01`
- **Restore main to this point** (DESTRUCTIVE — confirm with Ken before running):
  ```
  git fetch origin --tags
  git checkout pre-phase-2-2026-04-27
  git checkout -b restore-from-pre-phase-2
  git push origin restore-from-pre-phase-2
  ```
  Then open a PR `restore-from-pre-phase-2 → main` so the rollback is reviewable. Do NOT force-push to main directly without Ken's explicit "yes, force-push to main" — it's the destructive-action rule from the global CLAUDE.md.
- **Other anchor tags** (older known-good points, in case `pre-phase-2-2026-04-27` is somehow corrupt): `v3.1-decision-question`, `v3.0-guided-flow`, `v2.5-final`. List with `git tag`.

### Layer 2 — Offline self-contained git bundle (if GitHub is unavailable)

- **File:** `/Users/kenrosen/Documents/MariaBackups/maria-2026-04-27-full-history.bundle` (~23MB at creation).
- **Verify integrity:** `git bundle verify /Users/kenrosen/Documents/MariaBackups/maria-2026-04-27-full-history.bundle`
- **Restore:**
  ```
  git clone /Users/kenrosen/Documents/MariaBackups/maria-2026-04-27-full-history.bundle restored-repo
  cd restored-repo
  git remote set-url origin https://github.com/swreck/Messaging.git
  git push --all origin
  git push --tags origin
  ```

### Layer 3 — Production database JSON snapshot (if Neon data is corrupt)

- **Latest file:** `/Users/kenrosen/Documents/MariaBackups/maria-db-snapshot-2026-05-01T23-00-25-898Z.json` (~5.4MB, taken pre-Round-3.3-merge).
- **Older snapshot:** `/Users/kenrosen/Documents/MariaBackups/maria-db-snapshot-2026-04-27T17-55-51-121Z.json` (~5.4MB at creation).
- **What's in it:** every row of every Prisma-managed table at 2026-04-27 17:55 UTC. Schema is NOT in the JSON — schema lives in `backend/prisma/migrations/` in the repo, applied via `npx prisma migrate deploy`.
- **To take a fresh snapshot any time** (always do this BEFORE any risky DB operation):
  ```
  npx --prefix /Users/kenrosen/Documents/Projects/Messaging/backend tsx \
    --env-file=/Users/kenrosen/Documents/Projects/Messaging/backend/.env \
    /Users/kenrosen/Documents/Projects/Messaging/backend/snapshot-db.ts
  ```
  Writes a new timestamped JSON to `/Users/kenrosen/Documents/MariaBackups/`.
- **To restore from JSON:** there is no pre-built import script — write a one-off that walks the JSON in dependency order (User → Workspace → Offering → Audience → ThreeTierDraft → ...) and `prisma.<model>.create` row by row, ignoring duplicate-key errors. Apply schema first via `prisma migrate deploy`. Cuid IDs and timestamps round-trip from the JSON.
- **Neon's own point-in-time snapshots are still the fastest recovery path for a Neon-side incident** — check the Neon dashboard before falling back to the JSON. The JSON is for the case where Neon and GitHub both fail in the same window.

### Detailed README

Full procedures + recommended next steps (install `pg_dump` for canonical SQL dumps; what's NOT backed up like secrets) live at `/Users/kenrosen/Documents/MariaBackups/README.md`. Read it if Layer 1 + Layer 2 + Layer 3 above leave any question unanswered.

### Before any new risky operation

- **Always tag the current main with `pre-<operation-name>-YYYY-MM-DD` and push the tag** before starting. This adds another rollback anchor on the GitHub side at zero cost.
- **Run the snapshot-db.ts command above** if the operation could touch DB schema or data. Five seconds of work; saves hours of recovery.
- **Update this section's "Layer 1" tag pointer** when a new safety anchor is created so the freshest tag is always the documented one.

## What this is

Maria, Your Messaging Partner — a web app implementing Ken Rosen's two messaging methodologies:
- **Three Tier Builder (3T)** — 8-step coached process that produces a canonical value hierarchy
- **Five Chapter Story Generator (5CS)** — generates narrative stories from a completed Three Tier

## Maria 3.0: Guided Excellence — SUCCESS METRICS FOR DEVELOPMENT

**Read this before every build session. Do not claim readiness for Ken's review until every metric is met.**

These are SPECIFIC standards. Ken's descriptions are literal, not general. Failure to meet these IS failure.

### Outcome Metrics
1. **Zero hallucinated capabilities.** Every capability traceable to user input or Maria's verified research from real sources. Nothing from training knowledge.
2. **Priorities are the audience's world.** Zero product features as priorities. Every priority passes: "would this person worry about this at 2am?"
3. **Tier 1 compels action as a market truth.** The reader thinks "I can't ignore this." It names a discipline and a consequence. It does NOT tell the reader what they already know or make claims about their organization.
4. **No fabrication in deliverables.** Every fact, metric, customer name, timeline traceable to user input or verified research.
5. **The deliverable sounds like the user.** Not AI, not marketing, not a consultant.
6. **Time to first value: <3 minutes.** Time to deliverable: <20 minutes.

### Interaction Metrics
7. **No modal walls.** At every moment, user can talk to Maria OR directly edit. Switching is instant. No "are you sure?" No separate modes.
8. **Guidance density adapts.** Full for new users. After ~5 interactions Maria asks about length preference. User can always request shorter without losing substance.
9. **Terminology introduced naturally in context.** "I tend to call these 'priorities.'" Never jargon without definition. Maria cannot assume methodological fluency.
10. **Maria navigates to relevant pages** as conversation shifts, like a colleague pulling up notes.
11. **Maria asks questions only when she genuinely has them.** No artificial quotas. No "would you like me to..." at the end of every response.
12. **Attachments and research are first-class inputs everywhere.** Not just at start. Part of core interaction.

### Innovation Layer Metrics
13. **"i" icons on every element** show stable intent and quality metric. Static. Discoverable. Separate from Maria's evaluation.
14. **Maria's evaluation is live.** Highlights update within 5-10 seconds of content changes. Nothing cached. Every evaluation responds to current state.
15. **Visual indicators focus attention.** Subtle shading = Maria has input. Hand up = Maria has input across multiple areas. User engages when they choose.
16. **Maria starts with biggest gap** when user clicks hand without designating focus. Briefly frames scope. User can redirect.
17. **Backlog/resurface pattern.** Maria logs dismissed observations. If user asks "what else?" Maria resurfaces: "I've got 3 things, 2 of which we've discussed."
18. **Research is core capability.** Maria reads websites, compares competitors, researches personas from current sources. Results go into structured data with rose bar/wash provenance.

### Platform Metrics
19. **iPad/Mac: both visible.** Chat and content simultaneously. Edit AND discuss without switching.
20. **iPhone: Maria-first.** Content for reading. Maria for directing. Voice commands primary editing path. "They know I hate typing on a phone."
21. **Consultation toggle works cleanly.** OFF = effective AI app. ON = new-generation partner. Same data underneath.
22. **Multimodal from the start.** Architecture assumes voice, touch, attachments, research. Text-only V1 acceptable but architecture ready.

### Style and Delight
23. **Style observations captured from edits.** End-of-session acknowledgment with pointer to settings.
24. **Professional delight.** The joy of a system making life easier. Not cute. Not clever. The user thinks "they thought of everything."
25. **The user can describe what they did** and it sounds like sophisticated strategic work.

## Product Intent

**Why this exists:** Ken Rosen has developed two proprietary messaging methodologies over his career. Maria turns those methodologies into a guided, AI-coached experience that anyone can walk through — without Ken being in the room. This is the product form of Ken's consulting expertise.

**Core workflow (Three Tier):** A user answers a series of coached questions about their offering and audience. Maria (an AI persona) asks one question at a time, extracts capabilities and audience priorities from the answers, then maps capabilities to priorities to build a three-tier value hierarchy (Tier 1 = differentiators, Tier 2 = strong points, Tier 3 = table stakes). The output is a canonical messaging framework.

**Core workflow (Five Chapter Story):** Takes a completed Three Tier and generates narrative stories in five chapters, each with a specific structural purpose. These stories can be adapted to different mediums (pitch deck, website, email, etc.).

**Key design decisions:**
- Maria is a persona, not a tool — she sounds like "a smart friend at a coffee shop," never a consultant with a clipboard
- One question at a time — never overwhelm with lists or action items
- Use the user's words — Maria extracts but never rewrites or polishes what the user said
- Admin-controlled access via invite codes — this isn't a public SaaS, it's a guided professional tool
- AI prompts encode the entire methodology — the prompts in `backend/src/prompts/` ARE the intellectual property

**CRITICAL — Intellectual property:** The AI prompts in `backend/src/prompts/` (coaching.ts, fiveChapter.ts, generation.ts, mapping.ts, audienceDiscovery.ts, mediums.ts, assistant.ts) contain Ken's proprietary methodologies. These files are the most valuable non-data asset in all four projects. They encode decades of messaging consulting experience into structured AI interactions. If the codebase were lost, these prompts would be the hardest thing to recreate. The database backup covers user sessions, but the prompts in source code are the methodology itself.

**What makes this app "Ken's":** Everything. The Three Tier and Five Chapter methodologies are Ken's original frameworks. Maria's voice, coaching style, extraction approach, and the specific sequence of questions are all designed by Ken. This is not a generic AI chatbot — it's a specific consulting methodology in software form.

## Running the app

**Development:**
```bash
# Terminal 1: Backend
cd backend && npx tsx src/index.ts

# Terminal 2: Frontend (dev server with hot reload + API proxy)
cd frontend && npm run dev
```

**Database:**
```bash
cd backend && npx prisma migrate dev    # Run migrations
cd backend && npx tsx prisma/seed.ts    # Seed admin + invite codes
```

**Neon project:** `maria-messaging` (aws-us-east-2)
**Admin login:** username `admin`, password `maria2026`

## Architecture

The user's standard stack is documented in the global CLAUDE.md under "Standard tooling." Unless this project departs from it, assume:
- **Frontend**: React 19 + TypeScript + Vite
- **Backend**: Express 5 + TypeScript + Prisma ORM → PostgreSQL (Neon cloud)
- **AI**: Anthropic SDK — see *Model selection* section below for Maria's quality-floor principle (Sonnet floor, Opus for any reasoning, Haiku not used). API key is in `.env`.
- **Deployment**: Railway (CLI is installed and authenticated), backend serves pre-built frontend from `backend/public/`
- **PWA**: vite-plugin-pwa with injectManifest strategy, web-push for notifications
- **Database**: Neon cloud PostgreSQL — connection string goes in `.env` as `DATABASE_URL`
- **Auth/integrations**: Google Cloud Console OAuth 2.0 credentials available if needed (Gmail, Calendar, etc.)

All accounts (GitHub, Railway, Neon, Anthropic, Google Cloud) are active and authenticated. See global CLAUDE.md for details.

## Development workflow

1. **Discuss first, build later.** When the user wants to talk through an approach, stay in conversation — don't start reading files or writing code until explicitly told to build.
2. **Plan mode for anything non-trivial.** Use plan mode to explore the codebase and propose an approach before writing code. Present the plan in plain language (what the user will see/experience), not implementation details.
3. **Batch implementation.** Once approved, make all code changes across all files before running any tests or checks.
4. **Test as a pipeline.** After all changes: type-check both frontend and backend (`npx tsc --noEmit`), run test suites, then commit, push, and deploy in sequence.
5. **No auto-commits.** Never commit unless explicitly asked. When asked, write a clear commit message describing what changed from the user's perspective.

## Deployment pipeline

When told to deploy (or given a green light like "yes do all of that"):
1. Build frontend: `cd frontend && npm run build`
2. Copy to backend: `rm -rf backend/public/* && cp -r frontend/dist/* backend/public/`
3. Type-check: `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`
4. Run test suites (if they exist)
5. Commit BOTH source changes AND `backend/public/` built assets
6. Push to GitHub
7. Deploy: `railway up` from the **project root** (where `railway.toml` lives — NOT from backend/)
8. Verify: `curl -s https://mariamessaging.up.railway.app/ | grep -o 'index-[^"]*\.js'` — hash must match `ls backend/public/assets/`. Do NOT tell the user it's live until verified.

**CRITICAL:** All three of steps 5, 7, and 8 are mandatory. Missing any one causes stale deploys.

Execute the full sequence without pausing at each step.

## Communication style

- **Plain language first.** Describe plans and changes in terms of what the user will see and experience. "The action detail view will show a blue banner summarizing the wait" — not "add a div with className waiting-summary that renders recurrenceRule and triggerDate."
- **Lead with clear recommendations.** Don't present open-ended options without a recommendation. Say what you'd do and why, then ask if the user wants something different.
- **Don't assume CLI familiarity.** When something requires browser-based steps (Google Cloud Console, Railway dashboard, GitHub settings), give clear step-by-step instructions.
- **Proactively suggest improvements.** If you notice the user repeatedly doing something manually that could be automated, recommend the fix — don't wait to be asked.

## Mobile-first mindset

The user tests on their phone. Keep these in mind:
- Touch targets should be at least 44px (ideally larger)
- Text should be readable without zooming (16px minimum for body text)
- Menus and pickers should close when tapping outside them
- Test that gestures (swipe, long press) don't conflict with text selection
- iOS Safari has quirks: no hover states, :active transforms can block copy menus

## Key gotchas learned from experience

- **Express 5** does NOT support `app.get('*', ...)` — use middleware for SPA fallback
- **Prisma** loads `.env` natively, but Express/Anthropic SDK need `import 'dotenv/config'` at top of entry point
- **vite-plugin-pwa** injectManifest needs `injectionPoint: undefined` when not using precaching
- **Railway** nixpacks builder — keep `railway.toml` in the backend directory
- **Optimistic concurrency** — use a `version` field on mutable records to prevent stale writes (return 409 on conflict)
- **Date timezone** — dates stored as UTC can appear one day off in UTC-negative timezones. Be aware of this when displaying dates.
- **Global components + API calls = login flicker loop.** `MariaPartner` renders on ALL pages including `/login`. Any `useEffect` that makes an API call MUST guard with `if (!user) return`, because the 401 handler in `client.ts` does `window.location.href = '/login'` — causing a full page reload that clears the login form. This has broken login TWICE (April 2 and April 9, 2026), both times from a new `useEffect` missing the guard. When adding ANY `useEffect` with an API call to a globally-rendered component, always add the `user` guard.

## AI integration patterns

### Model selection — the quality-floor principle

**Maria's use volume is low and per-response quality is paramount.** Maria is a guided professional tool used by senior experts producing high-stakes deliverables. Every Maria response carries the user's professional credibility. Per-token cost and latency are explicitly subordinate to output quality.

**Model selection rules:**
- **Opus** is used for any task requiring reasoning, judgment, or voice-shaping. This includes: every evaluator (mapping evaluator with strength signals, fabrication check, altitude check, voice check, three-tier check, five-chapter check, MF check), every user-facing generation that shapes Maria's voice (chat assistant, refine, copy edit, chapter generation, blend, join), audience-fit conversation, contrarian extraction, personalization synthesis.
- **Sonnet** is the floor for any other API call. Used for structured extraction, parsing, classification — places where the output is mostly mechanical conversion of inputs into structured data with little judgment (express extraction, website content extraction, social proof extraction, simple driver drafting).
- **Haiku is not used in this product.** Generic Anthropic-SDK guidance ("Haiku for speed, Sonnet for depth") does not apply here. The product owner has explicitly chosen quality over per-call cost.

**Why this principle.** This product is not an at-scale consumer chatbot. It's a guided professional tool where one bad Maria response degrades the user's trust in the entire methodology. The cost differential between Sonnet/Opus and Haiku is meaningless at Maria's volume; the quality differential is decisive.

**For new features.** When adding a new AI call site, classify the task and select the model accordingly. If uncertain whether a task needs Opus or Sonnet, default to Opus and let measurement (not assumption) drive any future de-escalation.

### Other AI integration practices

- Structure AI prompts as numbered instructions — easier to iterate on individual behaviors.
- Track AI confidence scores and route low-confidence results for user review.
- Consider a tuning/feedback loop: let users correct AI mistakes, feed corrections back into the prompt.
