import { clickComponent, expect, openDesigner, selection, test } from './fixtures.js';

const designState = (page) => page.evaluate(() => {
  const { design, revision } = window.__banai.store.getState();
  return JSON.stringify({ design, revision });
});
const width = (page) => page.evaluate(() => window.__banai.store.getState().design.dimensions.width);

test.describe('display units (cm / mm / in)', () => {
  test.beforeEach(async ({ page }) => openDesigner(page));

  test('default is cm, and the selector shows which unit is on', async ({ page }) => {
    await expect(page.getByTestId('unit-cm')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('unit-mm')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('dim-width')).toHaveValue('200.0');
    await expect(page.getByText('W 200.0 cm', { exact: true })).toBeVisible();
  });

  test('the unit buttons are touch-sized and sit in one frame, not two', async ({ page }) => {
    for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 800 }]) {
      await page.setViewportSize(size);
      for (const unit of ['cm', 'mm', 'in']) {
        const box = await page.getByTestId(`unit-${unit}`).boundingBox();
        expect(box.height, `unit-${unit} height at ${size.width}px`).toBeGreaterThanOrEqual(44);
        expect(box.width, `unit-${unit} width at ${size.width}px`).toBeGreaterThanOrEqual(44);
      }
    }
    // The wrapper around the group carries no frame or padding of its own (that made a double border).
    const wrapper = await page.locator('#unit-selector').evaluate((node) => {
      const style = getComputedStyle(node);
      return { border: style.borderTopWidth, padding: style.paddingTop };
    });
    expect(wrapper).toEqual({ border: '0px', padding: '0px' });
    // The topbar still fits the 44px buttons without clipping them.
    const bar = await page.locator('.topbar').boundingBox();
    const button = await page.getByTestId('unit-cm').boundingBox();
    expect(button.y).toBeGreaterThanOrEqual(bar.y);
    expect(button.y + button.height).toBeLessThanOrEqual(bar.y + bar.height);
  });

  test('cmField and cm() still work for code that imports them', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const fields = await import('/src/editor/fields.js');
      const format = await import('/src/viewer/format.js');
      const node = fields.cmField({ label: 'Width', mm: 2000, testId: 'legacy', onCommit: () => ({ ok: true }) });
      return {
        value: node.querySelector('input').value,
        suffix: node.querySelector('.field__suffix').textContent,
        cm: format.cm(643),
      };
    });
    expect(result).toEqual({ value: '200.0', suffix: 'cm', cm: '64.3' });
  });

  test('switching to mm and inches updates fields, suffixes and the 3D labels', async ({ page }) => {
    await page.getByTestId('unit-mm').click();
    await expect(page.getByTestId('unit-mm')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dim-width')).toHaveValue('2000');
    await expect(page.getByTestId('dim-height')).toHaveValue('2400');
    await expect(page.locator('#properties-panel .field__suffix').first()).toHaveText('mm');
    await expect(page.getByText('W 2000 mm', { exact: true })).toBeVisible();
    await expect(page.getByText('D 600 mm', { exact: true })).toBeVisible();

    await page.getByTestId('unit-in').click();
    await expect(page.getByTestId('dim-width')).toHaveValue('78.74');
    await expect(page.locator('#properties-panel .field__suffix').first()).toHaveText('in');
    await expect(page.getByText('W 78.74 in', { exact: true })).toBeVisible();
    await expect(page.getByText('H 94.49 in', { exact: true })).toBeVisible();

    await page.getByTestId('unit-cm').click();
    await expect(page.getByTestId('dim-width')).toHaveValue('200.0');
  });

  test('switching units never changes the design, revision or selection', async ({ page }) => {
    await clickComponent(page, 'shf_l1');
    const selected = await selection(page);
    const before = await designState(page);
    for (const unit of ['unit-mm', 'unit-in', 'unit-cm']) await page.getByTestId(unit).click();
    expect(await designState(page)).toBe(before);
    expect(await selection(page)).toEqual(selected);
  });

  test('a value typed in inches becomes the equivalent integer millimetres', async ({ page }) => {
    await page.getByTestId('unit-in').click();
    const input = page.getByTestId('dim-width');
    await input.fill('82');
    await input.press('Enter');
    expect(await width(page)).toBe(2083); // 82 in = 2082.8 mm, rounded to an integer
    await expect(input).toHaveValue('82.01'); // shown again in inches (2083 mm)
    await expect(page.getByText('W 82.01 in', { exact: true })).toBeVisible();

    await input.fill('78 3/4');
    await input.press('Enter');
    expect(await width(page)).toBe(2000); // 78.75 in = 2000.25 mm
    expect(Number.isInteger(await width(page))).toBe(true);
  });

  test('a value typed in mm is stored as is, and bad input is refused with the unit named', async ({ page }) => {
    await page.getByTestId('unit-mm').click();
    const input = page.getByTestId('dim-width');
    await input.fill('2100');
    await input.press('Enter');
    expect(await width(page)).toBe(2100);
    await input.fill('abc');
    await input.press('Enter');
    await expect(page.locator('#properties-panel .field__message').first()).toContainText('mm');
    expect(await width(page)).toBe(2100);
  });

  test('the selection label follows the unit', async ({ page }) => {
    await page.evaluate(() => window.__banai.store.select('shf_l1'));
    await page.getByTestId('unit-mm').click();
    await expect(page.locator('.dim-label--selected')).toContainText('mm from base');
    await page.getByTestId('unit-in').click();
    await expect(page.locator('.dim-label--selected')).toContainText(' in from base');
  });

  test('the choice is remembered after a reload', async ({ page }) => {
    await page.getByTestId('unit-in').click();
    await page.reload();
    await page.getByTestId('entry-basic').click();
    await page.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));
    await expect(page.getByTestId('unit-in')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('dim-width')).toHaveValue('78.74');
  });
});
