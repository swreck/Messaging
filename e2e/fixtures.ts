import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared fixtures for Maria e2e tests.
 *
 * - `authedPage`: a Page that is already logged in as admin
 * - `maria`: helper object for interacting with the Maria chat assistant
 */

// Derive the API base URL from the page base URL
function apiBase(baseURL: string): string {
  if (baseURL.includes('localhost:5173')) {
    // Local dev: API is on a different port
    return 'http://localhost:3001/api';
  }
  // Production: API is on the same origin
  return `${baseURL}/api`;
}

interface MariaHelper {
  /** Send a message to Maria and wait for her response */
  send(page: Page, message: string): Promise<string>;
  /** Get all visible Maria response messages */
  getResponses(page: Page): Promise<string[]>;
  /** Get the action badge text from the most recent Maria response, if any */
  getLastActionBadge(page: Page): Promise<string | null>;
}

export const maria: MariaHelper = {
  async send(page: Page, message: string): Promise<string> {
    const input = page.locator('.maria-input-bar input');
    await input.fill(message);
    await input.press('Enter');

    // Wait for the spinner to appear (sending started) then disappear (response received)
    // Maria sets sending=true which disables the input, then re-enables when done
    await expect(input).toBeDisabled({ timeout: 5_000 });
    await expect(input).toBeEnabled({ timeout: 90_000 }); // AI responses can be slow

    // Get the last assistant message
    const assistantMessages = page.locator('.maria-msg-assistant .maria-msg-text');
    const count = await assistantMessages.count();
    if (count === 0) {
      throw new Error('No Maria response appeared after sending message');
    }
    const lastMsg = assistantMessages.nth(count - 1);
    return (await lastMsg.textContent()) || '';
  },

  async getResponses(page: Page): Promise<string[]> {
    const msgs = page.locator('.maria-msg-assistant .maria-msg-text');
    const count = await msgs.count();
    const texts: string[] = [];
    for (let i = 0; i < count; i++) {
      texts.push((await msgs.nth(i).textContent()) || '');
    }
    return texts;
  },

  async getLastActionBadge(page: Page): Promise<string | null> {
    const badges = page.locator('.maria-msg-assistant .maria-action-badge');
    const count = await badges.count();
    if (count === 0) return null;
    return (await badges.nth(count - 1).textContent()) || null;
  },
};

/** Login via the API and inject the token into localStorage before navigating */
async function loginViaAPI(page: Page, baseURL: string) {
  const api = apiBase(baseURL);

  // Call the login endpoint directly to get a token
  const response = await page.request.post(`${api}/auth/login`, {
    data: { username: 'admin', password: 'maria2026' },
  });

  if (!response.ok()) {
    throw new Error(`Login API failed: ${response.status()} ${await response.text()}`);
  }

  const { token } = await response.json();

  // Navigate to the app origin first (needed to set localStorage)
  await page.goto(baseURL);

  // Inject the token into localStorage
  await page.evaluate((t: string) => {
    localStorage.setItem('token', t);
  }, token);
}

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page, baseURL }, use) => {
    await loginViaAPI(page, baseURL!);
    await use(page);
  },
});

export { expect };
