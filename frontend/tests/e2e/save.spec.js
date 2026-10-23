import { test, expect, openDesigner } from './fixtures.js';

// The E2E backend runs without Supabase keys, so saved designs live in its in-memory store.
const LINK = /#d=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;

async function saveFromDialog(page) {
  await page.getByTestId('open-save').click();
  await page.getByTestId('save-confirm').click();
  await expect(page.getByTestId('share-link')).toHaveValue(LINK);
  const link = await page.getByTestId('share-link').inputValue();
  await page.getByTestId('save-close').click();
  return link;
}

const setHeight = (page, height) => page.evaluate(
  (value) => window.__banai.store.dispatch([{ op: 'update_dimensions', height: value }]).ok,
  height,
);

test.describe('save and reopen', () => {
  test('Save gives a private link that reopens the same design', async ({ page, context }) => {
    await openDesigner(page);
    expect(await setHeight(page, 2300)).toBe(true);
    const link = await saveFromDialog(page);
    await expect(page).toHaveURL(LINK);

    const reopened = await context.newPage();
    await reopened.goto(link);
    await reopened.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));
    await expect(reopened.getByTestId('start-screen')).toHaveCount(0);
    expect(await reopened.evaluate(() => window.__banai.store.getState().design.dimensions.height)).toBe(2300);
    await reopened.getByTestId('open-save').click();
    await expect(reopened.getByTestId('share-link')).toHaveValue(link);
  });

  test('saving again writes over the same link', async ({ page, context }) => {
    await openDesigner(page);
    const link = await saveFromDialog(page);
    expect(await setHeight(page, 2200)).toBe(true);
    expect(await saveFromDialog(page)).toBe(link);

    const reopened = await context.newPage();
    await reopened.goto(link);
    await reopened.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));
    expect(await reopened.evaluate(() => window.__banai.store.getState().design.dimensions.height)).toBe(2200);
  });

  test.describe('conflicts', () => {
    test.use({ allowedConsoleErrors: [/409/] });

    test('a save from an outdated copy is refused, not silently overwritten', async ({ page, context }) => {
      await openDesigner(page);
      const link = await saveFromDialog(page);
      const other = await context.newPage();
      await other.goto(link);
      await other.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));
      await saveFromDialog(other);

      await page.getByTestId('open-save').click();
      await page.getByTestId('save-confirm').click();
      await expect(page.getByTestId('save-status')).toContainText('נשמר בינתיים');
    });
  });

  test.describe('bad links', () => {
    test.use({ allowedConsoleErrors: [/404/] });

    test('a wrong token falls back to the basic wardrobe and says so', async ({ page }) => {
      await page.goto(`/#d=0b6f2a52-3c1e-4c8e-9a51-1f6f3f2b7d10.${'A'.repeat(43)}`);
      await expect(page.locator('#error-banner')).toContainText('did not open a saved design');
      await expect(page.getByTestId('start-screen')).toBeVisible();
    });
  });
});
