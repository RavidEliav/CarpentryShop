import { describe, expect, it } from 'vitest';
import { parseShareFragment, sameLink, shareFragment, shareUrl } from '../../../src/share/shareLink.js';

const ID = '3f1c2b4a-1111-4222-8333-444455556666';
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJK-_0123';

describe('share links', () => {
  it('round-trips a link through the URL fragment', () => {
    const link = { designId: ID, token: TOKEN };
    expect(shareFragment(link)).toBe(`#d=${ID}.${TOKEN}`);
    expect(parseShareFragment(shareFragment(link))).toEqual(link);
    expect(shareUrl({ origin: 'https://banai.example', pathname: '/' }, link)).toBe(`https://banai.example/#d=${ID}.${TOKEN}`);
  });

  it('rejects anything that is not exactly a design link', () => {
    for (const hash of [
      '', '#', `#d=${ID}`, `#d=${ID}.`, `#d=${ID}.${TOKEN}x`, `#d=${ID}.${TOKEN.slice(1)}`,
      `#d=${ID.toUpperCase()}.${TOKEN}`, `#x=${ID}.${TOKEN}`, `#d=${ID}.${TOKEN}&evil=1`,
      `#d=not-a-uuid.${TOKEN}`, `#d=${ID}.${TOKEN.slice(1)}<`, null, undefined, 42,
    ]) {
      expect(parseShareFragment(hash)).toBeNull();
    }
  });

  it('compares links by id and token', () => {
    const link = { designId: ID, token: TOKEN };
    expect(sameLink(link, { ...link })).toBe(true);
    expect(sameLink(link, { ...link, token: TOKEN.replace('a', 'b') })).toBe(false);
    expect(sameLink(link, null)).toBe(false);
  });
});
