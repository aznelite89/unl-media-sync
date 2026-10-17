import {
  AUDIT_MAX_PAGES,
  AUDIT_PAGE_SIZE,
  IMAGE_DRIFT_BUDGET_MS,
  IMAGE_DRIFT_MAX_SYNCS,
  SYNC_OUTCOME,
} from '../constants/index.js';
import { normaliseCode } from './audit.js';
import { imageKey, orderedUnleashedImages } from './imageIdentity.js';
import { parseState } from './state.js';
import { syncUnleashedProduct } from './sync.js';

/**
 * Whole-catalogue check for products whose Unleashed images and Shopify state
 * have drifted apart.
 *
 * The 10-minute reconcile only visits products whose LastModifiedOn moved, and
 * adding or replacing an attachment in Unleashed does not move it. 9KC597 had a
 * second image attached in October with LastModifiedOn still 11 August, so no
 * scheduled pass ever looked at it again. Comparing images to state directly is
 * the only check that does not depend on Unleashed reporting the change.
 */

/**
 * Pure diff. A product has drifted when an image Unleashed lists is in no state
 * entry on its Shopify product, or, with deletion on, when a state entry this
 * code owns points at an image Unleashed no longer lists.
 *
 * Image-less products are left to the reconcile's corroborated last-image path.
 * A page already at its cap with nothing of this code's to free a slot is left
 * out too: syncing it would only report `capped` again every night.
 *
 * @param {{
 *   products: object[],
 *   skus: Map<string, { productId: string | null, productCount: number }>,
 *   states: Map<string, { stateMetafield: object | null, mediaCount: number }>,
 *   maxSyncedImages: number,
 *   maxMediaPerProduct: number,
 *   deleteRemovedMedia: boolean,
 * }} input
 */
export function findImageDrift({
  products,
  skus,
  states,
  maxSyncedImages,
  maxMediaPerProduct,
  deleteRemovedMedia,
}) {
  const drifted = [];

  for (const product of products) {
    if (product?.Obsolete === true) continue;

    const desired = orderedUnleashedImages(product?.Images, maxSyncedImages);
    if (desired.length === 0) continue;

    const productCode = String(product?.ProductCode ?? '').trim();
    const match = skus.get(normaliseCode(productCode));
    // Unmatched and ambiguous codes are the weekly audit's to report.
    if (!match?.productId || match.productCount !== 1) continue;

    const shopifyProduct = states.get(match.productId);
    if (!shopifyProduct) continue;

    const { managed } = parseState(shopifyProduct.stateMetafield);
    // Any code's entry resolves an image: siblings share one photograph.
    const tracked = new Set(managed.map((entry) => imageKey(entry.url)));
    const missing = desired.filter((image) => !tracked.has(imageKey(image.url)));

    const wanted = new Set(desired.map((image) => imageKey(image.url)));
    const stale = deleteRemovedMedia
      ? managed.filter(
          (entry) => entry.productCode === productCode && !wanted.has(imageKey(entry.url)),
        )
      : [];

    if (missing.length === 0 && stale.length === 0) continue;
    if (stale.length === 0 && shopifyProduct.mediaCount >= maxMediaPerProduct) continue;

    drifted.push({
      productCode,
      shopifyProductId: match.productId,
      missing: missing.length,
      stale: stale.length,
      unleashedProduct: product,
    });
  }

  return drifted;
}

/**
 * Reads both catalogues, finds drift and, when `apply` is set, syncs each
 * drifted product through the ordinary sync so every existing guard applies.
 * `config.dryRun` is still honoured inside the sync.
 *
 * @param {{
 *   unleashed: object,
 *   shopify: object,
 *   config: object,
 *   log: object,
 *   apply: boolean,
 *   maxSyncs?: number,
 *   budgetMs?: number,
 *   nowMs?: () => number,
 * }} input
 */
export async function sweepImageDrift({
  unleashed,
  shopify,
  config,
  log,
  apply,
  maxSyncs = IMAGE_DRIFT_MAX_SYNCS,
  budgetMs = IMAGE_DRIFT_BUDGET_MS,
  nowMs = Date.now,
}) {
  const startedAt = nowMs();

  const products = [];
  let truncated = false;
  for await (const page of unleashed.iterateProducts({
    pageSize: AUDIT_PAGE_SIZE,
    maxPages: AUDIT_MAX_PAGES,
  })) {
    products.push(...page.items);
    if (page.pageNumber >= AUDIT_MAX_PAGES && page.pageNumber < page.totalPages) truncated = true;
  }

  const skus = await shopify.listAllVariantSkus();
  const states = await shopify.listProductStates();

  const drifted = findImageDrift({
    products,
    skus,
    states,
    maxSyncedImages: config.maxSyncedImages,
    maxMediaPerProduct: config.maxMediaPerProduct,
    deleteRemovedMedia: config.deleteRemovedMedia,
  });

  const results = [];
  let deferred = 0;

  for (const item of drifted) {
    const { unleashedProduct, ...summary } = item;
    if (!apply) {
      results.push({ ...summary, outcome: null });
      continue;
    }
    if (results.length >= maxSyncs || nowMs() - startedAt >= budgetMs) {
      deferred += 1;
      continue;
    }

    let outcome;
    let notes = [];
    try {
      const result = await syncUnleashedProduct({ unleashedProduct, shopify, config, log });
      outcome = result.outcome;
      notes = result.notes ?? [];
    } catch (error) {
      outcome = SYNC_OUTCOME.FAILED;
      notes = [error.message];
    }
    log.warn?.(
      `drift: ${summary.productCode} missing ${summary.missing}, stale ${summary.stale} → ${outcome}` +
        (notes.length ? ` (${notes.join('; ')})` : ''),
    );
    results.push({ ...summary, outcome, notes });
  }

  if (deferred > 0) {
    log.warn?.(`drift: ${deferred} drifted product(s) left for the next run (cap or time budget)`);
  }

  return { scanned: products.length, truncated, drifted: drifted.length, deferred, results };
}
