import { describe, expect, it, vi } from 'vitest';
import { createLanguage, DEFAULT_LANGUAGE, detectLanguage, LANGUAGES, STRINGS, stringsFor } from '../../../src/chat/i18n.js';

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; }, data };
};

describe('chat strings', () => {
  it('every language defines exactly the same keys', () => {
    const keys = (lang) => Object.keys(STRINGS[lang]).sort();
    LANGUAGES.forEach((lang) => expect(keys(lang)).toEqual(keys(DEFAULT_LANGUAGE)));
    expect(STRINGS.he.dir).toBe('rtl');
    expect(STRINGS.en.dir).toBe('ltr');
  });

  it('falls back to the default language for unknown codes', () => {
    expect(stringsFor('fr')).toBe(STRINGS[DEFAULT_LANGUAGE]);
    expect(STRINGS.en.changeCount(1)).toBe('1 change');
    expect(STRINGS.he.changeCount(3)).toBe('3 שינויים');
  });

  it('has 3 or 4 short quick requests in every language', () => {
    LANGUAGES.forEach((lang) => {
      const prompts = STRINGS[lang].quickPrompts;
      expect(prompts.length, lang).toBeGreaterThanOrEqual(3);
      expect(prompts.length, lang).toBeLessThanOrEqual(4);
      prompts.forEach((text) => expect(text.trim().length, `${lang}: ${text}`).toBeGreaterThan(0));
      expect(new Set(prompts).size, lang).toBe(prompts.length);
      expect(STRINGS[lang].quickPromptsLabel, lang).toMatch(/\S/);
    });
    expect(STRINGS.he.quickPrompts.length).toBe(STRINGS.en.quickPrompts.length);
  });
});

describe('createLanguage', () => {
  it('defaults to Hebrew, remembers the choice and notifies listeners', () => {
    const storage = memoryStorage();
    const language = createLanguage({ storage });
    expect(language.get()).toBe('he');
    const listener = vi.fn();
    language.subscribe(listener);
    language.set('en');
    language.set('en'); // no-op
    language.set('xx'); // ignored
    expect(language.get()).toBe('en');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(createLanguage({ storage }).get()).toBe('en'); // restored on the next visit
  });

  it('ignores junk in storage and survives blocked storage', () => {
    expect(createLanguage({ storage: memoryStorage({ 'banai.chat.language': 'zz' }) }).get()).toBe('he');
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    const language = createLanguage({ storage: blocked });
    expect(language.get()).toBe('he');
    language.set('en');
    expect(language.get()).toBe('en');
  });
});

describe('detectLanguage', () => {
  it('detects Hebrew, English, mixed (Hebrew wins) and no letters', () => {
    expect(detectLanguage('תוסיף מדף')).toBe('he');
    expect(detectLanguage('Add a shelf')).toBe('en');
    expect(detectLanguage('תצבע ב-Walnut')).toBe('he');
    expect(detectLanguage('240?')).toBeNull();
  });
});
