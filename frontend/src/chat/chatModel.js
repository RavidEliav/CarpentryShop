// Pure chat view-model (no DOM). With an `agent` (Phase 5) a sent message goes to the AI designer;
// without one, it gets an honest "not connected" reply. Either way nothing is ever applied to the
// design from here: a proposal only changes the design after the customer confirms it.
//
// Once the chat changed the design (a confirmed proposal) or the customer said they are done, one
// pinned note ({ kind: 'design' }) offers Generate Style Profile. It is replaced, never added, so
// it never piles up.
//
// A proposal is { id, baseRevision, summary, changes: [{ title, detail }], signed? }. It is kept
// apart from the committed design and is only ever "pending" or "stale" (the design changed after
// it was made). `signed` is the server's signed payload, sent back unchanged on confirm.

import { DEFAULT_LANGUAGE, STRINGS, stringsFor } from './i18n.js';

// Default-language (Hebrew) texts, kept as named exports for callers and tests.
export const NOT_CONNECTED_MESSAGE = STRINGS.he.notConnected;
export const STALE_MESSAGE = STRINGS.he.stale;
export const AGENT_ERROR_MESSAGE = STRINGS.he.agentError;
export const APPLIED_MESSAGE = STRINGS.he.applied;
export const NOT_APPLIED_MESSAGE = STRINGS.he.notApplied;
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_HISTORY = 30; // mirrors the backend cap on messages per request

// Starter prompts shown before the first message (per language in i18n.js). Picking one only fills the composer.
export const SUGGESTIONS = STRINGS.he.suggestions;

export function proposalStatus(proposal, currentRevision) {
  if (!proposal) return null;
  return proposal.baseRevision === currentRevision ? 'pending' : 'stale';
}

/**
 * Map the server's signed proposal to the view-model shape (the original travels in `signed`).
 * `language` is the language it was written in; the card keeps showing it in that language.
 */
export function fromServerProposal(signed, language = DEFAULT_LANGUAGE) {
  return {
    id: signed.proposalId,
    baseRevision: signed.baseRevision,
    summary: signed.summary,
    changes: signed.changes,
    language,
    signed,
  };
}

/**
 * @param getRevision  () => current committed revision
 * @param agent        optional async ({ messages, language }) => { reply, proposal|null }, where
 *                     messages is the user/assistant history ending with the new customer message
 * @param getLanguage  () => the chat language ('he' | 'en' | 'es'): the agent replies in it, and so do UI notes
 */
export function createChatModel({ getRevision, agent = null, getLanguage = () => DEFAULT_LANGUAGE }) {
  let nextId = 1;
  let proposal = null;
  let built = null;
  let busy = false;
  const messages = [];
  const listeners = new Set();
  const notify = () => listeners.forEach((listener) => listener());
  const t = () => stringsFor(getLanguage());
  // Every message remembers the language it was written in, so switching the chat language later
  // never changes how earlier messages look (a Hebrew message stays Hebrew and right-to-left).
  // An agent reply also keeps its server signature, which read-aloud needs (/api/voice/speech).
  const push = (role, text, language = getLanguage(), signature = null) => {
    messages.push(Object.freeze({ id: nextId, role, text, language, ...(signature && { signature }) }));
    nextId += 1;
  };
  // Only real dialogue goes to the model; system notes (cancelled, applied...) are UI-only.
  const history = () => messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_HISTORY)
    .map(({ role, text }) => ({ role, text }));

  async function ask() {
    // The reply is written in the language chosen when the message was sent, even if the
    // customer switches language while the designer is still thinking.
    const language = getLanguage();
    busy = true;
    notify();
    try {
      const { reply, replySignature, proposal: signed, offerProfile } = await agent({ messages: history(), language });
      push('assistant', reply, language, replySignature);
      if (signed) proposal = fromServerProposal(signed, language);
      if (offerProfile === true) built = Object.freeze({ kind: 'design', language });
    } catch (error) {
      push('system', error?.message && error.status ? error.message : stringsFor(language).agentError, language);
    } finally {
      busy = false;
      notify();
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMessages: () => [...messages],
    getProposal: () => proposal,
    getBuilt: () => built,
    getProposalStatus: () => proposalStatus(proposal, getRevision()),
    isBusy: () => busy,
    isConnected: () => agent !== null,

    /**
     * A customer message. Returns { ok } synchronously; with an agent, the reply (and maybe a
     * proposal) arrives later through subscribers. Never touches the design.
     */
    send(rawText) {
      const text = String(rawText ?? '').trim();
      if (!text) return { ok: false, reason: 'empty' };
      if (text.length > MAX_MESSAGE_LENGTH) return { ok: false, reason: 'too-long' };
      if (busy) return { ok: false, reason: 'busy' };
      push('user', text);
      if (!agent) {
        push('system', t().notConnected);
        notify();
        return { ok: true };
      }
      // A new request supersedes an unconfirmed proposal.
      proposal = null;
      ask();
      return { ok: true };
    },

    /** Set by the agent integration (Phase 5) or the dev-only demo. */
    setProposal(next) {
      proposal = next;
      notify();
    },

    /** Cancel never changes the design; it only drops the pending proposal. */
    cancelProposal() {
      if (!proposal) return false;
      proposal = null;
      push('system', t().cancelled);
      notify();
      return true;
    },

    /** The design changed through the chat (a confirmed proposal): offer the PDF step. */
    noteDesignReady() {
      built = Object.freeze({ kind: 'design', language: getLanguage() });
      notify();
    },

    /** Called after the host applied (or refused) the proposal. */
    resolveProposal(message) {
      proposal = null;
      if (message) push('system', message);
      notify();
    },
  };
}
