import { clickComponent, expect, openDesigner, selection, test } from './fixtures.js';

test.use({ seenTour: false }); // a first visit: nothing remembered in this browser yet

const tour = (page) => page.getByTestId('tour');
const seen = (page) => page.evaluate(() => window.localStorage.getItem('banai.tour.seen'));

test.describe('first-visit introduction tour', () => {
  test('appears after the start screen and walks the chat, the editor and the 3D view', async ({ page }) => {
    await openDesigner(page);
    await expect(tour(page)).toBeVisible();
    expect(await seen(page)).toBeNull(); // only remembered once it ends

    // Default chat language is Hebrew: the tour follows it, right to left.
    await expect(tour(page)).toHaveAttribute('dir', 'rtl');
    await expect(tour(page)).toHaveAttribute('lang', 'he');
    await expect(page.getByTestId('tour-progress')).toHaveText('1 מתוך 3');
    await expect(tour(page).getByRole('heading')).toHaveText('כאן מדברים עם המעצב');
    await expect(tour(page)).toHaveAttribute('data-step', 'chat');
    await expect(page.getByTestId('tour-back')).toBeHidden();
    await expect(page.getByTestId('tour-next')).toBeFocused();

    await page.getByTestId('tour-next').click();
    await expect(tour(page)).toHaveAttribute('data-step', 'editor');
    await expect(page.getByTestId('tour-progress')).toHaveText('2 מתוך 3');
    await expect(tour(page).getByRole('heading')).toHaveText('כאן עורכים ידנית');
    await page.getByTestId('tour-back').click();
    await expect(tour(page)).toHaveAttribute('data-step', 'chat');
    await page.getByTestId('tour-next').click();
    await page.getByTestId('tour-next').click();
    await expect(tour(page)).toHaveAttribute('data-step', 'viewer');
    await expect(tour(page).getByRole('heading')).toHaveText('כאן מסובבים את הארון');
    await expect(page.getByTestId('tour-next')).toHaveText('סיום');
    await expect(page.getByTestId('tour-skip')).toBeHidden();

    await page.getByTestId('tour-next').click();
    await expect(tour(page)).toBeHidden();
    expect(await seen(page)).toBe('1');
    await expect(page.locator('#properties-panel')).toBeFocused(); // focus back where the start screen left it
    await expect(page.getByTestId('open-tour')).toHaveAccessibleName('סיור היכרות');

    await page.reload();
    await page.getByTestId('entry-basic').click();
    await page.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));
    await expect(tour(page)).toBeHidden(); // shown once only
  });

  test('the bubble sits beside its target and the ring outlines it', async ({ page }) => {
    await openDesigner(page);
    const box = async (locator) => locator.boundingBox();
    const chat = await box(page.locator('#chat-panel'));
    const bubble = await box(page.locator('.tour__bubble'));
    expect(bubble.x).toBeGreaterThanOrEqual(chat.x + chat.width); // right of the chat panel
    await page.getByTestId('tour-next').click();
    const editor = await box(page.locator('#properties-panel'));
    await expect.poll(async () => (await box(page.locator('.tour__ring'))).x).toBeCloseTo(editor.x - 4, 0);
    const editorBubble = await box(page.locator('.tour__bubble'));
    expect(editorBubble.x + editorBubble.width).toBeLessThanOrEqual(editor.x); // left of the editor
  });

  test('Skip and Esc close it, remember it, and keep focus in the page', async ({ page }) => {
    await openDesigner(page);
    await page.getByTestId('tour-skip').click();
    await expect(tour(page)).toBeHidden();
    expect(await seen(page)).toBe('1');
    await expect(page.locator('#properties-panel')).toBeFocused();

    await page.evaluate(() => window.localStorage.removeItem('banai.tour.seen'));
    await page.reload();
    await page.getByTestId('entry-freeText').click();
    await expect(tour(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeHidden();
    expect(await seen(page)).toBe('1');
    await expect(page.getByTestId('chat-input')).toBeFocused(); // "Describe it" put focus in the composer
  });

  test('the "?" button replays it in the chat language, and focus returns to the button', async ({ page }) => {
    await openDesigner(page);
    await page.getByTestId('tour-skip').click();
    await page.getByTestId('chat-language-en').click();
    const replay = page.getByTestId('open-tour');
    await expect(replay).toHaveAccessibleName('Take the tour');
    await replay.click();
    await expect(tour(page)).toBeVisible();
    await expect(tour(page)).toHaveAttribute('dir', 'ltr');
    await expect(page.getByTestId('tour-progress')).toHaveText('1 of 3');
    await expect(tour(page).getByRole('heading')).toHaveText('Talk to the designer here');
    await page.keyboard.press('Shift+Tab'); // the page behind the modal is inert: focus stays in the tour
    await expect(page.getByTestId('tour-skip')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tour(page)).toBeHidden();
    await expect(replay).toBeFocused();
  });

  test('after the tour the editor and the 3D view work as usual, and the design is untouched', async ({ page }) => {
    await openDesigner(page);
    const before = await page.evaluate(() => JSON.stringify(window.__banai.store.getState().design));
    await page.getByTestId('tour-skip').click();
    await page.getByLabel('Show interior').check();
    await clickComponent(page, 'shf_l2');
    expect(await selection(page)).toEqual({ id: 'shf_l2', kind: 'shelf' });
    expect(await page.evaluate(() => JSON.stringify(window.__banai.store.getState().design))).toBe(before);
  });
});
