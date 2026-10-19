import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import { applyProposal, getCatalog, getDefaultDesign, getHealth, loadDesign, sendChat } from './api/client.js';
import { createStore } from './state/store.js';
import { mountPanel } from './editor/panel.js';
import { createViewer } from './viewer/viewer.js';
import { createChatModel } from './chat/chatModel.js';
import { createLanguage } from './chat/i18n.js';
import { mountChat } from './chat/chatPanel.js';
import { mountStartScreen } from './entry/startScreen.js';
import { createPersistence } from './share/persistence.js';
import { createSaveDialog, saveIndicatorText } from './share/saveDialog.js';
import { parseShareFragment, sameLink, shareFragment } from './share/shareLink.js';
import { createRenderDialog } from './render/renderDialog.js';
import { createLogo } from './ui/logo.js';
import { installRipple } from './ui/ripple.js';

const LINK_NOT_FOUND = 'This design link is not valid, or the design no longer exists. You can start a new design.';
const LINK_FAILED = 'The saved design could not be opened right now. Please reload to try again.';

function showError(message) {
  const banner = document.getElementById('error-banner');
  banner.textContent = message;
  banner.hidden = false;
}

/** The design behind a private link, or null (with an error banner) when it cannot be opened. */
async function openSavedDesign(link) {
  if (!link) return null;
  try {
    const { design, revision } = await loadDesign(link);
    return { design, revision, link };
  } catch (error) {
    showError(error?.status === 404 ? LINK_NOT_FOUND : LINK_FAILED);
    return null;
  }
}

function bindInteriorToggle(store) {
  const toggle = document.getElementById('toggle-interior');
  toggle.addEventListener('change', () => store.setDoorsVisible(!toggle.checked));
  store.subscribe((state) => { toggle.checked = !state.ui.doorsVisible; });
}

function bindDialogs() {
  const render = createRenderDialog();
  document.getElementById('open-render').addEventListener('click', render.open);
}

function bindSaving(persistence) {
  const dialog = createSaveDialog({ persistence });
  document.getElementById('open-save').addEventListener('click', dialog.open);
  const indicator = document.getElementById('save-indicator');
  let shownLink = persistence.getState().link;
  const update = (state) => {
    const text = saveIndicatorText(state);
    indicator.hidden = text === null;
    indicator.textContent = text ?? '';
    if (state.link && !sameLink(state.link, shownLink)) {
      shownLink = state.link;
      // The address bar becomes the private link, so a reload reopens it (no reload, no history entry).
      window.history.replaceState(null, '', shareFragment(state.link));
    }
  };
  persistence.subscribe(update);
  update(persistence.getState());
  // A different link pasted into the address bar of this tab only fires hashchange: open it properly.
  window.addEventListener('hashchange', () => {
    const next = parseShareFragment(window.location.hash);
    if (next && !sameLink(next, persistence.getState().link)) window.location.reload();
  });
}

async function boot() {
  document.getElementById('topbar-logo').append(createLogo({ size: 34, tagline: 'Wardrobe Designer' }));
  installRipple();
  let catalog;
  let initial;
  let health;
  let saved;
  try {
    // A failed health check only means "agent unknown": the editor still works without it.
    [catalog, initial, health, saved] = await Promise.all([
      getCatalog(), getDefaultDesign(), getHealth().catch(() => null),
      openSavedDesign(parseShareFragment(window.location.hash)),
    ]);
  } catch {
    showError('Could not reach the design service. Please check your connection and reload.');
    return;
  }
  // Validates the server data before anything is rendered (throws on invalid data).
  const store = createStore({ design: (saved ?? initial).design, revision: initial.revision, catalog });
  const viewer = createViewer(document.getElementById('viewer'), store);
  bindInteriorToggle(store);
  mountPanel(document.getElementById('properties-content'), store);
  bindDialogs();
  const persistence = createPersistence({ store, available: health?.data.persistence === true || saved !== null, saved });
  bindSaving(persistence);

  // The agent is optional: without an OpenAI key on the server the panel says so honestly.
  const agent = health?.data.agent === true
    ? ({ messages, language: chatLanguage }) => {
      const { design, revision } = store.getState();
      return sendChat({ messages, design, revision, language: chatLanguage });
    }
    : null;
  const language = createLanguage();
  const chatModel = createChatModel({ getRevision: () => store.getState().revision, agent, getLanguage: language.get });
  const t = () => language.strings();

  let applying = false;
  const confirmProposal = async (proposal) => {
    if (applying) return;
    if (!proposal.signed) {
      chatModel.resolveProposal(t().notApplied);
      return;
    }
    applying = true;
    const { design, revision } = store.getState();
    try {
      const result = await applyProposal({ design, revision, proposal: proposal.signed, language: language.get() });
      store.replaceDesign(result.design, result.revision);
      chatModel.resolveProposal(t().applied);
    } catch (error) {
      chatModel.resolveProposal(error?.code === 'STALE' ? t().stale : t().notApplied);
    } finally {
      applying = false;
    }
  };
  const chat = mountChat(document.getElementById('chat-panel'), { model: chatModel, onConfirm: confirmProposal, language });
  // A manual edit changes the revision, which may turn a pending proposal stale.
  store.subscribe(() => chat.refresh());

  if (import.meta.env.DEV) {
    window.__banai = Object.freeze({ store, viewer, chat: chatModel, persistence });
  }

  // A saved design opens straight into the editor; otherwise the customer chooses how to begin.
  if (saved) return;
  mountStartScreen({
    onChoose: (entry) => {
      // All three entry points open the same editor; the chat ones also focus the composer.
      if (entry.focusesChat) chat.focus(entry.id);
    },
  });
}

boot().catch(() => {
  showError('The designer could not start. Please reload the page.');
});
