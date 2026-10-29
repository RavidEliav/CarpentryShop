import AxeBuilder from '@axe-core/playwright';
import { expect, openDesigner, test } from './fixtures.js';

test.use({ keepDraft: true }); // these tests are about the draft surviving a reload

const LINK = /#d=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/;
const FOUND = /^Draft from \d{2}:\d{2} found\. Restore\?$/;
const state = (page) => page.evaluate(() => {
  const { design, revision } = window.__banai.store.getState();
  return { height: design.dimensions.height, depth: design.dimensions.depth, revision };
});
const setHeight = (page, height) => page.evaluate(
  (value) => window.__banai.store.dispatch([{ op: 'update_dimensions', height: value }]).ok,
  height,
);
const stored = (page) => page.evaluate(() => window.localStorage.getItem('banai.draft'));
const loaded = (page) => page.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));
const axe = async (page) => {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
};

async function saveFromDialog(page) {
  await page.getByTestId('open-save').click();
  await page.getByTestId('save-confirm').click();
  await expect(page.getByTestId('share-link')).toHaveValue(LINK);
  await page.getByTestId('save-close').click();
}

test.describe('automatic draft', () => {
  test('an edit survives a reload: the start screen offers it and Restore brings it back', async ({ page }) => {
    await openDesigner(page);
    expect(await setHeight(page, 2300)).toBe(true);
    expect(JSON.parse(await stored(page)).design.dimensions.height).toBe(2300);

    await page.reload();
    const card = page.getByTestId('draft-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading')).toHaveText('Continue your draft');
    await expect(card.locator('.draft-card__found')).toHaveText(FOUND);
    await expect(page.getByTestId('draft-restore')).toBeFocused(); // the first choice on the start screen
    await axe(page);

    await page.getByTestId('draft-restore').click();
    await expect(page.getByTestId('start-screen')).toHaveCount(0);
    await expect.poll(() => state(page)).toMatchObject({ height: 2300 });
    await expect(page.locator('#properties-panel')).toBeFocused();
  });

  test('Discard deletes the draft and leaves the usual start screen', async ({ page }) => {
    await openDesigner(page);
    await setHeight(page, 2300);
    await page.reload();
    await page.getByTestId('draft-discard').click();
    await expect(page.getByTestId('draft-card')).toHaveCount(0);
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByTestId('entry-guided')).toBeFocused();
    expect(await stored(page)).toBeNull();
    await page.getByTestId('entry-basic').click();
    expect((await state(page)).height).toBe(2400);
  });

  test('choosing a way in without restoring keeps the draft until the next edit replaces it', async ({ page }) => {
    await openDesigner(page);
    await setHeight(page, 2300);
    await page.reload();
    await page.getByTestId('entry-basic').click();
    expect((await state(page)).height).toBe(2400);
    expect(JSON.parse(await stored(page)).design.dimensions.height).toBe(2300);
    await setHeight(page, 2200);
    expect(JSON.parse(await stored(page)).design.dimensions.height).toBe(2200);
  });

  test('nothing is offered when nothing changed, and a broken draft is removed silently', async ({ page }) => {
    await openDesigner(page);
    await page.evaluate(() => window.__banai.store.select('shf_l1')); // selecting is not a change
    await page.reload();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByTestId('draft-card')).toHaveCount(0);

    await page.evaluate(() => window.localStorage.setItem('banai.draft', '{"v":1,"savedAt":1,"designId":null,"design":{"oops":true}}'));
    await page.reload();
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByTestId('draft-card')).toHaveCount(0);
    expect(await stored(page)).toBeNull();
  });

  test('unsaved edits to a saved link are offered for that link only', async ({ page }) => {
    await openDesigner(page);
    await setHeight(page, 2300);
    await saveFromDialog(page);
    const link = page.url();
    await page.reload(); // saved and unchanged: nothing to offer
    await loaded(page);
    await expect(page.getByTestId('draft-dialog')).toHaveCount(0);

    await setHeight(page, 2200); // not saved
    await page.reload();
    await loaded(page);
    const dialog = page.getByTestId('draft-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dialog__text')).toHaveText(FOUND);
    expect((await state(page)).height).toBe(2300); // the saved version, until the user decides
    await axe(page);
    await page.getByTestId('draft-restore').click();
    await expect(dialog).toHaveCount(0);
    expect((await state(page)).height).toBe(2200);
    await expect(page.locator('#properties-panel')).toBeFocused();

    // The draft belongs to that link: a new design does not offer it.
    await page.goto('/');
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await expect(page.getByTestId('draft-card')).toHaveCount(0);
    expect(new URL(link).hash).toMatch(LINK);
  });

  test('Discard on a link keeps the saved version and removes the draft', async ({ page }) => {
    await openDesigner(page);
    await saveFromDialog(page);
    await setHeight(page, 2100);
    await page.reload();
    await loaded(page);
    await page.getByTestId('draft-discard').click();
    await expect(page.getByTestId('draft-dialog')).toHaveCount(0);
    expect((await state(page)).height).toBe(2400);
    expect(await stored(page)).toBeNull();
  });
});
