import { NEW_ARRIVAL_MAX_REMOVAL_SHARE, NEW_ARRIVAL_REMOVAL_GUARD_MIN } from '../constants/index.js';
import { parseUnleashedDate } from './customerNotesPlan.js';

/**
 * Pure decisions for the New Arrivals tag: no network, so self-test covers them.
 */

/** The oldest creation time that still counts as new: `months` calendar months before `nowMs`. */
export function newArrivalCutoff(nowMs, months) {
  const cutoff = new Date(nowMs);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.getTime();
}

/**
 * Unleashed products created on or after the cutoff, as code (lowercased) to
 * creation time. Obsolete products never count.
 *
 * @param {object[]} products Unleashed product records
 * @param {number} cutoffMs
 * @returns {Map<string, number>}
 */
export function recentCodes(products, cutoffMs) {
  const codes = new Map();
  for (const product of products) {
    if (product?.Obsolete) continue;
    const code = String(product?.ProductCode ?? '').trim().toLowerCase();
    const createdMs = parseUnleashedDate(product?.CreatedOn);
    if (!code || createdMs === null || createdMs < cutoffMs) continue;
    codes.set(code, createdMs);
  }
  return codes;
}

/**
 * Which Shopify products should carry the tag, and the tag changes that gets there.
 *
 * A product counts from its newest matched variant code, which is also the date
 * it is ordered by. A SKU on two products is skipped, as the image sync does:
 * there is no telling which one is meant.
 *
 * @param {{
 *   recent: Map<string, number>,
 *   skus: Map<string, { productId: string, title: string, productCount: number }>,
 *   tagged: Set<string>,
 *   force?: boolean,
 * }} input
 */
export function planNewArrivals({ recent, skus, tagged, force = false }) {
  const wanted = new Map();
  const unmatched = [];
  const ambiguous = [];

  for (const [code, createdMs] of recent) {
    const match = skus.get(code);
    if (!match?.productId) {
      unmatched.push(code);
      continue;
    }
    if (match.productCount > 1) {
      ambiguous.push(code);
      continue;
    }
    const existing = wanted.get(match.productId);
    if (!existing || createdMs > existing.createdMs) {
      wanted.set(match.productId, { productId: match.productId, title: match.title, code, createdMs });
    }
  }

  const add = [...wanted.values()].filter((entry) => !tagged.has(entry.productId));
  const remove = [...tagged].filter((productId) => !wanted.has(productId));

  const removalHeld =
    !force &&
    remove.length >= NEW_ARRIVAL_REMOVAL_GUARD_MIN &&
    remove.length > tagged.size * NEW_ARRIVAL_MAX_REMOVAL_SHARE;

  return {
    wanted,
    add,
    remove: removalHeld ? [] : remove,
    heldRemovals: removalHeld ? remove : [],
    unmatched,
    ambiguous,
  };
}

/**
 * The collection order, newest first: by Unleashed creation date unless
 * `dateOf` picks another date. Products the plan does not know (none, once
 * tagging has settled) keep their relative order at the end.
 *
 * @param {string[]} current Product ids in the collection's present order
 * @param {Map<string, object>} wanted
 * @param {(entry: object) => number} [dateOf]
 * @returns {string[]}
 */
export function newestFirst(current, wanted, dateOf = (entry) => entry.createdMs) {
  const known = current.filter((id) => wanted.has(id));
  const unknown = current.filter((id) => !wanted.has(id));
  known.sort((a, b) => dateOf(wanted.get(b)) - dateOf(wanted.get(a)) || a.localeCompare(b));
  return [...known, ...unknown];
}

/**
 * `collectionReorderProducts` moves taking `current` to `desired`. Every
 * product from the first difference onward is placed explicitly: Shopify
 * applies moves in order, so a partial list would shift the rest.
 *
 * @returns {Array<{ id: string, newPosition: string }>}
 */
export function reorderMoves(current, desired) {
  const first = desired.findIndex((id, index) => current[index] !== id);
  if (first === -1) return [];
  return desired.slice(first).map((id, offset) => ({ id, newPosition: String(first + offset) }));
}
