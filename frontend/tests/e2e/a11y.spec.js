import AxeBuilder from '@axe-core/playwright';
import { test, expect, openDesigner, selection } from './fixtures.js';

// IS 5568 part 1 adopts WCAG at level AA.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function expectNoViolations(page) {
  // Let entrance animations (fades) finish, or axe measures half-transparent text.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})))); // a cancelled animation rejects; that is fine
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.any[0]?.message ?? ''}`).join(', ')}`);
  expect(summary, summary.join('\n')).toEqual([]);
}

test.describe('accessibility (axe, WCAG 2.1 AA)', () => {
  test('start screen', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('start-screen').waitFor();
    await expectNoViolations(page);
  });

  test('editor, with and without a selection', async ({ page }) => {
    await openDesigner(page);
    await expectNoViolations(page);
    await page.getByTestId('part-shf_l1').click();
    await page.getByTestId('selected-section').waitFor();
    await expectNoViolations(page);
  });

  for (const id of ['open-save', 'open-render', 'open-export', 'open-tour']) {
    test(`dialog ${id}`, async ({ page }) => {
      await openDesigner(page);
      await page.getByTestId(id).click();
      await page.locator('dialog[open]').waitFor();
      await expectNoViolations(page);
    });
  }

  test('accessibility statement page', async ({ page }) => {
    await page.goto('/accessibility.html');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('הצהרת נגישות');
    await expect(page.getByRole('link', { name: 's.jzouari@gmail.com' })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe('keyboard only', () => {
  test('a shelf can be selected without the mouse', async ({ page }) => {
    await openDesigner(page);
    const shelf = page.getByTestId('part-shf_l1');
    await shelf.focus();
    await page.keyboard.press('Enter');
    expect(await selection(page)).toEqual({ id: 'shf_l1', kind: 'shelf' });
    await expect(page.getByTestId('selected-section')).toContainText('Shelf');
    await expect(page.getByTestId('part-shf_l1')).toBeFocused(); // focus survives the re-render
  });

  test('choosing the basic wardrobe moves focus into the properties panel', async ({ page }) => {
    await openDesigner(page);
    await expect(page.locator('#properties-panel')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('dim-width')).toBeFocused();
  });

  test('the skip link moves focus to the properties panel', async ({ page }) => {
    await page.goto('/'); // a fresh load: the skip link is the first tab stop of the page
    await page.getByTestId('start-screen').waitFor();
    await page.evaluate(() => document.querySelector('[data-testid="start-screen"]').close());
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to properties' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Skip to properties' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#properties-panel')).toBeFocused();
    expect(new URL(page.url()).hash).toBe(''); // the hash is reserved for the private design link
  });
});

test.describe('form errors', () => {
  test('an invalid value is flagged and described, and a valid one clears it', async ({ page }) => {
    await openDesigner(page);
    const depth = page.getByTestId('dim-depth');
    await depth.fill('abc');
    await depth.press('Enter');
    await expect(depth).toHaveAttribute('aria-invalid', 'true');
    const messageId = await depth.getAttribute('aria-describedby');
    await expect(page.locator(`#${messageId}`)).not.toBeEmpty();
    await depth.fill('70');
    await depth.press('Enter');
    await expect(page.getByTestId('dim-depth')).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('dim-depth')).toHaveValue('70.0');
  });
});
