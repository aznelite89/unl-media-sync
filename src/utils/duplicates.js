/**
 * Finding — and where it is safe, repairing — pictures that appear twice on one
 * Shopify product.
 *
 * These are the damage already done before content-aware adoption existed (see
 * imageFingerprint.js): the sync could not tell that a photo someone had
 * uploaded to Shopify by hand was the same picture Unleashed later served under
 * a GUID, so it uploaded a second copy. Stopping new ones does not remove the
 * old ones, and with a 5-image page cap a duplicate is also a slot a real image
 * needed.
 *
 * Detection is exact and costs nothing extra: Shopify returns both the original
 * file size and `thumbhash`, its own perceptual digest, in the media query.
 * Two media with the same digest, size and dimensions hold the same picture.
 */

import {
  DUPLICATE_KIND,
  DUPLICATE_SCAN_BUDGET_MS,
  FOREIGN_DUPLICATE_KINDS,
  MEDIA_ORIGIN,
  SHOPIFY_ACCESS_DENIED_CODE,
  SHOPIFY_DETACH_SCOPE,
} from '../constants/index.js';
import { contentKey, shopifyFingerprint } from './imageFingerprint.js';
import { parseState } from './state.js';

/**
 * Groups one product's media by picture, returning only the pictures present
 * more than once.
 *
 * @param {{ media: object[], state: object }} input
 * @returns {Array<{ kind: string, copies: object[] }>}
 */
export function findDuplicateGroups({ media, state }) {
  const ownerByMediaId = new Map(
    (state?.managed ?? []).map((entry) => [entry.mediaId, entry]),
  );

  const byPicture = new Map();
  for (const item of media ?? []) {
    const fingerprint = shopifyFingerprint(item);
    // Unmeasurable media cannot be proven a duplicate, so it is never claimed to be.
    if (!fingerprint) continue;

    const key = contentKey(fingerprint);
    const owner = ownerByMediaId.get(item.id) ?? null;
    const copy = {
      mediaId: item.id,
      filename: filenameOf(item.image?.url),
      bytes: fingerprint.bytes,
      dimensions: `${fingerprint.width}x${fingerprint.height}`,
      productCode: owner?.productCode ?? null,
      origin: owner?.origin ?? null,
      managed: owner !== null,
    };

    const group = byPicture.get(key);
    if (group) group.push(copy);
    else byPicture.set(key, [copy]);
  }

  const groups = [];
  for (const copies of byPicture.values()) {
    if (copies.length < 2) continue;
    groups.push({ kind: classify(copies), copies });
  }
  return groups;
}

/** @param {object[]} copies */
function classify(copies) {
  const managed = copies.filter((copy) => copy.managed).length;
  if (managed === 0) return DUPLICATE_KIND.ALL_UNMANAGED;
  if (managed === copies.length) return DUPLICATE_KIND.ALL_MANAGED;
  return DUPLICATE_KIND.MIXED;
}

/** @param {string | undefined} url */
function filenameOf(url) {
  if (!url) return '';
  return decodeURIComponent(String(url).split('?')[0].split('/').filter(Boolean).pop() ?? '');
}

/**
 * The media ids it is safe to detach to leave exactly one copy of each picture.
 *
 * What survives is chosen so the next sync re-adopts it rather than re-uploading:
 *
 *  - mixed — keep the copy this sync does not own. It was there first, and
 *    adoption reaches it by content on the next run.
 *  - all managed — keep the first copy in page order and drop the sibling codes'
 *    duplicates of it. Those codes re-adopt the survivor, because adoption may
 *    now claim media belonging to another code.
 *  - all unmanaged — untouched. This sync did not create them and does not
 *    remove media it never added.
 *
 * @param {Array<{ kind: string, copies: object[] }>} groups
 * @returns {Array<{ mediaId: string, keptMediaId: string, productCode: string | null }>}
 */
export function planDuplicateCleanup(groups) {
  const removals = [];
  for (const group of groups) {
    let keep = null;
    if (group.kind === DUPLICATE_KIND.MIXED) keep = group.copies.find((copy) => !copy.managed);
    else if (group.kind === DUPLICATE_KIND.ALL_MANAGED) [keep] = group.copies;
    if (!keep) continue;

    for (const copy of group.copies) {
      // Never detach media nobody owns, whichever group it turned up in.
      if (copy.mediaId === keep.mediaId || !copy.managed) continue;
      removals.push({
        mediaId: copy.mediaId,
        keptMediaId: keep.mediaId,
        productCode: copy.productCode,
      });
    }
  }
  return removals;
}

/**
 * True when a group contains a copy no state entry owns — i.e. something other
 * than this service put a copy of this picture on the page. See
 * FOREIGN_DUPLICATE_KINDS for why this, and not "any duplicate", drives alerting.
 *
 * @param {{ kind: string }} group
 */
export function isForeignDuplicate(group) {
  return FOREIGN_DUPLICATE_KINDS.includes(group?.kind);
}

/**
 * Rolls per-product findings into the totals both reports quote.
 *
 * Shared by the daily pass (which sees only the products it synced) and the
 * weekly sweep (which sees the whole store), so the two can differ in coverage
 * but never in arithmetic.
 *
 * @param {Array<{ groups: object[] }>} products
 */
export function summariseDuplicateGroups(products) {
  const byKind = {
    [DUPLICATE_KIND.MIXED]: 0,
    [DUPLICATE_KIND.ALL_UNMANAGED]: 0,
    [DUPLICATE_KIND.ALL_MANAGED]: 0,
  };
  let groups = 0;
  let wastedSlots = 0;
  let foreignGroups = 0;
  let repairable = 0;

  for (const product of products ?? []) {
    for (const group of product.groups ?? []) {
      groups += 1;
      byKind[group.kind] += 1;
      wastedSlots += group.copies.length - 1;
      if (isForeignDuplicate(group)) foreignGroups += 1;
    }
    repairable += (product.removals ?? []).length;
  }

  return { productsAffected: (products ?? []).length, groups, wastedSlots, foreignGroups, byKind, repairable };
}

/**
 * Scans the whole store for duplicated pictures.
 *
 * @param {{ shopify: object, log?: object, apply?: boolean, budgetMs?: number }} input
 */
export async function auditDuplicates({
  shopify,
  log = console,
  apply = false,
  budgetMs = DUPLICATE_SCAN_BUDGET_MS,
}) {
  const products = [];
  const startedAt = Date.now();
  let scanned = 0;
  let truncated = null;

  try {
    for await (const page of shopify.iterateProductsWithMedia()) {
      for (const product of page.products) {
        scanned += 1;
        const state = parseState(product.metafield);
        const groups = findDuplicateGroups({ media: product.media?.nodes ?? [], state });
        if (groups.length === 0) continue;

        products.push({
          productId: product.id,
          title: product.title ?? '',
          mediaCount: (product.media?.nodes ?? []).length,
          groups,
          removals: planDuplicateCleanup(groups),
        });
      }
      log.info?.(`duplicate scan: page ${page.pageNumber} — ${scanned} products, ${products.length} affected`);

      // Stop ourselves before the host does. Being killed mid-sweep would send no
      // report at all, which is worse than an honestly partial one.
      if (budgetMs !== null && Date.now() - startedAt >= budgetMs) {
        truncated = `stopped after ${scanned} product(s): the ${Math.round(budgetMs / 1000)}s scan budget ran out`;
        log.warn?.(`duplicate scan: ${truncated}`);
        break;
      }
    }
  } catch (error) {
    // Losing every finding to one throttled page would defeat the point; report
    // what was gathered and say it is incomplete.
    truncated = `stopped after ${scanned} product(s): ${error.message}`;
    log.error?.(`duplicate scan: ${truncated}`);
  }

  const result = {
    scanned,
    products,
    truncated,
    ...summariseDuplicateGroups(products),
    detached: 0,
    failures: [],
  };

  if (!apply) return result;

  for (const product of products) {
    if (product.removals.length === 0) continue;
    try {
      await shopify.detachMedia({
        productId: product.productId,
        mediaIds: product.removals.map((removal) => removal.mediaId),
      });
      result.detached += product.removals.length;
      log.info?.(
        `${product.productId}: detached ${product.removals.length} duplicate(s) — ` +
          'the remaining copy is re-adopted on the next sync',
      );
    } catch (error) {
      // A missing scope is a fact about the token, not about this product, so it
      // will fail identically for every one of the hundreds still to come.
      if (error.message.includes(SHOPIFY_ACCESS_DENIED_CODE)) {
        result.blocked = `The Shopify Admin token cannot detach media: \`${SHOPIFY_DETACH_SCOPE}\` is missing from its access scopes. Nothing was changed. Add the scope to the custom app, reissue the token, then run again.`;
        log.error?.(result.blocked);
        return result;
      }
      log.error?.(`${product.productId}: detaching duplicates failed — ${error.message}`);
      result.failures.push({ productId: product.productId, message: error.message });
    }
  }

  return result;
}

/** Origins worth naming in the report, so a row says who put each copy there. */
export const DUPLICATE_ORIGIN_LABEL = {
  [MEDIA_ORIGIN.SYNCED]: 'uploaded by the sync',
  [MEDIA_ORIGIN.ADOPTED]: 'adopted by filename',
  [MEDIA_ORIGIN.ADOPTED_BY_CONTENT]: 'adopted by content',
};
