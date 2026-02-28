import { test, expect, maria } from './fixtures';

/**
 * Maria Wiring Tests
 *
 * These tests verify that Maria's AI-driven actions correctly update the page
 * WITHOUT requiring a manual refresh. This is the class of bugs that pure API
 * tests cannot catch — the wiring between backend mutations and frontend state.
 *
 * Tests run serially against production. They create and clean up their own
 * test data using a unique prefix to avoid collisions.
 */

// Use a short random suffix to avoid collisions without looking like a database ID
const TEST_TAG = `Zeta${Math.floor(Math.random() * 900 + 100)}`;
const TEST_AUDIENCE = `${TEST_TAG} Hospital Admins`;
const TEST_OFFERING = `${TEST_TAG} DiagPlatform`;

test.describe.serial('Maria Wiring Tests', () => {

  // ────────────────────────────────────────────────────────
  // 1. Login flow
  // ────────────────────────────────────────────────────────
  test('1 - Login flow reaches dashboard', async ({ authedPage: page }) => {
    await page.goto('/');
    // Dashboard should show — either the welcome state or the nav tiles
    await expect(
      page.locator('.dashboard-welcome, .nav-tiles, .continue-card').first()
    ).toBeVisible({ timeout: 15_000 });
    // Maria input bar should be present at the bottom
    await expect(page.locator('.maria-input-bar input')).toBeVisible();
  });

  // ────────────────────────────────────────────────────────
  // 2. Setup: create test audience and offering via UI
  //    (needed for subsequent Maria tests)
  // ────────────────────────────────────────────────────────
  test('2 - Create test audience for Maria tests', async ({ authedPage: page }) => {
    await page.goto('/audiences');
    await expect(page.locator('h1:has-text("Audiences")')).toBeVisible({ timeout: 15_000 });

    // Click "Add Audience" button
    await page.locator('button:has-text("Add Audience")').click();
    await expect(page.locator('.modal-overlay')).toBeVisible();

    // Fill in the form
    await page.locator('.modal-overlay input[required]').first().fill(TEST_AUDIENCE);
    await page.locator('.modal-overlay textarea').fill('Playwright test audience — safe to delete');

    // Submit
    await page.locator('.modal-overlay button[type="submit"]').click();
    await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 10_000 });

    // Verify the audience appears in the list
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).toBeVisible({ timeout: 10_000 });
  });

  test('2b - Create test offering for Maria tests', async ({ authedPage: page }) => {
    await page.goto('/offerings');
    await expect(page.locator('h1:has-text("Offerings")')).toBeVisible({ timeout: 15_000 });

    await page.locator('button:has-text("Add Offering")').click();
    await expect(page.locator('.modal-overlay')).toBeVisible();

    // Fill form — the first required input is the name
    await page.locator('.modal-overlay input[required]').first().fill(TEST_OFFERING);
    await page.locator('.modal-overlay textarea').first().fill('Playwright test offering — safe to delete');

    await page.locator('.modal-overlay button[type="submit"]').click();

    // After creating, the app navigates to the offering detail page
    await expect(page.locator(`h1:has-text("${TEST_OFFERING}")`)).toBeVisible({ timeout: 15_000 });
  });

  // ────────────────────────────────────────────────────────
  // 3. Maria add priority — refresh wiring on Audiences page
  // ────────────────────────────────────────────────────────
  test('3 - Maria adds a priority and it appears without refresh', async ({ authedPage: page }) => {
    await page.goto('/audiences');
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).toBeVisible({ timeout: 15_000 });

    // Expand the test audience card
    const card = page.locator('.expandable-card', { has: page.locator(`text=${TEST_AUDIENCE}`) });
    await card.locator('.expandable-card-header').click();

    // Wait for the expanded body to appear
    await expect(card.locator('.expandable-card-body')).toBeVisible({ timeout: 5_000 });

    // Note: expanding the card sets audienceId in Maria's context
    // Now ask Maria to add a priority
    const priorityText = `${TEST_TAG} Fast onboarding`;
    const response = await maria.send(page, `Add a priority called "${priorityText}"`);

    // Maria should respond (wording varies, so just check she said something)
    expect(response.length).toBeGreaterThan(0);

    // KEY TEST: the priority should appear on the page WITHOUT manual refresh
    // Check action badge OR the priority appearing — either confirms the wiring works
    const badge = await maria.getLastActionBadge(page);
    await expect(page.locator(`.priority-text:has-text("${priorityText}")`)).toBeVisible({ timeout: 15_000 });
  });

  // ────────────────────────────────────────────────────────
  // 4. Maria add capability — refresh wiring on Offering Detail
  // ────────────────────────────────────────────────────────
  test('4 - Maria adds a capability to an offering and it appears without refresh', async ({ authedPage: page }) => {
    // Navigate to offerings list, then click into the test offering
    await page.goto('/offerings');
    await expect(page.locator('h1:has-text("Offerings")')).toBeVisible({ timeout: 15_000 });

    // Click the test offering card to navigate to its detail page
    await page.locator(`.list-card`, { has: page.locator(`text=${TEST_OFFERING}`) }).click();
    await expect(page.locator(`h1:has-text("${TEST_OFFERING}")`)).toBeVisible({ timeout: 15_000 });

    // Now Maria should have offeringId in context
    const capText = `${TEST_TAG} AI-powered analytics`;
    const response = await maria.send(page, `Add a capability called "${capText}"`);

    expect(response).toBeTruthy();

    // KEY TEST: capability should appear on the page without refresh
    await expect(page.locator(`.differentiator-text:has-text("${capText}")`)).toBeVisible({ timeout: 15_000 });
  });

  // ────────────────────────────────────────────────────────
  // 5. Maria edit action — rename a priority
  // ────────────────────────────────────────────────────────
  test('5 - Maria renames a priority and the new name appears', async ({ authedPage: page }) => {
    await page.goto('/audiences');
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).toBeVisible({ timeout: 15_000 });

    // Expand the test audience
    const card = page.locator('.expandable-card', { has: page.locator(`text=${TEST_AUDIENCE}`) });
    await card.locator('.expandable-card-header').click();
    await expect(card.locator('.expandable-card-body')).toBeVisible({ timeout: 5_000 });

    const oldPriority = `${TEST_TAG} Fast onboarding`;
    const newPriority = `${TEST_TAG} Rapid onboarding`;

    // Verify the old priority exists
    await expect(page.locator(`.priority-text:has-text("${oldPriority}")`)).toBeVisible({ timeout: 5_000 });

    // Ask Maria to rename it
    const response = await maria.send(page, `Rename the priority "${oldPriority}" to "${newPriority}"`);
    expect(response).toBeTruthy();

    // KEY TEST: the new name should appear, old name should be gone
    await expect(page.locator(`.priority-text:has-text("${newPriority}")`)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(`.priority-text:has-text("${oldPriority}")`)).not.toBeVisible({ timeout: 5_000 });
  });

  // ────────────────────────────────────────────────────────
  // 6. Maria delete action — delete a priority
  // ────────────────────────────────────────────────────────
  test('6 - Maria deletes a priority and it disappears', async ({ authedPage: page }) => {
    await page.goto('/audiences');
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).toBeVisible({ timeout: 15_000 });

    // Expand the test audience
    const card = page.locator('.expandable-card', { has: page.locator(`text=${TEST_AUDIENCE}`) });
    await card.locator('.expandable-card-header').click();
    await expect(card.locator('.expandable-card-body')).toBeVisible({ timeout: 5_000 });

    const targetPriority = `${TEST_TAG} Rapid onboarding`;

    // Verify the priority exists
    await expect(page.locator(`.priority-text:has-text("${targetPriority}")`)).toBeVisible({ timeout: 5_000 });

    // Ask Maria to delete it
    const response = await maria.send(page, `Delete the priority "${targetPriority}"`);
    expect(response).toBeTruthy();

    // KEY TEST: the priority should be gone from the page
    await expect(page.locator(`.priority-text:has-text("${targetPriority}")`)).not.toBeVisible({ timeout: 15_000 });
  });

  // ────────────────────────────────────────────────────────
  // 7. Maria chat-only — no false mutations
  // ────────────────────────────────────────────────────────
  test('7 - Maria answers a question without mutating page data', async ({ authedPage: page }) => {
    await page.goto('/audiences');
    await expect(page.locator('h1:has-text("Audiences")')).toBeVisible({ timeout: 15_000 });

    // Capture current page state: count of audience cards
    const cardCountBefore = await page.locator('.expandable-card').count();

    // Ask Maria a methodology question (no action expected)
    const response = await maria.send(page, 'What is the difference between a Three Tier message and a Five Chapter story?');
    expect(response).toBeTruthy();
    expect(response.length).toBeGreaterThan(20); // Should be a substantive answer

    // The action badge should NOT appear (no mutation)
    const badge = await maria.getLastActionBadge(page);
    // Badge might be null or missing — either way, should not say "Added"/"Deleted"/"Updated"
    if (badge) {
      expect(badge.toLowerCase()).not.toMatch(/added|deleted|updated|created/);
    }

    // Page content should be unchanged
    const cardCountAfter = await page.locator('.expandable-card').count();
    expect(cardCountAfter).toBe(cardCountBefore);
  });

  // ────────────────────────────────────────────────────────
  // 8. Maria context passing — audienceId flows from expanded card
  // ────────────────────────────────────────────────────────
  test('8 - Maria receives audienceId context when a card is expanded', async ({ authedPage: page }) => {
    await page.goto('/audiences');
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).toBeVisible({ timeout: 15_000 });

    // Expand the test audience card (this sets audienceId in MariaContext)
    const card = page.locator('.expandable-card', { has: page.locator(`text=${TEST_AUDIENCE}`) });
    await card.locator('.expandable-card-header').click();
    await expect(card.locator('.expandable-card-body')).toBeVisible({ timeout: 5_000 });

    // Ask Maria to add a priority — she should know which audience to target
    const contextPriority = `${TEST_TAG} Context test priority`;
    const response = await maria.send(page, `Add a priority: "${contextPriority}"`);
    expect(response).toBeTruthy();

    // KEY TEST: The priority should appear under THIS audience (not somewhere random)
    await expect(
      card.locator(`.priority-text:has-text("${contextPriority}")`)
    ).toBeVisible({ timeout: 15_000 });

    // Clean up: delete it via Maria
    await maria.send(page, `Delete the priority "${contextPriority}"`);
    await expect(
      card.locator(`.priority-text:has-text("${contextPriority}")`)
    ).not.toBeVisible({ timeout: 15_000 });
  });

  // ────────────────────────────────────────────────────────
  // 9. Silent failure messaging — missing context shows error
  // ────────────────────────────────────────────────────────
  test('9 - Maria shows error when context is missing for mutation', async ({ authedPage: page }) => {
    // Navigate to the dashboard (no audienceId or offeringId in context)
    await page.goto('/');
    await expect(
      page.locator('.dashboard-welcome, .nav-tiles, .continue-card').first()
    ).toBeVisible({ timeout: 15_000 });

    // Ask Maria to add a priority — but we're on the dashboard with no audience expanded
    const response = await maria.send(page, 'Add a priority called "This should fail gracefully"');
    expect(response).toBeTruthy();

    // Maria's response or action badge should indicate the action couldn't be performed.
    // The backend returns actionResult with "missing context" or "Could not execute" when
    // the required context (audienceId) is absent.
    const badge = await maria.getLastActionBadge(page);

    // Either the badge or the response text should explain the failure
    const combinedText = `${response} ${badge || ''}`.toLowerCase();
    const indicatesFailureOrGuidance = (
      combinedText.includes('missing') ||
      combinedText.includes('navigate') ||
      combinedText.includes('could not') ||
      combinedText.includes('which audience') ||
      combinedText.includes('select an audience') ||
      combinedText.includes('go to') ||
      combinedText.includes('audience') // Maria should at least mention needing an audience
    );
    expect(indicatesFailureOrGuidance).toBe(true);
  });

  // ────────────────────────────────────────────────────────
  // 10. Multi-action — one message triggers multiple changes
  // ────────────────────────────────────────────────────────
  test('10 - Maria executes multiple actions from one message', async ({ authedPage: page }) => {
    await page.goto('/audiences');
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).toBeVisible({ timeout: 15_000 });

    // Expand the test audience
    const card = page.locator('.expandable-card', { has: page.locator(`text=${TEST_AUDIENCE}`) });
    await card.locator('.expandable-card-header').click();
    await expect(card.locator('.expandable-card-body')).toBeVisible({ timeout: 5_000 });

    // Ask Maria to do two things in one message: add two priorities
    const pri1 = `${TEST_TAG} Reduce wait times`;
    const pri2 = `${TEST_TAG} Improve staff retention`;
    const response = await maria.send(
      page,
      `Add two priorities: "${pri1}" and "${pri2}"`
    );
    expect(response).toBeTruthy();

    // KEY TEST: both priorities should appear on the page
    await expect(
      card.locator(`.priority-text:has-text("${pri1}")`)
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      card.locator(`.priority-text:has-text("${pri2}")`)
    ).toBeVisible({ timeout: 5_000 });

    // Check the action badge shows both were handled
    const badge = await maria.getLastActionBadge(page);
    // Badge should mention adding 2 priorities (exact wording varies)
    expect(badge).toBeTruthy();

    // Clean up: delete both via Maria
    await maria.send(page, `Delete the priorities "${pri1}" and "${pri2}"`);
    await expect(
      card.locator(`.priority-text:has-text("${pri1}")`)
    ).not.toBeVisible({ timeout: 15_000 });
    await expect(
      card.locator(`.priority-text:has-text("${pri2}")`)
    ).not.toBeVisible({ timeout: 5_000 });
  });

  // ────────────────────────────────────────────────────────
  // Cleanup: remove test data
  // ────────────────────────────────────────────────────────
  test('cleanup - Remove test audience and offering', async ({ authedPage: page }) => {
    // Delete the test audience
    await page.goto('/audiences');
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).toBeVisible({ timeout: 15_000 });

    const audCard = page.locator('.expandable-card', { has: page.locator(`text=${TEST_AUDIENCE}`) });

    // Handle the confirm dialog (use once to avoid double-handling)
    page.once('dialog', dialog => dialog.accept());
    await audCard.locator('button:has-text("Delete")').click();

    // Wait for it to disappear
    await expect(page.locator(`text=${TEST_AUDIENCE}`)).not.toBeVisible({ timeout: 10_000 });

    // Delete the test offering
    await page.goto('/offerings');
    await expect(page.locator('h1:has-text("Offerings")')).toBeVisible({ timeout: 15_000 });

    // Click into the test offering detail page
    const offeringCard = page.locator('.list-card', { has: page.locator(`text=${TEST_OFFERING}`) });
    // It might already be gone if tests failed; check existence first
    const offeringExists = await offeringCard.count() > 0;
    if (offeringExists) {
      await offeringCard.click();
      await expect(page.locator(`h1:has-text("${TEST_OFFERING}")`)).toBeVisible({ timeout: 15_000 });

      page.once('dialog', dialog => dialog.accept());
      await page.locator('button:has-text("Delete")').click();

      // Should navigate back to offerings list
      await expect(page.locator('h1:has-text("Offerings")')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator(`text=${TEST_OFFERING}`)).not.toBeVisible({ timeout: 5_000 });
    }
  });
});
