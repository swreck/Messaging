# Schema Compatibility Rules — Maria 2.5 and Maria 3.0 Coexistence

This document defines the rules that keep Maria 2.5 and Maria 3.0 working against the same shared Neon Postgres database. Both versions run simultaneously as separate Railway services. 2.5 serves production users who have not migrated. 3.0 serves users who have opted in. Neither version is allowed to break the other.

These rules apply to every Prisma migration generated on the `3.0` branch. They are enforced by human review before any migration is merged. There is no automated tooling that prevents a violation — the discipline lives in the review process.

---

## The one rule

**Schema changes must be additive only.** 3.0 may add new tables, new columns, and new enum values. 3.0 may not remove, rename, restructure, or change the type of anything that already exists in the 2.5 schema.

Every 3.0 Prisma migration must pass this check before merging:

- Does it ADD a new table? **OK.**
- Does it ADD a new nullable column to an existing table? **OK if the default is sensible for a 2.5 reader.**
- Does it ADD a new enum value to an existing enum? **OK only if 2.5 can still read rows containing the new value. Verify by checking that 2.5's Prisma schema tolerates unknown values or by adding the value to 2.5's schema as a read-only known value.**
- Does it DROP a column? **FORBIDDEN.**
- Does it RENAME a column? **FORBIDDEN.**
- Does it CHANGE a column's type? **FORBIDDEN.**
- Does it ADD a NOT NULL column without a default? **FORBIDDEN.** (2.5 writes would fail.)
- Does it CHANGE the meaning of an existing column? **FORBIDDEN.** (2.5's reads would be wrong.)
- Does it ADD a foreign key constraint that would reject existing 2.5 writes? **FORBIDDEN.**
- Does it DROP a table? **FORBIDDEN.**

When a 3.0 feature appears to require a forbidden change, the feature must be redesigned to use additive changes — usually by adding a new column or table that 3.0 reads and writes, leaving the old column alone. 2.5 continues reading the old column. 3.0 reads the new column for its purposes.

---

## Why this rule exists

Maria 2.5 is a live product with real users. Any destructive schema change would break 2.5 immediately: 2.5's Prisma client expects specific columns and types. Rename a column and 2.5's `findMany` queries fail. Drop a table and 2.5's foreign key joins fail. Change a type and 2.5's type-checked reads return errors.

The additive-only rule is the ONLY way to guarantee that both versions can read and write the same database without either one breaking. It is not optional. It is not a best effort. A single violation means 2.5 users lose access to their data.

The rule also enables the rollback guarantee: a user who tries 3.0 and decides to go back to 2.5 must find their pre-migration data exactly as they left it. Additive-only changes make this automatic — 2.5 never lost visibility of any of the original columns, so the user's 2.5 experience is unchanged.

---

## Additive changes for 3.0 features

The 3.0 plan calls for many new capabilities. Every one of them must fit the additive-only rule. Here is how the major 3.0 features are implemented additively:

**Audience hierarchy.** 3.0 adds a nullable `parentAudienceId` column to the existing `Audience` table. 2.5 does not know this column exists and ignores it. An audience with a parent still appears in 2.5 as a flat audience. The audience name, description, and priorities are all read correctly by 2.5.

**Organizational voice and personalization at multiple levels.** 3.0 adds new `StyleProfile` and `VoiceProfile` tables. 2.5 never reads these tables. 3.0 users who set up a voice hierarchy see it in 3.0. A user who moves back to 2.5 sees no voice UI but their drafts are still their drafts. The existing `User.settings.personalize` JSON field in 2.5 remains the 2.5 source of truth for personalization and is untouched by 3.0.

**Source ingestion.** 3.0 adds a new `IngestedSource` table and a new nullable `sourceId` column on `OfferingElement` and `Priority`. 2.5 ignores the new table and the new column. Ingested extractions that land in the offering profile as new `OfferingElement` rows (with a source reference 2.5 doesn't read) still appear in 2.5 as regular offering elements.

**Get Feedback council personas.** 3.0 adds a new `ReviewerProfile` table and a new `WorkspaceSettings.councilConfig` JSON field (or a separate table). 2.5 ignores these. A 3.0 user's council configuration has no effect on 2.5.

**Market Strategy.** 3.0 adds new `Market`, `MarketAnalysis`, `MSFScore`, `MarketCandidate`, and related tables. 2.5 ignores them. A 3.0 user who has committed to a market sees the strategic context in 3.0. In 2.5 they see their audiences as a flat list.

**Variants.** 3.0 adds a new `DraftVariant` table that references the existing `ThreeTierDraft` and `FiveChapterStory` tables. 2.5 reads the base draft/story and ignores the variant references. A 3.0 user with multiple variants will see only the "active" variant in 2.5 (defined as the one the main draft row points at, typically the most recent). Their other variants are preserved in the database but invisible in 2.5.

**Named versions (the replacement for "checkpoint" terminology).** 3.0 adds optional labels to the existing `TableVersion` and `StoryVersion` records via a new nullable `displayName` column. 2.5 already supports labeled checkpoints and will read the new labels correctly. No schema structure change needed.

**Enum additions.** 3.0 adds new values to existing enums where necessary (e.g., `express` to `ThreeTierDraft.source` enum). 2.5's Prisma schema MUST be kept in sync with these additions so 2.5 can read rows with the new values without throwing enum deserialization errors. This is the one exception to the "do not touch 2.5 schema" rule — enum values must be added to both schemas, but 2.5 doesn't have to know what they mean, just that they exist.

---

## The 2.5 tables and columns that must never change

This is a protected inventory. Any modification to these requires Ken's explicit approval and is probably a sign the feature should be redesigned. These are the fields 2.5 depends on and that must remain stable:

**User table.** `id`, `username`, `passwordHash`, `isAdmin`, `settings` (JSON), `createdAt`, `updatedAt`. The `settings` JSON currently holds personalization, learning state, and Maria Partner intro state for 2.5 — 3.0 must NOT write to this field in a way that breaks 2.5's parsing. 3.0 can add new top-level keys to the JSON if needed, but existing keys are frozen.

**Workspace, WorkspaceMember, InviteCode tables.** All columns frozen.

**Offering, OfferingElement tables.** `id`, `name`, `description`, `text`, `source` (enum), `sortOrder`, `motivatingFactor`, workspace and offering foreign keys. All frozen. 3.0 can add nullable columns (e.g., `sourceId` for ingestion attribution, `depth` for quick-start vs. professional classification).

**Audience, Priority tables.** `id`, `name`, `description`, `text`, `rank`, `isSpoken`, `sortOrder`, `motivatingFactor`, `whatAudienceThinks`, foreign keys. All frozen. 3.0 adds nullable `parentAudienceId` on Audience.

**ThreeTierDraft, Mapping, Tier1Statement, Tier2Statement, Tier3Bullet tables.** All existing columns frozen. 3.0 can add nullable columns.

**FiveChapterStory, ChapterContent tables.** All existing columns frozen. 3.0 can add nullable columns. The `stage` field's enum values (`chapters`, `joined`, `blended`, `polished`, `personalized`) must remain recognized by both versions.

**CellVersion, TableVersion, ChapterVersion, StoryVersion tables.** All existing columns frozen. 3.0 can add nullable columns like `displayName` for named versions.

**ConversationMessage, AssistantMessage, ShareLink tables.** All existing columns frozen.

---

## Review process for 3.0 migrations

Every Prisma migration generated on the `3.0` branch must be reviewed against this document before merging. The review is a two-step check:

1. **Schema diff check.** Run `prisma migrate diff --from-schema-datamodel main-schema.prisma --to-schema-datamodel 3.0-schema.prisma` (or the equivalent) and visually inspect every line. Any line that removes, renames, or restructures existing 2.5 content is a violation.

2. **2.5 read test.** After applying the migration on a staging database, run the 2.5 test-functional suite against that database. Every 2.5 endpoint must still return correct data. If any test fails, the migration is blocked.

Only after both checks pass can the migration merge and deploy.

---

## When 2.5 needs a change

Bug fixes to 2.5 still happen on the `main` branch. Small improvements to 2.5 are also fine on main. If a bug fix or improvement requires a schema change, it must itself be additive — the same rule applies in reverse. A new column added to main must also be added to 3.0's Prisma schema so 3.0 doesn't ignore rows containing it.

When 2.5 needs a schema change, the sequence is:
1. Add the change to `main` as a regular migration.
2. Deploy 2.5 to verify it works.
3. Rebase or cherry-pick the change into the `3.0` branch so 3.0's schema also knows about it.
4. Verify 3.0 still reads and writes correctly.

---

## Sunsetting 2.5 eventually

There is no current plan to sunset 2.5. It remains an active product indefinitely. If and when 2.5 is sunset, the following sequence applies:

1. A grace period is announced during which users can still access 2.5.
2. The additive-only rule is lifted — 3.0 is now free to restructure the schema because no reader depends on the old structure.
3. Destructive migrations can run to clean up legacy fields and tables.
4. The `main` branch either becomes the 3.0 codebase or is archived.

Until that decision is explicitly made by Ken, the additive-only rule is in effect.

---

## What this rule costs us

Additive-only schema evolution is strictly more expensive than free restructuring. 3.0 will have some duplication (e.g., a new column that mostly overlaps with an existing one because the existing one cannot be modified). 3.0 will have some dead code and dead fields once 2.5 is eventually sunset. 3.0 will occasionally have to use more creative designs to achieve a feature that would have been simpler with a destructive change.

These costs are the price of the rollback guarantee and the never-break-2.5 rule. They are acceptable. A feature that cannot be built additively must be redesigned.
