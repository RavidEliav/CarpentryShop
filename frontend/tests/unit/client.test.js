import { describe, expect, it, vi } from 'vitest';
import {
  ApiError, applyProposal, createDesign, getCatalog, getDefaultDesign, getHealth, loadDesign, sendChat, updateDesign,
} from '../../src/api/client.js';

const okResponse = (body) => vi.fn().mockResolvedValue({ ok: true, json: async () => body });

describe('api client', () => {
  it('returns the health payload', async () => {
    const fetchImpl = okResponse({ success: true, data: { status: 'ok' } });
    await expect(getHealth(fetchImpl)).resolves.toEqual({ success: true, data: { status: 'ok' } });
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:8000/api/health');
  });

  it('unwraps the envelope for catalog and default design', async () => {
    await expect(getCatalog(okResponse({ success: true, data: { colors: [] } }))).resolves.toEqual({ colors: [] });
    await expect(getDefaultDesign(okResponse({ success: true, data: { design: {}, revision: 1 } })))
      .resolves.toEqual({ design: {}, revision: 1 });
  });

  it('throws on HTTP errors and unsuccessful envelopes', async () => {
    await expect(getCatalog(vi.fn().mockResolvedValue({ ok: false, status: 503 }))).rejects.toThrow('503');
    await expect(getCatalog(okResponse({ success: false, error: 'x' }))).rejects.toThrow('unsuccessful');
  });
});

describe('agent api', () => {
  it('posts chat turns as JSON and unwraps the reply', async () => {
    const fetchImpl = okResponse({ success: true, data: { reply: 'hi', proposal: null } });
    const payload = { messages: [{ role: 'user', text: 'hello' }], design: {}, revision: 1 };
    await expect(sendChat(payload, fetchImpl)).resolves.toEqual({ reply: 'hi', proposal: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('surfaces the server error code and status (e.g. a stale proposal)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ success: false, error: { code: 'STALE', message: 'Design changed' } }),
    });
    const error = await applyProposal({}, fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'STALE', message: 'Design changed' });
  });

  it('reports network failures as status 0', async () => {
    const error = await sendChat({}, vi.fn().mockRejectedValue(new TypeError('offline'))).catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
});

describe('saved designs api', () => {
  const link = { designId: '3f1c2b4a-1111-4222-8333-444455556666', token: 'x'.repeat(43) };

  it('creates a design with a JSON POST', async () => {
    const fetchImpl = okResponse({ success: true, data: { designId: link.designId, accessToken: link.token, revision: 1 } });
    await expect(createDesign({ width: 1 }, fetchImpl)).resolves.toEqual({ designId: link.designId, accessToken: link.token, revision: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/designs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ design: { width: 1 } });
  });

  it('opens a design with the token as a bearer key, never in the URL', async () => {
    const fetchImpl = okResponse({ success: true, data: { design: {}, revision: 3 } });
    await expect(loadDesign(link, fetchImpl)).resolves.toEqual({ design: {}, revision: 3 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`http://localhost:8000/api/designs/${link.designId}`);
    expect(url).not.toContain(link.token);
    expect(init.headers).toEqual({ Authorization: `Bearer ${link.token}` });
    expect(init.cache).toBe('no-store');
  });

  it('saves changes with a PUT conditioned on the revision', async () => {
    const fetchImpl = okResponse({ success: true, data: { revision: 4 } });
    await expect(updateDesign(link, 3, { width: 2 }, fetchImpl)).resolves.toEqual({ revision: 4 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`http://localhost:8000/api/designs/${link.designId}`);
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${link.token}`, 'If-Match': '"3"' });
    expect(JSON.parse(init.body)).toEqual({ design: { width: 2 } });
  });

  it('encodes the design id into the path', async () => {
    const fetchImpl = okResponse({ success: true, data: {} });
    await loadDesign({ designId: '../catalog?x=1', token: link.token }, fetchImpl);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:8000/api/designs/..%2Fcatalog%3Fx%3D1');
  });
});
