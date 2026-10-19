import { expect, openDesigner, test } from './fixtures.js';

// Saving and reopening through the real backend (E2E runs it with its in-memory store, never Supabase).

const API = 'http://localhost:8010';
const dimensions = (page) => page.evaluate(() => window.__banai.store.getState().design.dimensions);
const ready = (page) => page.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));

async function commit(locator, value) {
  await locator.fill(value);
  await locator.press('Enter');
}

async function saveFromDialog(page) {
  await page.getByTestId('open-save').click();
  await page.getByTestId('save-confirm').click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved. The link opens this version.');
  const link = await page.getByTestId('share-link').inputValue();
  await page.getByTestId('save-close').click();
  return link;
}

test.describe('saving and reopening designs (Phase 7)', () => {
  test('saving gives a private link that reopens the same design on another device', async ({ page, browser }) => {
    await openDesigner(page);
    await commit(page.getByTestId('dim-width'), '240');
    await expect.poll(async () => (await dimensions(page)).width).toBe(2400);

    await page.getByTestId('open-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('Not saved yet.');
    await expect(page.getByTestId('share-link')).toHaveValue('');
    await expect(page.getByTestId('copy-link')).toBeDisabled();
    await page.getByTestId('save-confirm').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved. The link opens this version.');
    const link = await page.getByTestId('share-link').inputValue();
    expect(link).toMatch(/^http:\/\/localhost:5183\/#d=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(page.url()).toBe(link); // the address bar is the private link
    await expect(page.getByTestId('copy-link')).toBeEnabled();
    await page.getByTestId('save-close').click();
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');

    // A fresh browser context shares nothing with this one: the link alone opens the design.
    const device = await browser.newContext();
    const reopened = await device.newPage();
    await reopened.goto(link);
    await ready(reopened);
    await expect(reopened.getByTestId('start-screen')).toHaveCount(0);
    expect(await dimensions(reopened)).toEqual({ width: 2400, height: 2400, depth: 600 });
    await expect(reopened.getByText('W 240.0 cm', { exact: true })).toBeVisible();
    await expect(reopened.getByTestId('save-indicator')).toHaveText('Saved');
    await device.close();
  });

  test('saving changes keeps the same link, and the top bar shows unsaved changes until then', async ({ page }) => {
    await openDesigner(page);
    const link = await saveFromDialog(page);
    await commit(page.getByTestId('dim-depth'), '55');
    await expect(page.getByTestId('save-indicator')).toHaveText('Unsaved changes');

    await page.getByTestId('open-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('You have changes that are not saved yet.');
    await expect(page.getByTestId('save-confirm')).toHaveText('Save changes');
    await page.getByTestId('save-confirm').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved. The link opens this version.');
    await expect(page.getByTestId('save-confirm')).toBeDisabled(); // nothing left to save
    await expect(page.getByTestId('share-link')).toHaveValue(link);
    await page.getByTestId('save-close').click();

    await page.reload();
    await ready(page);
    expect((await dimensions(page)).depth).toBe(550);
    await expect(page.getByTestId('save-indicator')).toHaveText('Saved');
  });

  test('pasting another link into the address bar opens that design', async ({ page }) => {
    const basic = (await (await page.request.get(`${API}/api/designs/default`)).json()).data.design;
    const created = await page.request.post(`${API}/api/designs`, { data: { design: { ...basic, dimensions: { ...basic.dimensions, depth: 450 } } } });
    const { designId, accessToken } = (await created.json()).data;

    await openDesigner(page);
    await saveFromDialog(page);
    const reloaded = page.waitForEvent('load');
    await page.evaluate((hash) => { window.location.hash = hash; }, `#d=${designId}.${accessToken}`);
    await reloaded;
    await ready(page);
    expect((await dimensions(page)).depth).toBe(450);
    await expect(page.getByTestId('start-screen')).toHaveCount(0);
  });
});

test.describe('saving after the design changed elsewhere', () => {
  test.use({ allowedConsoleErrors: [/status of 409/] });

  test('a stale save is refused, and "Save as a new link" keeps both versions', async ({ page, context }) => {
    await openDesigner(page);
    const link = await saveFromDialog(page);

    const otherTab = await context.newPage();
    await otherTab.goto(link);
    await ready(otherTab);
    await commit(otherTab.getByTestId('dim-depth'), '55');
    await saveFromDialog(otherTab);

    await commit(page.getByTestId('dim-width'), '240');
    await expect.poll(async () => (await dimensions(page)).width).toBe(2400);
    await page.getByTestId('open-save').click();
    await page.getByTestId('save-confirm').click();
    await expect(page.getByTestId('save-status')).toContainText('changed in another tab or window');
    await expect(page.getByTestId('save-confirm')).toBeDisabled();
    await page.getByTestId('save-as-new').click();
    await expect(page.getByTestId('save-status')).toHaveText('Saved. The link opens this version.');
    await expect(page.getByTestId('save-as-new')).toBeHidden();
    const newLink = await page.getByTestId('share-link').inputValue();
    expect(newLink).not.toBe(link);

    // Each link opens its own version.
    const opened = async (url) => {
      const tab = await context.newPage();
      await tab.goto(url);
      await ready(tab);
      return dimensions(tab);
    };
    expect(await opened(link)).toEqual({ width: 2000, height: 2400, depth: 550 });
    expect(await opened(newLink)).toEqual({ width: 2400, height: 2400, depth: 600 });
  });
});

test.describe('a link that does not open', () => {
  test.use({ allowedConsoleErrors: [/status of 404/] });

  test('shows an honest error and the start screen', async ({ page }) => {
    await page.goto(`/#d=00000000-0000-4000-8000-000000000000.${'x'.repeat(43)}`);
    await expect(page.locator('#error-banner')).toHaveText(
      'This design link is not valid, or the design no longer exists. You can start a new design.',
    );
    await expect(page.getByTestId('start-screen')).toBeVisible();
  });
});
