import { expect, openDesigner, test } from './fixtures.js';

// New catalog colours and material, from the editor and from the agent, down to the 3D view.

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const OLIVE = '6b6f45';
const OLIVE_CARCASS = { op: 'set_material', target: 'carcass', color: { catalogId: 'olive_green' } };

const carcassColor = (page) => page.evaluate(() => window.__banai.store.getState().design.carcass.appearance.color);
const carcassHex = (page) => page.evaluate(() => window.__banai.viewer.meshOf('carcass').material.color.getHexString());

test.describe('catalog: olive green, terracotta, solid oak', () => {
  test('choosing olive green in the editor repaints the wardrobe in 3D', async ({ page }) => {
    await openDesigner(page);
    for (const name of ['Olive green', 'Terracotta']) await expect(page.getByRole('button', { name, exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Olive green', exact: true }).first().click();
    expect(await carcassColor(page)).toEqual({ catalogId: 'olive_green' });
    await expect.poll(() => carcassHex(page)).toBe(OLIVE);
  });

  test('solid oak is offered as a material and can be chosen', async ({ page }) => {
    await openDesigner(page);
    const material = page.getByLabel('Material').first();
    await material.selectOption('solid_oak');
    await expect.poll(() => page.evaluate(() => window.__banai.store.getState().design.carcass.appearance.material)).toEqual({ catalogId: 'solid_oak' });
  });

  test('"תצבע בירוק זית" through the agent: Confirm paints the wardrobe olive', async ({ page }) => {
    const calls = [];
    await page.route('**/api/health', (route) => route.fulfill(ok({ status: 'ok', env: 'e2e', agent: true })));
    await page.route('**/api/chat', async (route) => {
      const body = route.request().postDataJSON();
      calls.push(body);
      await route.fulfill(ok({
        reply: 'הנה ההצעה שלי.',
        proposal: {
          proposalId: 'prp_0123456789abcdef', baseRevision: body.revision, baseHash: 'a'.repeat(64),
          ops: [OLIVE_CARCASS], signature: 'b'.repeat(64),
          summary: 'צביעת הגוף בירוק זית.', changes: [{ title: 'צבע', detail: 'לבן לירוק זית' }],
        },
      }));
    });
    await page.route('**/api/proposals/apply', async (route) => {
      const body = route.request().postDataJSON();
      const design = structuredClone(body.design);
      design.carcass.appearance.color = { catalogId: 'olive_green' };
      await route.fulfill(ok({ design, revision: body.revision + 1 }));
    });
    await openDesigner(page);

    await page.getByTestId('chat-input').fill('תצבע בירוק זית');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('proposal-card')).toContainText('ירוק זית');
    expect(calls[0].messages).toEqual([{ role: 'user', text: 'תצבע בירוק זית' }]);
    expect(await carcassColor(page)).toEqual({ catalogId: 'white' }); // nothing applied before Confirm

    await page.getByTestId('proposal-confirm').click();
    await expect.poll(() => carcassColor(page)).toEqual({ catalogId: 'olive_green' });
    await expect.poll(() => carcassHex(page)).toBe(OLIVE);
  });
});
