import AxeBuilder from '@axe-core/playwright';
import { expect, openDesigner, test } from './fixtures.js';

// Quick requests above the chat composer. The network edge is mocked like agent.spec.js: the E2E
// backend has no OpenAI key.

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

async function mockAgent(page) {
  const calls = [];
  await page.route('**/api/health', (route) => route.fulfill(ok({ status: 'ok', env: 'e2e', agent: true })));
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await new Promise((resolve) => setTimeout(resolve, 600)); // long enough to see the chips disabled
    await route.fulfill(ok({
      reply: body.language === 'en' ? 'Sure! Here is my proposal.' : 'אפשר! הנה ההצעה שלי.',
      proposal: {
        proposalId: 'prp_0123456789abcdef', baseRevision: body.revision, baseHash: 'a'.repeat(64),
        ops: [{ op: 'update_dimensions', width: 2500 }], signature: 'b'.repeat(64),
        summary: 'Makes the wardrobe wider.', changes: [{ title: 'Width', detail: '200.0 cm to 250.0 cm' }],
      },
    }));
  });
  await page.route('**/api/proposals/apply', async (route) => {
    const body = route.request().postDataJSON();
    const design = structuredClone(body.design);
    design.dimensions.width = 2500;
    const extra = 500; // keep the width rule: the last compartment takes the extra width
    design.compartments.at(-1).width += extra;
    await route.fulfill(ok({ design, revision: body.revision + 1 }));
  });
  return calls;
}

const chips = (page) => page.getByTestId('quick-prompt');
const width = (page) => page.evaluate(() => window.__banai.store.getState().design.dimensions.width);

test.describe('quick requests in the chat', () => {
  test('a chip sends its text as a normal message and ends in a proposal to confirm', async ({ page }) => {
    const calls = await mockAgent(page);
    await openDesigner(page);
    await expect(page.getByTestId('quick-prompts')).toHaveAttribute('aria-label', 'בקשות מהירות');
    await expect(chips(page)).toHaveText(['הוסף מגירות', 'הגדל לרוחב 2.5 מטר', 'דלתות הזזה', 'הוסף מוט תלייה']);

    await page.getByTestId('chat-input').fill('טיוטה שלי');
    await chips(page).nth(1).click();
    await expect(page.getByTestId('chat-typing')).toBeVisible();
    for (const chip of await chips(page).all()) await expect(chip).toBeDisabled(); // like the send button
    await expect(page.getByTestId('proposal-card')).toContainText('200.0 cm to 250.0 cm');
    expect(calls).toHaveLength(1);
    expect(calls[0].messages).toEqual([{ role: 'user', text: 'הגדל לרוחב 2.5 מטר' }]);
    await expect(page.getByTestId('chat-input')).toHaveValue('טיוטה שלי'); // the typed text is kept
    await expect(chips(page).first()).toBeEnabled();
    expect(await width(page)).toBe(2000); // nothing applied before Confirm

    await page.getByTestId('proposal-confirm').click();
    await expect.poll(() => width(page)).toBe(2500);
    await expect(page.getByTestId('quick-prompts')).toBeVisible(); // still there for the next request
  });

  test('works from the keyboard and follows the chat language', async ({ page }) => {
    const calls = await mockAgent(page);
    await openDesigner(page);
    await page.getByTestId('chat-language-en').click();
    await expect(chips(page)).toHaveText(['Add drawers', 'Make it 2.5 m wide', 'Sliding doors', 'Add a hanging rail']);
    await expect(page.getByTestId('quick-prompts')).toHaveAttribute('aria-label', 'Quick requests');

    await chips(page).nth(2).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('proposal-card')).toBeVisible();
    expect(calls[0]).toMatchObject({ language: 'en', messages: [{ role: 'user', text: 'Sliding doors' }] });

    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))); // the online dot pulses forever
    const { violations } = await new AxeBuilder({ page }).include('#chat-panel').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });

  test('are not shown when the AI designer is not connected', async ({ page }) => {
    await openDesigner(page); // the E2E backend reports no agent
    await expect(page.getByTestId('chat-input')).toBeVisible();
    await expect(page.getByTestId('quick-prompts')).toHaveCount(0);
  });
});
