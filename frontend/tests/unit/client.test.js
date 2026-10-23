import { describe, expect, it, vi } from 'vitest';
import {
  ApiError, applyProposal, createSavedDesign, exportPdf, getCatalog, getDefaultDesign, getHealth, getSavedDesign, sendChat,
  updateSavedDesign,
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

describe('exportPdf', () => {
  const pdfResponse = (headers) => vi.fn().mockResolvedValue({
    ok: true, status: 200, headers: new Headers(headers), blob: async () => new Blob(['%PDF-1.7']),
  });

  it('posts only design and language and returns the blob with its filename', async () => {
    const fetchImpl = pdfResponse({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="banai-wardrobe-2400x2400x600mm.pdf"' });
    const result = await exportPdf({ design: { a: 1 }, language: 'en' }, fetchImpl);
    expect(result.filename).toBe('banai-wardrobe-2400x2400x600mm.pdf');
    expect(await result.blob.text()).toBe('%PDF-1.7');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/export/pdf');
    expect(JSON.parse(init.body)).toEqual({ design: { a: 1 }, language: 'en' });
  });

  it('sends the 3D snapshot only when there is one', async () => {
    const fetchImpl = pdfResponse({ 'Content-Type': 'application/pdf' });
    await exportPdf({ design: { a: 1 }, language: 'he', image: 'data:image/jpeg;base64,AAAA' }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ design: { a: 1 }, language: 'he', image: 'data:image/jpeg;base64,AAAA' });
    await exportPdf({ design: { a: 1 }, language: 'he', image: null }, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ design: { a: 1 }, language: 'he' });
  });

  it('falls back to a default filename when it is missing or unsafe', async () => {
    const missing = await exportPdf({}, pdfResponse({ 'Content-Type': 'application/pdf' }));
    expect(missing.filename).toBe('banai-wardrobe.pdf');
    const unsafe = await exportPdf({}, pdfResponse({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="../evil.pdf"' }));
    expect(unsafe.filename).toBe('banai-wardrobe.pdf');
  });

  it('throws the server error code and message on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 422, json: async () => ({ success: false, error: { code: 'INVALID_DESIGN', message: 'Bad design' } }),
    });
    const error = await exportPdf({}, fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'INVALID_DESIGN', message: 'Bad design' });
  });

  it('rejects a 200 that is not a PDF', async () => {
    await expect(exportPdf({}, pdfResponse({ 'Content-Type': 'text/html' }))).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
});

describe('saved designs api', () => {
  const designId = '0b6f2a52-3c1e-4c8e-9a51-1f6f3f2b7d10';

  it('creates a saved design with a JSON POST', async () => {
    const fetchImpl = okResponse({ success: true, data: { designId, accessToken: 't', revision: 1 } });
    await expect(createSavedDesign({ design: {}, language: 'he' }, fetchImpl))
      .resolves.toEqual({ designId, accessToken: 't', revision: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/designs');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ design: {}, language: 'he' });
  });

  it('reopens with the token as a bearer header, never in the URL', async () => {
    const fetchImpl = okResponse({ success: true, data: { designId, design: {}, revision: 3 } });
    await getSavedDesign({ designId, token: 'secret', language: 'en' }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`http://localhost:8000/api/designs/${designId}?language=en`);
    expect(url).not.toContain('secret');
    expect(init.headers).toEqual({ Authorization: 'Bearer secret' });
  });

  it('saves over a design with PUT and If-Match, and surfaces 409 STALE', async () => {
    const stale = vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ success: false, error: { code: 'STALE', message: 'saved elsewhere' } }),
    });
    const payload = { designId, token: 'secret', revision: 2, design: { a: 1 }, language: 'he' };
    await expect(updateSavedDesign(payload, stale)).rejects.toMatchObject({ status: 409, code: 'STALE' });
    const [url, init] = stale.mock.calls[0];
    expect(url).toBe(`http://localhost:8000/api/designs/${designId}`);
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret', 'If-Match': '2' });
    expect(JSON.parse(init.body)).toEqual({ design: { a: 1 }, language: 'he' });
  });
});
