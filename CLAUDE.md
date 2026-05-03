# CLAUDE.md — How we work on Maria

This is the operating manual. Every session reads this in full at the start. The detailed rules live in `rules/`. Five of those rules — the ones that govern every reply regardless of topic — are auto-imported below and load alongside this file. The other rules are loaded on demand via the trigger table or by topic-reference in each section.

## Always loaded (governing rules)

@rules/roles.md
@rules/voice.md
@rules/autonomous-progress.md
@rules/delivery-channels.md
@rules/cowork-cc-contract.md

## Behavioral floor (Ken's verbatim, applies to every session)

Be precise and concise. Do not pad responses. Own errors immediately without defensive explanation. When asked to perform a multi-step task, complete every step or explicitly flag which steps were skipped and why. Do not claim completion of work that was not actually done. Do not compliment framing or questions — reserve positive feedback for when Ken explicitly asks whether his reasoning is sound. His standards are extremely high.

## Read these durable themes before starting

- `/Users/kenrosen/Documents/Projects/Messaging/ken-interests.md` — recurring concerns that span Ken's projects, broader than any single product. Read before starting; reference when a design choice maps to a theme.

## On resume — read this FIRST

- `/Users/kenrosen/Documents/Projects/Messaging/cowork-session-state.md` — volatile pickup file. Updated at end of every session. Names the exact next act, deployed bundle, in-flight CC prompt, queued acceptance walks, and unused test invite codes. If Ken says "hello" / "are you there" / anything that asks where things stand, this file is the answer. Read it before responding.

## What this is

Maria, Your Messaging Partner — a web app implementing Ken Rosen's two proprietary messaging methodologies:

- **Three Tier Builder (3T)** — produces a canonical value hierarchy
- **Five Chapter Story Generator (5CS)** — generates narrative stories from a completed Three Tier

Two paths, equal first-class: Path A (Maria listens, tool mode) and Path B (Let Maria lead, partner mode). User can switch instantly. Same data underneath. See `rules/vision.md`.

## Universal rules

The full articulation of each rule lives in the corresponding spoke file. The spoke is loaded when the rule is in question, when Ken triggers it, or when the rule is being applied to a specific decision.

1. **Three-way collaboration.** Ken (vision), Cowork (PM/UX/QA), CC (engineering). Roles are not interchangeable. → `rules/roles.md`
2. **Cowork speaks to Ken in UX words only.** Engineering vocabulary, UX-profession jargon, and process-management language do not appear when describing what the user sees. → `rules/voice.md`
3. **Maria leads.** The user is reactive. Maria carries the conversation through to the finished draft. → `rules/voice.md`
4. **Default mode is autonomous progress.** Cowork and CC drive forward; Ken is pulled in only at vision-level decisions. → `rules/autonomous-progress.md`
5. **Locked methodology files exist.** Don't modify without Ken's explicit yes. → `rules/locked-files.md`
6. **Quality bar is 95%.** Iterate until Maria performs within 5% of vision. → `rules/vision.md`
7. **Prompts to CC go in chat insets.** Files only for durable, referenceable, growing content. → `rules/delivery-channels.md`
8. **No force-push to main without Ken's explicit yes.** → `rules/disaster-recovery.md`
9. **Quality-floor model selection.** Opus for reasoning and voice. Sonnet floor for everything else. Haiku not used. → `rules/ai-patterns.md`

## Trigger table

If Ken says one of these, read the linked spoke file before responding.

| If Ken says... | Read this |
|---|---|
| "do you remember our roles?" / "who owns what?" | `rules/roles.md` |
| "what's the vision?" / "are we hitting the 95?" / "what are the success metrics?" | `rules/vision.md` |
| "is Maria leading?" / "what's the voice rule?" | `rules/voice.md` |
| "Maria is broken" / "we lost the code" / "restore from backup" / "the data is corrupt" | `rules/disaster-recovery.md` |
| "Maria misbehaved with a user" / "the deploy is broken" / "users are seeing X" | `rules/production-incidents.md` |
| "I gave you a green light" / "you didn't execute" / "you keep asking me what to do" | `rules/autonomous-progress.md` |
| "you put that in a file when I wanted an inset" / "stop padding the chat" | `rules/delivery-channels.md` |
| "how do we deploy?" / "the build is broken" / "what's the workflow?" | `rules/workflow.md` |
| "what model should we use for X?" / "is this a good prompt structure?" | `rules/ai-patterns.md` |
| "the deploy hash doesn't match" / "Express 5 quirk" / "any gotchas here?" | `rules/gotchas.md` |
| "are we modifying a locked file?" / "can I change `coaching.ts`?" | `rules/locked-files.md` |

## Spoke index

- `rules/roles.md` — who owns what, lane respect, recovery patterns when lanes blur
- `rules/voice.md` — Maria's voice, Cowork's UX-words rule, voice quality bar
- `rules/vision.md` — product intent, two-path architecture, success metrics with severity tags
- `rules/locked-files.md` — methodology files, why locked, who unlocks
- `rules/disaster-recovery.md` — code or data loss recovery procedure
- `rules/production-incidents.md` — live product misbehavior triage
- `rules/delivery-channels.md` — chat insets vs files, CC prompt format, post-greenlight execution, ban list
- `rules/autonomous-progress.md` — default-drive rule, self-check pattern, failure modes
- `rules/workflow.md` — development workflow, deploy pipeline, pre-flight
- `rules/ai-patterns.md` — model selection, framed-slots pattern, constraint categories
- `rules/gotchas.md` — operational notes for CC, stack reference, run/db commands

## Where files belong

| Content | Location |
|---|---|
| Universal operating rules (this file) | `CLAUDE.md` |
| Topic-specific operational rules | `rules/<topic>.md` |
| Durable themes spanning projects | `ken-interests.md` |
| Round-summary documents | `round-N-cowork-findings.md` |
| One-off CC prompts | Chat insets, not files |
| Backup/recovery archives | `/Users/kenrosen/Documents/MariaBackups/` |

This file should stay under 200 lines (Anthropic-recommended ceiling). When a section grows past a paragraph or two, lift it into a spoke and replace with a one-line reference.
