# CLAUDE.md — Starter Template

This file was generated from a successful project collaboration. It captures how we work together — not what we built, but how to build well with this user. Adapt the sections below to your new project as it takes shape.

## ⚠️ LOCKED METHODOLOGY FILES — DO NOT MODIFY WITHOUT KEN'S EXPLICIT APPROVAL

The following files encode Ken Rosen's proprietary messaging methodologies. They were carefully developed, tested through multiple iterative rounds, and refined through direct collaboration with Ken. **No session may modify these files without Ken explicitly approving the specific change:**

- `backend/src/prompts/generation.ts` — KENS_VOICE + all Three Tier generation rules
- `backend/src/prompts/fiveChapter.ts` — Five Chapter Story structure and chapter rules
- `backend/src/prompts/coaching.ts` — Interview prompts for capability/priority extraction
- `backend/src/prompts/mapping.ts` — Priority → capability mapping logic
- `backend/src/prompts/partner.ts` — METHODOLOGY_CORE (Maria's deep understanding)
- `backend/src/services/voiceCheck.ts` — Voice quality evaluation rules
- `backend/src/services/threeTierCheck.ts` — Three Tier structural/doctrinal evaluator
- `backend/src/services/fiveChapterCheck.ts` — Five Chapter boundary/structure evaluator

If you believe a change is needed, explain what and why to Ken first. These files represent decades of consulting expertise encoded into software. Drift here means the product fails.

## What this is

Maria, Your Messaging Partner — a web app implementing Ken Rosen's two messaging methodologies:
- **Three Tier Builder (3T)** — 8-step coached process that produces a canonical value hierarchy
- **Five Chapter Story Generator (5CS)** — generates narrative stories from a completed Three Tier

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
- **AI**: Anthropic SDK (Haiku for speed, Sonnet for depth) — API key is in `.env`
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

## AI integration patterns

When building features that use the Anthropic API:
- Use Haiku for high-volume, low-latency tasks (parsing user input, classification, summarization)
- Use Sonnet for tasks requiring deeper reasoning (web search analysis, complex decision-making)
- Structure AI prompts as numbered instructions — easier to iterate on individual behaviors
- Track AI confidence scores and route low-confidence results for user review
- Consider a tuning/feedback loop: let users correct AI mistakes, feed corrections back into the prompt
