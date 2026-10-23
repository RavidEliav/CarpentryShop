// The private link of a saved design: /#d=<uuid>.<token>. The fragment never reaches a server log or
// a Referer header; only this page reads it and sends the token to the API as a bearer credential.
const LINK = /^#d=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** { designId, token } from a location hash, or null when it is not a design link. */
export function parseShareHash(hash) {
  const match = LINK.exec(hash ?? '');
  return match ? { designId: match[1], token: match[2] } : null;
}

export const shareHash = ({ designId, token }) => `#d=${designId}.${token}`;
