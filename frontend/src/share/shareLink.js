// Private share links: `<page>#d=<uuid>.<token>`. The fragment is never sent to any server (neither in
// requests nor in Referer headers), so the access token only lives in the link itself.
const LINK = /^#d=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** `#d=<uuid>.<token>` -> { designId, token }, or null for anything else. */
export function parseShareFragment(hash) {
  const match = typeof hash === 'string' ? LINK.exec(hash) : null;
  return match ? Object.freeze({ designId: match[1], token: match[2] }) : null;
}

export const shareFragment = ({ designId, token }) => `#d=${designId}.${token}`;

export const shareUrl = ({ origin, pathname }, link) => `${origin}${pathname}${shareFragment(link)}`;

export const sameLink = (a, b) => Boolean(a && b && a.designId === b.designId && a.token === b.token);
