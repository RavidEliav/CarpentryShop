import { expect, openDesigner, test } from './fixtures.js';

// Chatting to a finished design ends with Generate Style Profile: after a confirmed change, or when
// the customer says they are done. One pinned note, never repeated, opening the carpenter PDF dialog.

const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const dims = (page) => page.evaluate(() => window.__banai.store.getState().design.dimensions);

async function mockAgent(page, reply) {
  await page.route('**/api/health', (route) => route.fulfill(ok({ status: 'ok', env: 'e2e', agent: true })));
  await page.route('**/api/chat', (route) => route.fulfill(ok(reply(route.request().postDataJSON()))));
}

test('a confirmed change from the chat offers the PDF step once, which downloads the PDF', async ({ page }) => {
  await mockAgent(page, (body) => ({
    reply: 'Here is my proposal.', replySignature: 'c'.repeat(64), offerProfile: false,
    proposal: {
      proposalId: 'prp_0123456789abcdef', baseRevision: body.revision, baseHash: 'a'.repeat(64),
      ops: [{ op: 'update_dimensions', width: 2400 }], signature: 'b'.repeat(64),
      summary: 'Wider wardrobe.', changes: [{ title: 'Width', detail: '200 cm to 240 cm' }],
    },
  }));
  await page.route('**/api/proposals/apply', (route) => {
    const body = route.request().postDataJSON();
    const design = structuredClone(body.design);
    design.dimensions.width = 2400;
    design.compartments[2].width += 400;
    return route.fulfill(ok({ design, revision: body.revision + 1 }));
  });
  await openDesigner(page);
  await expect(page.getByTestId('chat-export')).toHaveCount(0);
  for (let round = 0; round < 2; round += 1) {
    await page.getByTestId('chat-input').fill('Make it 240 cm wide');
    await page.getByTestId('chat-send').click();
    await page.getByTestId('proposal-confirm').click();
    await expect(page.getByTestId('proposal-card')).toHaveCount(0);
  }
  await expect.poll(() => dims(page)).toEqual({ width: 2400, height: 2400, depth: 600 });
  await expect(page.getByTestId('profile-note')).toHaveCount(1); // no spam after two changes
  await page.getByTestId('chat-export').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-download').click();
  expect((await download).suggestedFilename()).toBe('banai-wardrobe-2400x2400x600mm.pdf');
});

test('saying "I\'m done" makes the agent offer the PDF step without changing anything', async ({ page }) => {
  await mockAgent(page, () => ({
    reply: 'Great! You can download the file for your carpenter.', replySignature: 'c'.repeat(64),
    proposal: null, offerProfile: true,
  }));
  await openDesigner(page);
  const revision = await page.evaluate(() => window.__banai.store.getState().revision);
  await page.getByTestId('chat-input').fill("I'm done, I want the file for the carpenter");
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-export')).toBeVisible();
  await expect(page.getByTestId('chat-export')).toHaveCount(1);
  expect(await page.evaluate(() => window.__banai.store.getState().revision)).toBe(revision);
});
