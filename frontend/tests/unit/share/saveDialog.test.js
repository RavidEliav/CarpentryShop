import { describe, expect, it } from 'vitest';
import { saveIndicatorText, saveStatusText } from '../../../src/share/saveDialog.js';

const LINK = { designId: '3f1c2b4a-1111-4222-8333-444455556666', token: 'x'.repeat(43) };
const base = { available: true, link: null, status: 'idle', dirty: true, error: null };

describe('save dialog texts', () => {
  it('describes every save state honestly', () => {
    expect(saveStatusText({ ...base, available: false })).toBe('Saving is not available on this server.');
    expect(saveStatusText(base)).toBe('Not saved yet.');
    expect(saveStatusText({ ...base, status: 'saving' })).toBe('Saving…');
    expect(saveStatusText({ ...base, link: LINK, status: 'saved', dirty: false })).toBe('Saved. The link opens this version.');
    expect(saveStatusText({ ...base, link: LINK, status: 'saved', dirty: true })).toBe('You have changes that are not saved yet.');
    expect(saveStatusText({ ...base, link: LINK, status: 'conflict' })).toMatch(/changed in another tab or window/);
    expect(saveStatusText({ ...base, status: 'error', error: 'Too many designs.' })).toBe('Too many designs.');
    expect(saveStatusText({ ...base, status: 'error' })).toBe('Saving failed. Please try again.');
  });

  it('shows the top-bar indicator only once the design has a link', () => {
    expect(saveIndicatorText(base)).toBeNull();
    expect(saveIndicatorText({ ...base, status: 'saving' })).toBeNull();
    expect(saveIndicatorText({ ...base, link: LINK, status: 'saved', dirty: false })).toBe('Saved');
    expect(saveIndicatorText({ ...base, link: LINK, status: 'saved', dirty: true })).toBe('Unsaved changes');
    expect(saveIndicatorText({ ...base, link: LINK, status: 'saving' })).toBe('Saving…');
    expect(saveIndicatorText({ ...base, link: LINK, status: 'conflict', dirty: true })).toBe('Unsaved changes');
  });
});
