import AxeBuilder from '@axe-core/playwright';
import { expect, openDesigner, test } from './fixtures.js';

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

async function mockAgent(page) {
  await page.route('**/api/health', (route) => route.fulfill(ok({ status: 'ok', env: 'e2e', agent: true, storage: true })));
  await page.route('**/api/chat', (route) => route.fulfill(ok({
    reply: 'אפשר! הנה ההצעה שלי.',
    proposal: {
      proposalId: 'prp_0123456789abcdef', baseRevision: route.request().postDataJSON().revision, baseHash: 'a'.repeat(64),
      ops: [{ op: 'update_dimensions', depth: 550 }], signature: 'b'.repeat(64),
      summary: 'Makes the wardrobe shallower.', changes: [{ title: 'Depth', detail: '60.0 cm to 55.0 cm' }],
    },
  })));
  await page.route('**/api/proposals/apply', (route) => {
    const body = route.request().postDataJSON();
    const design = structuredClone(body.design);
    design.dimensions.depth = 550;
    return route.fulfill(ok({ design, revision: body.revision + 1 }));
  });
}

const toasts = (page) => page.getByTestId('toast');

test.describe('toast messages', () => {
  test('a confirmed AI change says so briefly, in a polite live region', async ({ page }) => {
    await mockAgent(page);
    await openDesigner(page);
    await page.getByTestId('chat-input').fill('פחות עמוק');
    await page.getByTestId('chat-send').click();
    await page.getByTestId('proposal-confirm').click();

    const toast = toasts(page);
    await expect(toast).toHaveText('Change applied');
    const region = page.getByTestId('toast-region');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    expect(await region.evaluate((node) => node.parentElement === document.body)).toBe(true);

    await page.evaluate(() => Promise.all(document.getAnimations()
      .filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);

    await expect(toast).toHaveCount(0, { timeout: 5000 }); // gone after about 3 seconds
  });

  test('hovering a toast keeps it until the pointer leaves', async ({ page }) => {
    await mockAgent(page);
    await openDesigner(page);
    await page.getByTestId('chat-input').fill('פחות עמוק');
    await page.getByTestId('chat-send').click();
    await page.getByTestId('proposal-confirm').click();
    await toasts(page).hover();
    await page.waitForTimeout(4500); // longer than its 3 seconds
    await expect(toasts(page)).toHaveText('Change applied');
    await page.mouse.move(5, 5);
    await expect(toasts(page)).toHaveCount(0, { timeout: 5000 });
  });

  test('Save and Copy link show toasts on top of the open dialog, at most three at a time', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDesigner(page);
    await page.getByTestId('open-save').click();
    await page.getByTestId('save-confirm').click();
    // The page behind a modal dialog is inert, so the message sits inside the dialog.
    await expect(page.locator('[data-testid="save-dialog"] [data-testid="toast"]')).toHaveText('Design saved');
    await expect(toasts(page)).toBeVisible();

    for (let i = 0; i < 3; i += 1) await page.getByTestId('copy-link').click();
    await expect(toasts(page)).toHaveCount(3);
    await expect(toasts(page).last()).toHaveText('Link copied');
    await expect(page.getByTestId('save-status')).toHaveText('Link copied.'); // the dialog's own status stays

    await page.getByTestId('save-close').click();
    expect(await page.getByTestId('toast-region').evaluate((node) => node.parentElement === document.body)).toBe(true);
  });

  test('the PDF download says the PDF is ready', async ({ page }) => {
    await openDesigner(page);
    await page.getByTestId('open-export').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('export-download').click();
    await download;
    await expect(page.locator('[data-testid="export-dialog"] [data-testid="toast"]')).toHaveText('PDF ready');
  });
});
