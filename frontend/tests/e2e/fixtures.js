import { test as base, expect } from '@playwright/test';

// Every E2E test fails on uncaught page errors or console errors. A test that provokes an
// expected HTTP error can allow exactly that console line via `test.use({ allowedConsoleErrors })`.
// The first-visit tour is marked as seen unless a spec opts in with `test.use({ seenTour: false })`.
// Every page load starts without a saved draft unless a spec opts in with `test.use({ keepDraft: true })`.
export const test = base.extend({
  allowedConsoleErrors: [[], { option: true }],
  seenTour: [true, { option: true }],
  keepDraft: [false, { option: true }],
  page: async ({ page, allowedConsoleErrors, seenTour, keepDraft }, use) => {
    if (seenTour) await page.addInitScript(() => window.localStorage.setItem('banai.tour.seen', '1'));
    if (!keepDraft) await page.context().addInitScript(() => window.localStorage.removeItem('banai.draft'));
    const problems = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (allowedConsoleErrors.some((pattern) => pattern.test(message.text()))) return;
      problems.push(`console: ${message.text()}`);
    });
    await use(page);
    expect(problems, problems.join('\n')).toEqual([]);
  },
});

export { expect };

export async function openDesigner(page) {
  await page.goto('/');
  // The start screen is modal: choose the basic wardrobe to reach the editor.
  await page.getByTestId('entry-basic').click();
  await page.waitForFunction(() => window.__banai?.viewer.meshOf('shf_l1'));
}

export const selection = (page) => page.evaluate(() => window.__banai.store.getState().selection);

export async function clickComponent(page, componentId) {
  await page.waitForFunction(() => {
    const { camera } = window.__banai.viewer;
    const key = camera.position.toArray().map((v) => v.toFixed(5)).join();
    const settled = window.__lastCameraKey === key;
    window.__lastCameraKey = key;
    return settled;
  }, null, { polling: 100 });
  const point = await page.evaluate((id) => window.__banai.viewer.screenPointOf(id), componentId);
  await page.mouse.click(point.x, point.y);
}

/** Share of canvas pixels that differ from the background colour. */
export const paintedRatio = (page) => page.evaluate(() => {
  const source = document.querySelector('#viewer canvas');
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext('2d');
  context.drawImage(source, 0, 0);
  const { data } = context.getImageData(0, 0, copy.width, copy.height);
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - 236) + Math.abs(data[i + 1] - 238) + Math.abs(data[i + 2] - 236) > 12) painted += 1;
  }
  return painted / (data.length / 4);
});
