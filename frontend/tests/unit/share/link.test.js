import { describe, expect, it } from 'vitest';
import { parseShareHash, shareHash } from '../../../src/share/link.js';

const designId = '0b6f2a52-3c1e-4c8e-9a51-1f6f3f2b7d10';
const token = 'A'.repeat(40) + '_-9';

describe('share link', () => {
  it('round-trips a design id and token through the hash', () => {
    expect(parseShareHash(shareHash({ designId, token }))).toEqual({ designId, token });
  });

  it.each([
    ['', 'empty'],
    [`#d=${designId}`, 'no token'],
    [`#d=${designId}.short`, 'short token'],
    [`#d=not-a-uuid.${token}`, 'bad id'],
    [`#d=${designId}.${token}&x=1`, 'trailing data'],
    [`#x=${designId}.${token}`, 'other key'],
  ])('rejects %s (%s)', (hash) => {
    expect(parseShareHash(hash)).toBeNull();
  });
});
