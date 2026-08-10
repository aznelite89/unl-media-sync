/**
 * The record of which Shopify media this service owns, stored on the product
 * itself in the `custom.unleashed_media` metafield.
 *
 * It lives apart from the planner because ownership is read by things that have
 * no business pulling in the sync logic — the duplicate scanner in particular,
 * which only needs to know who put a media item there. Keeping it here is what
 * lets `sync.js` use the scanner without the two importing each other.
 *
 * This state is the ONLY thing separating media this service may remove from
 * media it must never touch. Anything absent from it is safe by construction.
 */

import { STATE_VERSION } from '../constants/index.js';

/**
 * Reads the state this service wrote on a previous run. Anything malformed is
 * treated as "no state" — the reconciler can always rebuild it by adoption.
 *
 * @param {{ value?: string } | null} metafield
 */
export function parseState(metafield) {
  const empty = { version: STATE_VERSION, managed: [], syncedAt: null };
  if (!metafield?.value) return empty;

  try {
    const parsed = JSON.parse(metafield.value);
    if (!Array.isArray(parsed?.managed)) return empty;
    return {
      version: parsed.version ?? STATE_VERSION,
      syncedAt: parsed.syncedAt ?? null,
      managed: parsed.managed.filter((entry) => entry?.url && entry?.mediaId),
    };
  } catch {
    return empty;
  }
}

/**
 * Rewrites this product code's entries while preserving those belonging to
 * sibling Unleashed products that share the same Shopify product. Dropping the
 * siblings would make their images look unowned and, with deletion enabled,
 * expose them to being detached.
 *
 * `retained` is the other half of that guarantee, for this code's own images:
 * media Unleashed no longer lists but which is STILL ON THE PAGE, because
 * `DELETE_REMOVED_MEDIA` is off or the detach call failed. Writing only
 * `entries` would drop its ownership record while leaving the picture in place,
 * so the sync would forget it ever put it there — the image becomes unowned,
 * indistinguishable from one added by hand, and therefore permanently beyond
 * both `DELETE_REMOVED_MEDIA` and the duplicate cleanup, which by design never
 * touch media this service did not add. Replacing an image in Unleashed would
 * quietly strand the old one in the shop forever.
 *
 * @param {{ productCode: string, entries: object[], previousManaged?: object[], liveMediaIds?: Set<string>, retained?: object[] }} input
 */
export function buildState({
  productCode,
  entries,
  previousManaged = [],
  liveMediaIds,
  retained = [],
}) {
  const foreign = previousManaged.filter(
    (entry) =>
      entry.productCode !== productCode && (!liveMediaIds || liveMediaIds.has(entry.mediaId)),
  );

  // An image Unleashed dropped is no longer anyone's default, and it must not
  // shadow an entry this run just wrote for the same media.
  const claimed = new Set(entries.map((entry) => entry.mediaId));
  const stranded = retained.filter(
    (entry) =>
      !claimed.has(entry.mediaId) && (!liveMediaIds || liveMediaIds.has(entry.mediaId)),
  );

  return {
    version: STATE_VERSION,
    syncedAt: new Date().toISOString(),
    managed: [
      ...foreign,
      ...entries.map((entry) => ({
        url: entry.url,
        mediaId: entry.mediaId,
        origin: entry.origin,
        isDefault: entry.isDefault === true,
        productCode,
      })),
      ...stranded.map((entry) => ({
        url: entry.url,
        mediaId: entry.mediaId,
        origin: entry.origin,
        isDefault: false,
        productCode,
      })),
    ],
  };
}
