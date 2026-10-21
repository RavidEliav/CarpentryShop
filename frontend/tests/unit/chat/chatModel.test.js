import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ERROR_MESSAGE, createChatModel, MAX_MESSAGE_LENGTH, NOT_CONNECTED_MESSAGE, proposalStatus, SUGGESTIONS,
} from '../../../src/chat/chatModel.js';
import { STRINGS } from '../../../src/chat/i18n.js';

const proposal = (baseRevision = 1) => ({
  id: 'p1',
  baseRevision,
  summary: 'Widen the wardrobe',
  changes: [{ title: 'Width', detail: '200 cm to 240 cm' }],
});

describe('proposalStatus', () => {
  it('is null without a proposal, pending at the same revision, stale after any change', () => {
    expect(proposalStatus(null, 1)).toBeNull();
    expect(proposalStatus(proposal(1), 1)).toBe('pending');
    expect(proposalStatus(proposal(1), 2)).toBe('stale');
  });
});

describe('chat model', () => {
  it('adds the customer message and an honest not-connected reply, and never an assistant answer', () => {
    const model = createChatModel({ getRevision: () => 1 });
    expect(model.send('  240 cm wide  ')).toEqual({ ok: true });
    const messages = model.getMessages();
    expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(messages[0].text).toBe('240 cm wide');
    expect(messages[1].text).toBe(NOT_CONNECTED_MESSAGE);
    expect(model.getProposal()).toBeNull();
  });

  it('rejects empty and over-long messages without adding anything', () => {
    const model = createChatModel({ getRevision: () => 1 });
    expect(model.send('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(model.send(undefined).ok).toBe(false);
    expect(model.send('x'.repeat(MAX_MESSAGE_LENGTH + 1))).toEqual({ ok: false, reason: 'too-long' });
    expect(model.getMessages()).toEqual([]);
  });

  it('gives each message a unique id and notifies subscribers', () => {
    const model = createChatModel({ getRevision: () => 1 });
    let calls = 0;
    const off = model.subscribe(() => { calls += 1; });
    model.send('one');
    model.send('two');
    expect(new Set(model.getMessages().map((m) => m.id)).size).toBe(4);
    expect(calls).toBe(2);
    off();
    model.send('three');
    expect(calls).toBe(2);
  });

  it('marks a pending proposal stale when the revision moves on', () => {
    let revision = 1;
    const model = createChatModel({ getRevision: () => revision });
    model.setProposal(proposal(1));
    expect(model.getProposalStatus()).toBe('pending');
    revision = 2;
    expect(model.getProposalStatus()).toBe('stale');
  });

  it('cancel drops the proposal, leaves a note, and reports false when there is nothing to cancel', () => {
    const model = createChatModel({ getRevision: () => 1 });
    expect(model.cancelProposal()).toBe(false);
    model.setProposal(proposal());
    expect(model.cancelProposal()).toBe(true);
    expect(model.getProposal()).toBeNull();
    expect(model.getMessages().at(-1).text).toMatch(/לא בוצע שום שינוי/);
  });

  it('resolveProposal clears the proposal and optionally posts a message', () => {
    const model = createChatModel({ getRevision: () => 1 });
    model.setProposal(proposal());
    model.resolveProposal('Applied.');
    expect(model.getProposal()).toBeNull();
    expect(model.getMessages().at(-1).text).toBe('Applied.');
    model.setProposal(proposal());
    model.resolveProposal();
    expect(model.getMessages()).toHaveLength(1);
  });
});

describe('suggestions', () => {
  it('offers a few short, immutable starter prompts that fit the message limit', () => {
    expect(SUGGESTIONS.length).toBeGreaterThanOrEqual(3);
    expect(Object.isFrozen(SUGGESTIONS)).toBe(true);
    SUGGESTIONS.forEach((text) => {
      expect(text.trim()).toBe(text);
      expect(text.length).toBeLessThan(MAX_MESSAGE_LENGTH);
    });
    expect(new Set(SUGGESTIONS).size).toBe(SUGGESTIONS.length);
  });
});

describe('chat model with a connected agent', () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const signed = { proposalId: 'prp_0123456789abcdef', baseRevision: 3, summary: 'Adds a shelf', changes: [{ title: 'Shelf', detail: '100 cm' }], ops: [], signature: 'x' };

  it('sends the dialogue history, shows a busy state, then the reply and the proposal', async () => {
    const pending = deferred();
    const agent = vi.fn(() => pending.promise);
    const model = createChatModel({ getRevision: () => 3, agent });
    expect(model.isConnected()).toBe(true);
    expect(model.send('add a shelf')).toEqual({ ok: true });
    expect(model.isBusy()).toBe(true);
    expect(model.send('another')).toEqual({ ok: false, reason: 'busy' });
    expect(agent).toHaveBeenCalledWith({ messages: [{ role: 'user', text: 'add a shelf' }], language: 'he' });
    pending.resolve({ reply: 'Here you go', proposal: signed });
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
    expect(model.getMessages().map((m) => [m.role, m.text])).toEqual([['user', 'add a shelf'], ['assistant', 'Here you go']]);
    expect(model.getProposal()).toEqual({ id: signed.proposalId, baseRevision: 3, summary: 'Adds a shelf', changes: signed.changes, language: 'he', signed });
    expect(model.getProposalStatus()).toBe('pending');
  });

  it('keeps system notes out of the history sent to the agent', async () => {
    const agent = vi.fn(async () => ({ reply: 'ok', proposal: signed }));
    const model = createChatModel({ getRevision: () => 3, agent });
    model.send('first');
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
    model.cancelProposal();
    model.send('second');
    await vi.waitFor(() => expect(agent).toHaveBeenCalledTimes(2));
    expect(agent.mock.calls[1][0].messages).toEqual([
      { role: 'user', text: 'first' }, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'second' },
    ]);
  });

  it('shows a friendly note when the agent fails, and recovers', async () => {
    const agent = vi.fn().mockRejectedValueOnce(new TypeError('boom')).mockResolvedValueOnce({ reply: 'back', proposal: null });
    const model = createChatModel({ getRevision: () => 1, agent });
    model.send('hi');
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
    expect(model.getMessages().at(-1)).toMatchObject({ role: 'system', text: AGENT_ERROR_MESSAGE });
    model.send('again');
    await vi.waitFor(() => expect(model.getMessages().at(-1)).toMatchObject({ role: 'assistant', text: 'back' }));
  });

  it('a new message drops an unconfirmed proposal', async () => {
    const agent = vi.fn(async () => ({ reply: 'ok', proposal: null }));
    const model = createChatModel({ getRevision: () => 3, agent });
    model.setProposal({ id: 'p', baseRevision: 3, summary: '', changes: [] });
    model.send('something else');
    expect(model.getProposal()).toBeNull();
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
  });

  it('keeps the reply signature (for read-aloud) on the assistant message only', async () => {
    const agent = vi.fn(async () => ({ reply: 'ok', replySignature: 'f'.repeat(64), proposal: null }));
    const model = createChatModel({ getRevision: () => 1, agent });
    model.send('hello');
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
    const [user, reply] = model.getMessages();
    expect(user).not.toHaveProperty('signature');
    expect(reply).toMatchObject({ role: 'assistant', text: 'ok', signature: 'f'.repeat(64) });
  });
});

describe('chat model language', () => {
  it('passes the chat language to the agent and writes its own notes in it', async () => {
    let language = 'en';
    const agent = vi.fn().mockRejectedValueOnce(new TypeError('offline'));
    const model = createChatModel({ getRevision: () => 1, agent, getLanguage: () => language });
    model.send('hello');
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
    expect(agent.mock.calls[0][0].language).toBe('en');
    expect(model.getMessages().at(-1).text).toBe(STRINGS.en.agentError);
    language = 'he';
    model.setProposal({ id: 'p', baseRevision: 1, summary: '', changes: [] });
    model.cancelProposal();
    expect(model.getMessages().at(-1).text).toBe(STRINGS.he.cancelled);
  });

  it('the not-connected note follows the language too', () => {
    const model = createChatModel({ getRevision: () => 1, getLanguage: () => 'en' });
    model.send('hi');
    expect(model.getMessages().at(-1).text).toBe(STRINGS.en.notConnected);
  });
});

describe('messages keep their language', () => {
  it('stamps every message and proposal with the language of its turn, even across a mid-request switch', async () => {
    let language = 'he';
    let release;
    const agent = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const model = createChatModel({ getRevision: () => 1, agent, getLanguage: () => language });
    model.send('תוסיף מדף');
    language = 'en'; // switched while the designer is thinking
    release({ reply: 'אציע מדף.', proposal: { proposalId: 'prp_0123456789abcdef', baseRevision: 1, summary: 's', changes: [], ops: [], signature: 'x' } });
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
    expect(agent.mock.calls[0][0].language).toBe('he');
    expect(model.getMessages().map((m) => [m.role, m.language])).toEqual([['user', 'he'], ['assistant', 'he']]);
    expect(model.getProposal().language).toBe('he');
    model.cancelProposal(); // a new note, in the language chosen now
    expect(model.getMessages().at(-1)).toMatchObject({ role: 'system', language: 'en', text: STRINGS.en.cancelled });
  });
});

describe('the Generate Style Profile step', () => {
  it('appears once the agent offers it or a change was confirmed, and never piles up', async () => {
    const agent = vi.fn().mockResolvedValue({ reply: 'Great, download it.', offerProfile: true });
    const model = createChatModel({ getRevision: () => 1, agent, getLanguage: () => 'he' });
    expect(model.getBuilt()).toBeNull();
    model.send('סיימתי');
    await vi.waitFor(() => expect(model.isBusy()).toBe(false));
    expect(model.getBuilt()).toEqual({ kind: 'design', language: 'he' });
    model.noteDesignReady();
    expect(model.getBuilt()).toEqual({ kind: 'design', language: 'he' });
    expect(model.getMessages().map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});
