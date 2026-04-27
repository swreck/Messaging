# Production-hardening review — Maria backend, 2026-04-26

Static-analysis review of the Maria codebase as it sits at commit `ffb6ffd`.
Goal: name the concurrency, database, connection-pool, error-handling, and
state-management fragility that would surface as user count rises above the
current ~1-user baseline. No code changes; this is a single report.

---

## §1. Executive Summary

Maria today is a single-process, single-Railway-dyno Express server that holds
every HTTP connection open while one or more 30–90-second Opus calls run. The
shape works at one user. It does not scale gracefully. Five risks dominate:

1. **Long-held HTTP connections during multi-Opus pipelines.** `/api/ai/polish-story`
   can issue up to ~15 sequential Opus calls; `/api/ai/generate-chapter` can issue
   ~6–9; `/api/partner/message` can chain into 2–4 more via the lead-mode and
   nuclear fallbacks. Every one of these holds a thread, a connection, and a
   Prisma slot for the duration. At ≥3 concurrent users on different Opus-heavy
   endpoints, the dyno saturates.
2. **Read-modify-write race on `User.settings` JSON column.** Three writers
   (pendingFoundationalShift, pendingEditPattern, editObservations) all read the
   full settings blob, mutate, and write it back. They run on independent
   request paths that can interleave. Last writer wins; intermediate
   updates silently drop. Manifests at any user with two concurrent
   chapter-edit-then-chat or chapter-edit-then-chapter-edit windows.
3. **No app-level retry or circuit breaker on Anthropic 5xx/timeout.** The
   Anthropic SDK retries internally (default ~2), but a residual 5xx propagates
   as a thrown exception. The chapter-generation pipeline catches some of
   these (voice check, methodology check, provenance) but the primary
   `generate-chapter` `callAI` does not. A single Anthropic blip during chapter
   generation surfaces as a 500 with no partial save.
4. **Unbounded chat-history fetch on every partner turn.** `partner.ts`
   `findMany({take: 200})` against `AssistantMessage` per request, with NO
   composite index on `(userId, context.channel, createdAt)`. As users
   accumulate >500 messages this becomes a sequential scan per turn.
5. **Single-process SPA fallback re-reads index.html from disk per request.**
   `app.use(async ...)` calls `fs.readFile` synchronously per non-API GET, then
   string-replaces for the Maria 3 host transform. Unnecessary disk churn that
   compounds with concurrent traffic.

Fix items 1–3 before broader release; items 4–5 can ride into the first user
cohort and be hardened with telemetry in hand.

---

## §2. Per-Area Findings

### §2.1 Parallel-Opus call sites

- **`POST /api/ai/polish-story` runs sequential per-chapter Opus loops.**
  - **Severity:** CRITICAL.
  - **Concurrency trigger:** any single user invoking Polish on a 5-chapter
    story; collapses the dyno when ≥2 users do it concurrently.
  - **Code location:** `backend/src/routes/ai.ts:1429-1535`. Per chapter:
    `checkProse` → if fails → `callAI` editor pass → `checkProse` recheck → if
    still fails → second `callAI` editor pass. All `'elite'` (Opus). Loop is
    `for (const ch of story.chapters)` — strictly sequential.
  - **What fails:** worst case is 5 chapters × 3 Opus calls = 15 sequential
    Opus calls in one HTTP request. Each call is 30–90s; total wall time can
    exceed the server's 5-minute timeout. The connection stays open the whole
    time. Express has no per-request deadline; only `server.timeout = 5min` in
    `index.ts:128` cuts the rope.
  - **Recommended fix shape:** convert `polish-story` to a job-driven pipeline
    (same pattern as `runPipeline` for build_deliverable in `lib/actions.ts:1462`).
    Frontend POSTs, gets a jobId, polls `/api/express/status/:jobId`. The HTTP
    connection releases in <1s; Opus runs on the server's own time.

- **`POST /api/ai/generate-chapter` chains 4–9 Opus calls per request.**
  - **Severity:** HIGH.
  - **Concurrency trigger:** ≥2 simultaneous users generating chapters.
  - **Code location:** `backend/src/routes/ai.ts:1684-2128`. Sequence:
    optional Ch1 thesis call (1774); main chapter `callAI` (1868); optional
    word-budget rewrite `callAI` (1892); optional voice-check `checkProse` +
    retry `callAI` (1936-1948); optional methodology-check `checkFiveChapter` +
    retry `callAI` (1952-1973); provenance `classifyClaims` (2016); for Ch5,
    cross-chapter dedup may issue 1–4 more `callAI` invocations (2104).
  - **What fails:** typical 90–180s end-to-end; worst case for Ch5 with
    repeats and both checks failing is 5+ minutes. The only protection is
    `server.timeout = 5min`; if a real call exceeds that, Express kills the
    socket and the user sees a generic 5xx with no recovery state.
  - **Recommended fix shape:** chapter generation should also be
    job-driven. The `expressPipeline` already proves the pattern for
    full-story builds. Splitting per-chapter generation to the same model is
    additive — the existing `chapter` save at line 1976 is the resumable
    checkpoint.

- **`POST /api/partner/message` can chain dispatcher Opus calls.**
  - **Severity:** HIGH.
  - **Concurrency trigger:** any chat turn that triggers `refine_chapter`,
    `blend`, `copy_edit`, or related actions; or the lead-mode continuation
    path (partner.ts:991-1045) which fires `dispatchActions` again; or the
    nuclear fallback (partner.ts:1094-1127) which fires it a third time.
  - **Code location:** main Opus call at `backend/src/routes/partner.ts:883`;
    optional retry at 905; `dispatchActions` at 953; lead-mode-continuation
    `dispatchActions` at 1028; nuclear-fallback `dispatchActions` at 1109.
    Inside the dispatcher, refine/blend/copy_edit each issue `await callAI(..., 'elite')`
    sequentially (`backend/src/lib/actions.ts:584, 619, 660, 751, 798, 815, 907, 957, 974, 1000`).
  - **What fails:** a single partner turn can synchronously execute 2–4 Opus
    calls. At 60s each that's 4 minutes of held connection on the most
    user-facing endpoint. The dispatcher iterates actions in a `for` loop with
    no parallelism even when actions are independent.
  - **Recommended fix shape:** push refine/blend/copy_edit into the same
    job-pipeline pattern as build_deliverable. The chat reply returns
    immediately with "working on it"; the user gets the result via the
    existing pipeline status path. Independent dispatcher actions inside a
    single turn could run in parallel, but the bigger win is removing them
    from the request lifecycle entirely.

- **`POST /api/ai/polish` runs two sequential Opus calls.**
  - **Severity:** MEDIUM.
  - **Code location:** `backend/src/routes/ai.ts:1359` (`checkThreeTier`) →
    `1397` (`callAIWithJSON(DIRECTION_SYSTEM)`).
  - **What fails:** ~60–120s typical, holds connection. Has graceful-degradation
    error handling already (1360-1368, 1398-1409) which is good.
  - **Recommended fix shape:** acceptable as-is for now since both calls have
    explicit fail-soft branches and the user gets a usable error. If the
    dyno is saturated by polish-story, this one piggybacks on that fix.

### §2.2 Database query patterns

- **AssistantMessage is unbounded and lacks composite index.**
  - **Severity:** HIGH.
  - **Concurrency trigger:** any user whose chat history exceeds ~500 messages.
  - **Code location:** `backend/src/routes/partner.ts:614-622` and `512-528`
    both run `findMany` with `take: 200` against AssistantMessage filtered by
    `userId` and the JSON-path `context.channel = 'partner'`. Schema in
    `backend/prisma/schema.prisma:385-394` has no `@@index` on this model.
  - **What fails:** Postgres has no index for `(userId, context->>'channel', createdAt)`.
    Today the table is small so the planner picks an index scan on userId; as
    rows accumulate it falls back to bitmap heap + JSON filter, which is slow.
    With B-7's persisted entity IDs in `context` (`context.storyId`,
    `context.draftId`), every partner turn scans for messages even when the
    user is on the dashboard.
  - **Recommended fix shape:** add `@@index([userId, createdAt])` and a
    second `@@index([userId, role, createdAt])` to AssistantMessage. JSON-path
    filtering can stay in-memory after the userId+createdAt prune. Longer-term:
    archive messages older than 90 days to a separate "history" table.

- **N+1 reads of `User.settings` per partner request.**
  - **Severity:** MEDIUM.
  - **Code location:** `backend/src/routes/partner.ts:683` (foundational shift
    surfacing) and `727` (edit pattern surfacing). Both `prisma.user.findUnique({
    where: { id: userId }, select: { settings: true } })` on the same row.
    Same pattern in `getPartnerSettings` at the top of the request.
  - **What fails:** three separate round trips to read the same row.
    Tolerable at low concurrency; wasteful at scale.
  - **Recommended fix shape:** read User.settings once at the top of the
    handler, pass the parsed object down. Trivial refactor.

- **Deep includes in generate-chapter and polish.**
  - **Severity:** LOW.
  - **Code location:** `backend/src/routes/ai.ts:1691-1704` (FCS with draft +
    tier1 + tier2 + tier3 + offering + elements + audience + priorities +
    chapters) and `1325-1333` (Polish equivalent). Single query, but the join
    fan-out is wide. ~10 tables touched per request.
  - **What fails:** for any one draft this is fine; Postgres handles the
    join. Not a hot risk.
  - **Recommended fix shape:** none required; leave alone.

- **Concurrent priority/capability creates loop one-by-one.**
  - **Severity:** LOW.
  - **Code location:** `backend/src/lib/actions.ts:223-232` (add_priorities
    creates each row in its own `await`). Adding 6 priorities = 6 round trips.
  - **What fails:** modest latency tax. Not a load risk.
  - **Recommended fix shape:** `prisma.priority.createMany({ data: [...] })`
    where ranks/sortOrders allow it.

### §2.3 Connection pool & request lifecycle

- **`new PrismaClient()` with no pool tuning.**
  - **Severity:** HIGH.
  - **Concurrency trigger:** ≥3 simultaneous Opus-heavy requests.
  - **Code location:** `backend/src/lib/prisma.ts:3` — bare instantiation.
    No `?connection_limit=` on `DATABASE_URL` (per `railway.toml:1-3` —
    DATABASE_URL is supplied by Railway; not visible in repo).
  - **What fails:** Prisma defaults to `num_physical_cpus * 2 + 1` connections.
    On a Railway shared CPU dyno that resolves to ~5. Polish-story holds
    ~3 connections at peak (FCS read, chapter updates, version inserts) for
    5+ minutes. Two concurrent polish-story calls can saturate the pool;
    other requests then queue with `error.code === 'P2024'`-style timeouts.
  - **Recommended fix shape:** explicit `?connection_limit=10&pool_timeout=20`
    on DATABASE_URL via Railway env. More importantly, get the long-running
    Opus calls out of the request lifecycle (see §2.1) so connections
    release immediately.

- **Single Express dyno serves both API and static frontend.**
  - **Severity:** MEDIUM.
  - **Code location:** `backend/src/index.ts:62` (express.static) and
    `102-118` (SPA fallback). `railway.toml:6` runs `cd backend && sh start.sh` —
    a single `node dist/index.js` process.
  - **What fails:** every PWA asset request — icons, manifest, JS bundle —
    competes with the API for the same Node event loop. When a slow Opus
    request is mid-flight, even bundle requests can stall behind it
    (Node is single-threaded; only the await yields). For ~1 user this is
    invisible. At 5+ concurrent users it shows up as everything-feels-slow.
  - **Recommended fix shape:** `app.use(express.static(publicDir))` is fine,
    but the SPA fallback at line 102 reads `index.html` from disk on every
    GET. Cache the read result in memory at startup; only re-read on file
    change (or never — the file is baked into the deploy). Eliminates one
    disk read per page-load. Longer-term: front the API with a CDN that
    serves `/assets/*` directly.

- **Body-parser limit is 50MB; Anthropic timeout is 5 minutes.**
  - **Severity:** MEDIUM.
  - **Code location:** `backend/src/index.ts:32` (`express.json({ limit: '50mb' })`)
    and `backend/src/services/ai.ts:5` (`timeout: 5 * 60 * 1000`).
  - **What fails:** a slow uploader pushing a 50MB body can hold a connection
    for as long as the body parser allows (Express has no upload-progress
    timeout configured). Combined with the slow Opus calls, the dyno can be
    pinned by a small number of slow-body requests. No malicious actor needed —
    a user on bad WiFi attaching a large PDF gets close.
  - **Recommended fix shape:** add `express` request-timeout middleware
    (e.g. `connect-timeout` set to 30s for non-AI routes, 360s for the chapter
    generation route). Reduce JSON body limit to 25MB unless evidence shows
    50MB is needed.

- **No request-level rate limiter.**
  - **Severity:** MEDIUM.
  - **Code location:** none — there is no `express-rate-limit` or equivalent
    in `backend/src/index.ts` middleware chain.
  - **What fails:** a single user can fire 100 partner messages in a loop
    and exhaust the Anthropic budget plus the connection pool. Today this is
    bounded by the UX (one user, careful), but on broader release a runaway
    frontend bug or curious user could spend real money fast.
  - **Recommended fix shape:** add per-user rate limits at the route level —
    e.g. partner-message at 10/minute, generate-chapter at 5/minute,
    polish-story at 2/minute.

- **`server.timeout` and `server.keepAliveTimeout` both 5 minutes.**
  - **Severity:** LOW.
  - **Code location:** `backend/src/index.ts:128-129`.
  - **What fails:** matches the 5-minute Anthropic SDK timeout. Reasonable
    today; once Opus calls move out of the request lifecycle these can drop
    to 60s without breaking anything.
  - **Recommended fix shape:** acceptable as-is until §2.1 fixes land.

### §2.4 Error handling under failure

- **Anthropic timeout in main partner Opus call → 500 with no partial state.**
  - **Severity:** HIGH.
  - **Code location:** `backend/src/routes/partner.ts:883` calls
    `callAIWithJSON(...)` with no try/catch around it. `services/ai.ts:36`
    awaits `anthropic.messages.create`; on timeout the SDK throws after its
    internal retries.
  - **What fails:** the user's message is NOT yet persisted (the
    `assistantMessage.create` calls happen later in the handler). The thrown
    error bubbles to the global `errorHandler` middleware. The user sees a
    generic 500. The user's message is lost from the database. Subsequent
    partner turns have no record of what the user said.
  - **Recommended fix shape:** persist the user message FIRST, then call
    Opus. If Opus throws, store an "assistant" row with content like
    "I lost my train of thought" so retries see continuity. Same shape as
    the existing fallback at `partner.ts:1132-1149` but applied at the
    exception boundary rather than the empty-response boundary.

- **`callAIWithJSON` retry doubles latency on JSON parse failures.**
  - **Severity:** MEDIUM.
  - **Code location:** `backend/src/services/ai.ts:78-90`. On parse failure,
    re-issues the full Opus call with a stricter prompt.
  - **What fails:** a flaky JSON-emitting model can extend the request to 2x
    its normal latency before even reaching the second-level retry in
    partner.ts:903. No backoff between retries — they fire immediately.
  - **Recommended fix shape:** add a short backoff (1s) between retries.
    Better: use the SDK's structured-output mode if available, eliminating
    the ad-hoc JSON parsing entirely.

- **DB write fails after Opus succeeds.**
  - **Severity:** HIGH.
  - **Code location:** `backend/src/routes/ai.ts:1976-1995` (chapter save +
    version), and `1997-2039` (provenance classification + `claim.createMany`).
    No transaction wraps these. If the version-create fails after the chapter
    upsert, the chapter exists but has no version row.
  - **What fails:** silent partial state. The user sees the chapter content;
    the version history thinks the prior version is the latest.
  - **Recommended fix shape:** wrap the chapter-write + version-write in
    `prisma.$transaction([...])`. Provenance is non-fatal already; leave it
    outside the transaction.

- **Classifier failure mid-pipeline is logged but silent to user.**
  - **Severity:** LOW.
  - **Code location:** `backend/src/routes/ai.ts:1947` (voice check),
    `1971` (methodology check), `2037` (provenance), `2113` (dedup). All
    catch and log without surfacing.
  - **What fails:** acceptable. The chapter still exists; the user can
    retry. Quality degrades silently — the user might ship a chapter that
    failed voice check without knowing.
  - **Recommended fix shape:** record per-chapter "checks ran clean" flag
    in DB. Surface a small badge on the chapter UI when checks were skipped.

- **Race in `partner.ts` foundational-shift cleanup.**
  - **Severity:** MEDIUM. (Detailed in §2.5.)

### §2.5 State management — `User.settings` JSON column

- **Three writers, no row lock, last-write-wins.**
  - **Severity:** HIGH.
  - **Concurrency trigger:** a user editing chapters in two tabs, OR a
    chapter PUT firing `recordEditObservation` + `detectFoundationalShift`
    in parallel within `stories.ts` while a partner-message simultaneously
    ages-out a stale stash.
  - **Code location:**
    - `backend/src/routes/stories.ts:283-318` writes both
      `pendingFoundationalShift` and `pendingEditPattern` in one settings update.
    - `backend/src/routes/partner.ts:683-718` reads settings, deletes
      `pendingFoundationalShift` if stale, writes back.
    - `backend/src/routes/partner.ts:727-752` reads settings AGAIN, deletes
      `pendingEditPattern` if stale, writes back.
    - `backend/src/lib/userStyleRules.ts:105-129` reads settings, appends
      to `editObservations`, writes back.
  - **What fails:** all four read the full settings blob, mutate, write
    back. There is no optimistic-concurrency check (no `version` column on
    User), no transaction. Concurrent writes silently lose data:
    - The two consecutive partner.ts read-modify-writes (683 and 727) can
      themselves race: the second read at 727 may not see the write from 716.
    - A user who edits a chapter in two tabs near-simultaneously can lose
      one of the two `editObservations` appends.
    - A `pendingEditPattern` stash from `stories.ts` can be wiped by a
      concurrent partner.ts age-out before it ever surfaces.
  - **Recommended fix shape:** consolidate the two reads in partner.ts into
    one (read once, build the next settings, single write). For cross-route
    races (chapter PUT vs partner POST), add a `version Int @default(1)`
    column to User and use optimistic concurrency. Longer-term, promote
    `editObservations` and `pendingFoundationalShift` to dedicated tables —
    the JSON column is convenient but a contention hotspot.

- **`editObservations` rolling window enforced; OK.**
  - **Severity:** LOW.
  - **Code location:** `backend/src/lib/userStyleRules.ts:125` — `.slice(-OBSERVATION_WINDOW)`
    where `OBSERVATION_WINDOW = 20`.
  - **What fails:** nothing. Bounded growth. Confirmed.

- **`pendingFoundationalShift` / `pendingEditPattern` cleanup is age-based.**
  - **Severity:** LOW.
  - **Code location:** `partner.ts:687, 731` checks `setAt` against
    `Date.now() - 90_000`.
  - **What fails:** if a user never opens the chat panel after a chapter
    edit, the stash sits in settings indefinitely (until the NEXT partner
    message ages it out). It's small (a few hundred bytes) so this isn't a
    bloat risk, just inelegant.
  - **Recommended fix shape:** acceptable. If we move these to dedicated
    tables, add a periodic cleanup job.

### §2.6 External-service & memory concerns

- **No app-level retry on Anthropic 5xx.**
  - **Severity:** HIGH.
  - **Code location:** `backend/src/services/ai.ts:36` — `anthropic.messages.create`
    with no application-level wrapper. The SDK's internal retry is the only
    protection.
  - **What fails:** Anthropic 529s and 502s during peak hours surface as
    thrown exceptions to the route handler. With no app retry, a single
    transient blip kills a chapter generation.
  - **Recommended fix shape:** add a `withRetry(fn, { attempts: 2, backoff: 2000 })`
    wrapper in `services/ai.ts`. Retry only on 5xx and rate-limit errors;
    do not retry on 4xx or timeout (timeouts likely indicate the model
    actually choked on the prompt and a retry will repeat the choke).

- **No circuit breaker.**
  - **Severity:** MEDIUM.
  - **Code location:** absent. There is no place in the codebase that
    tracks Anthropic error rate or trips a circuit.
  - **What fails:** during an Anthropic outage, every Maria request waits
    for the SDK timeout (currently 5 minutes) before failing. With Opus
    queued behind it, a 30-minute outage looks like a 30-minute hang per
    request to the user.
  - **Recommended fix shape:** simple in-memory breaker — track 5xx rate
    over a 60s window; if >50% fail, fast-fail subsequent requests with a
    user-visible "Anthropic is having issues, try again in a minute" for
    30s before re-trying upstream. Not architecturally large.

- **Anthropic clients instantiated twice.**
  - **Severity:** LOW.
  - **Code location:** `services/ai.ts:3` (with timeout config) and
    `routes/research.ts:14` (`new Anthropic()` with defaults — DIFFERENT
    timeout, no explicit config).
  - **What fails:** research-route Anthropic calls use SDK-default timeout
    (10 minutes per recent SDK versions). No real bug; inconsistent posture.
  - **Recommended fix shape:** export the singleton from `services/ai.ts`
    and reuse it everywhere. One client, one timeout policy.

- **Frontend localStorage growth — bounded but accumulates.**
  - **Severity:** LOW.
  - **Code location:** `frontend/src/shared/MariaPartner.tsx` —
    `chat-scope-{userId}-{kind}-{id}` (one entry per surface ever opened),
    `voice-tooltip-dismissed-{userId}` (single key per user),
    `time-context-{date}` and `time-budget-asked-{date}` (one per session-day),
    `website-research-offered-{date}` (one per session-day).
  - **What fails:** the date-stamped keys never get cleaned up. After a
    year of daily use, ~365 stale keys per user in localStorage. Trivial
    bytes but inelegant.
  - **Recommended fix shape:** at app load, sweep `time-*-{YYYY-...}` and
    `website-research-offered-{YYYY-...}` keys older than 7 days and remove.
    Five lines of code in the auth boot path.

- **In-process refs `pendingPeerStoryIdRef` and `peerPromptContextRef` in MariaPartner.**
  - **Severity:** LOW.
  - **Code location:** `frontend/src/shared/MariaPartner.tsx:407-408`.
  - **What fails:** memory-only state, scoped to the React component
    lifetime. No leak risk; documented for completeness.

- **SPA fallback re-reads `index.html` from disk per request.**
  - **Severity:** MEDIUM.
  - **Code location:** `backend/src/index.ts:102-118`. `await fs.readFile(...)`
    on every non-/api GET.
  - **What fails:** at modest concurrency this churns the disk and CPU
    unnecessarily. The file is baked into the deploy and never changes
    until the next ship.
  - **Recommended fix shape:** read once at server startup into a
    module-scope string; serve from memory. The Maria-3 host transform
    can stay — it's a string replace on the cached value.

---

## §3. Top 8 Fix Recommendations, Rank-Ordered

1. **Move polish-story off the request thread (jobified).**
   - **Fixes:** §2.1 finding 1; §2.3 connection pool finding.
   - **Effort:** M (single endpoint; pattern already exists in
     `lib/expressPipeline.ts` for build_deliverable).
   - **Risk:** M (changes the polish-story user contract — frontend has to poll).
   - **Priority:** before broader release.

2. **Move generate-chapter and refine-chapter off the request thread.**
   - **Fixes:** §2.1 finding 2; partly §2.3 connection pool finding.
   - **Effort:** L (cross-cutting — frontend chapter UI today expects the
     synchronous return shape).
   - **Risk:** M.
   - **Priority:** before broader release. Mitigate item 1 first; this is the
     bigger lift.

3. **Persist user message BEFORE the Opus call in partner.ts.**
   - **Fixes:** §2.4 finding 1.
   - **Effort:** S (single function, 5 lines moved + try/catch).
   - **Risk:** L (additive — adds a row earlier in the path).
   - **Priority:** before broader release.

4. **Consolidate `User.settings` reads/writes in partner.ts; add row version.**
   - **Fixes:** §2.5 race finding; §2.2 N+1 setting reads.
   - **Effort:** M (one route; schema migration adds `User.version`).
   - **Risk:** M (touches read-modify-write; testable).
   - **Priority:** before broader release.

5. **Add app-level Anthropic retry + circuit breaker in `services/ai.ts`.**
   - **Fixes:** §2.6 retry/breaker findings; §2.4 timeout cascade.
   - **Effort:** S (wraps the existing `callAI` body).
   - **Risk:** L (additive).
   - **Priority:** before broader release.

6. **Add composite index on AssistantMessage.**
   - **Fixes:** §2.2 unbounded chat-history scan.
   - **Effort:** S (Prisma migration).
   - **Risk:** L.
   - **Priority:** during first user cohort. Today's volume doesn't need it;
     ship it once the first heavy user produces 200+ messages.

7. **Cache index.html in memory; eliminate per-request disk read.**
   - **Fixes:** §2.3 SPA fallback finding.
   - **Effort:** S (one module variable).
   - **Risk:** L.
   - **Priority:** during first user cohort.

8. **Add per-user rate limits on partner-message, generate-chapter, polish-story.**
   - **Fixes:** §2.3 rate-limit absence; bounds Anthropic budget exposure.
   - **Effort:** S (`express-rate-limit` middleware).
   - **Risk:** L (additive; tune the bucket size based on real traffic).
   - **Priority:** during first user cohort.

---

## §4. Items Not Actionable Now

- **Multi-dyno deployment.** The single-Railway-dyno model serves both API
  and static assets and pins all Opus traffic to one Node process. A real
  fix is horizontal scaling: separate API dynos behind a load balancer,
  static frontend behind a CDN. This is an infrastructure decision, not a
  code change. Flag for post-cohort.
- **Anthropic-cost telemetry.** No instrumentation today tracks per-user or
  per-endpoint Opus spend. Without this, rate limits are guesses. Add
  per-call logging (model, tokens-in, tokens-out, latency) to a structured
  log table; analyze before tuning rate limits.
- **AssistantMessage archival policy.** Today the table grows unbounded.
  Real archival (move-to-cold-table after 90 days) is correct but premature
  without traffic. Flag for once first heavy user crosses ~1k messages.
- **JSON-column-to-table migration for editObservations and pending stashes.**
  Better long-term shape than the current JSON blob, but the row-count
  doesn't justify the migration cost yet. Flag for once §2.5 race shows up
  in real telemetry.
- **Prisma transaction coverage.** Several multi-write paths (chapter +
  version, story + storyVersion) should be transactional. Bundling these
  is a sweep, not a one-shot fix; flag for a deliberate audit.

---

## §5. Methodology Note

Read in this order: `backend/src/services/ai.ts` (AI client wrapper),
`backend/src/index.ts` (Express setup, middleware order, timeouts),
`backend/src/lib/prisma.ts` (Prisma client config), `backend/src/routes/partner.ts`
(highest-traffic endpoint), `backend/src/routes/ai.ts` (chapter and polish
pipelines), `backend/src/lib/actions.ts` (dispatcher with embedded Opus calls),
`backend/src/lib/userStyleRules.ts` and `backend/src/routes/stories.ts` (the
three User.settings writers), `backend/prisma/schema.prisma` (indexes,
relations, JSON columns), `railway.toml` and `backend/start.sh` (deploy
config).

Greps run: every `callAI` and `callAIWithJSON` call site to count Opus
invocations per request handler; every `prisma.user.findUnique`/`update`
touching `settings` to map the JSON-column writers; every `@@index` in the
schema; every `new Anthropic` to find duplicate clients; every `connection_limit`
or pool-tuning string (none found). `git log --oneline backend/` to flag
recent additions that may not have telemetry yet (Wave 3, B-7, B-6 all
landed in the past 72 hours and are not yet load-tested).

What I cannot determine from static code:

- The actual Railway dyno size (RAM, CPU). The `railway.toml` doesn't pin
  it; assumed shared CPU based on the Hobby-tier pattern in user-level
  CLAUDE.md.
- The Neon plan's connection limit. Assumed 100 (Neon free-tier baseline)
  based on `start.sh`'s "Neon's free tier sometimes rejects connections"
  comment.
- The actual DATABASE_URL connection string parameters (held in Railway env,
  not in repo). If `connection_limit` is already set there, §2.3 finding 1
  may be partly mitigated; cannot confirm without prod env access.
- Real Anthropic latencies. The "30–90s typical" estimates are based on
  the 5-minute SDK timeout in `services/ai.ts:5` and standard Opus
  benchmarks. Production telemetry would refine these.
- Whether the existing `expressPipeline` job runner has its own concurrency
  cap (`backend/src/lib/expressPipeline.ts` was not read in detail; only the
  `runPipeline(jobId).catch(...)` invocation site at `actions.ts:1462`).
  If runPipeline spawns unbounded concurrent jobs, §2.1 fix 1 needs a
  concurrency-limit knob too.

The static analysis is sufficient to name the shape and order of the
fragility risks; precise thresholds will be tightened once real traffic
generates the telemetry called out in §4.
