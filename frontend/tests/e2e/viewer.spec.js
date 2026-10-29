import { clickComponent, expect, openDesigner, paintedRatio, selection, test } from './fixtures.js';

test.describe('Phase 3: 3D viewer', () => {
  test.beforeEach(async ({ page }) => openDesigner(page));

  test('renders the basic wardrobe with overall dimension labels', async ({ page }) => {
    await expect.poll(() => paintedRatio(page)).toBeGreaterThan(0.05);
    await expect(page.getByText('W 200.0 cm', { exact: true })).toBeVisible();
    await expect(page.getByText('H 240.0 cm', { exact: true })).toBeVisible();
    await expect(page.getByText('D 60.0 cm', { exact: true })).toBeVisible();
  });

  test('orbit drag rotates the camera', async ({ page }) => {
    const before = await page.evaluate(() => window.__banai.viewer.camera.position.toArray());
    const box = await page.locator('#viewer canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 40, { steps: 10 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.__banai.viewer.camera.position.toArray());
    expect(after).not.toEqual(before);
  });

  test('doors are shown by default and "Show interior" hides them', async ({ page }) => {
    expect(await page.evaluate(() => Boolean(window.__banai.viewer.meshOf('dr_left')))).toBe(true);
    await page.getByLabel('Show interior').check();
    await expect.poll(() => page.evaluate(() => Boolean(window.__banai.viewer.meshOf('dr_left')))).toBe(false);
  });

  test('clicking a shelf selects it, highlights it and shows its dimensions', async ({ page }) => {
    await page.getByLabel('Show interior').check();
    await clickComponent(page, 'shf_l2');
    expect(await selection(page)).toEqual({ id: 'shf_l2', kind: 'shelf' });
    await expect(page.getByTestId('selected-section')).toContainText('Selected · Shelf');
    await expect(page.locator('.dim-label--selected')).toHaveText('Shelf · 80.0 cm from base · 1.8 cm thick');
  });

  test('clicking a door selects the door; clicking empty space clears the selection', async ({ page }) => {
    await clickComponent(page, 'dr_middle');
    expect(await selection(page)).toEqual({ id: 'dr_middle', kind: 'door' });
    const box = await page.locator('#viewer canvas').boundingBox();
    await page.mouse.click(box.x + 10, box.y + 10);
    expect(await selection(page)).toBeNull();
  });

  test('the view updates automatically when the committed state changes', async ({ page }) => {
    const y0 = await page.evaluate(() => window.__banai.viewer.meshOf('shf_l1').position.y);
    const result = await page.evaluate(() => window.__banai.store.dispatch([{ op: 'modify_shelf', id: 'shf_l1', y: 1000 }]));
    expect(result.ok).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__banai.viewer.meshOf('shf_l1').position.y)).toBeGreaterThan(y0 + 0.5);
  });

  test('picking works in the same tick as a scene rebuild (before any frame is rendered)', async ({ page }) => {
    const selected = await page.evaluate(() => {
      const { store, viewer } = window.__banai;
      store.setDoorsVisible(false); // rebuilds the scene; its meshes have not been rendered yet
      // Synthetic events have no real pointer to capture (OrbitControls would throw).
      viewer.canvas.setPointerCapture = () => {};
      viewer.canvas.releasePointerCapture = () => {};
      const { x, y } = viewer.screenPointOf('shf_r1');
      const fire = (type) => viewer.canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, buttons: type === 'pointerdown' ? 1 : 0 }));
      fire('pointerdown');
      fire('pointerup');
      return store.getState().selection?.id ?? null;
    });
    expect(selected).toBe('shf_r1');
  });
});

test.describe('camera focus', () => {
  const targetX = (page) => page.evaluate(() => window.__banai.viewer.controls.target.x);
  const settled = async (page) => {
    await page.waitForTimeout(700);
    return targetX(page);
  };

  test('selecting a compartment centres the camera on it, double-click on empty space returns to the overview', async ({ page }) => {
    await openDesigner(page);
    const overview = await targetX(page);
    const before = await page.evaluate(() => JSON.stringify(window.__banai.store.getState().design));
    await page.evaluate(() => window.__banai.store.select('cmp_right'));
    const right = await settled(page);
    expect(right).toBeGreaterThan(overview + 0.3);
    await page.evaluate(() => window.__banai.store.select('cmp_left'));
    expect(await settled(page)).toBeLessThan(overview - 0.3);
    // the camera is not part of the design
    expect(await page.evaluate(() => JSON.stringify(window.__banai.store.getState().design))).toBe(before);

    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.dblclick(box.x + 10, box.y + 10);
    expect(await settled(page)).toBeCloseTo(overview, 3);
  });

  test('selecting a shelf leaves the camera alone; the middle compartment is already centred', async ({ page }) => {
    await openDesigner(page);
    const overview = await targetX(page);
    await page.evaluate(() => window.__banai.store.select('shf_l2'));
    expect(await settled(page)).toBeCloseTo(overview, 3);
    await page.evaluate(() => window.__banai.store.select('cmp_middle'));
    expect(await settled(page)).toBeCloseTo(overview, 1); // the middle compartment is at the centre
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('the camera jumps instead of gliding', async ({ page }) => {
      await openDesigner(page);
      const overview = await targetX(page);
      await page.evaluate(() => window.__banai.store.select('cmp_right'));
      expect(await targetX(page)).toBeGreaterThan(overview + 0.3); // no waiting: already there
    });
  });
});
