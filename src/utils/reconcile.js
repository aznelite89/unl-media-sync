import { SYNC_OUTCOME } from '../constants/index.js';
import { summarise } from './logger.js';
import { syncUnleashedProduct } from './sync.js';

/**
 * `modifiedSince` value for a lookback window. A fixed overlapping window is
 * used instead of a stored watermark: the sync is diff-based, so re-reading the
 * same products is free of side effects and there is no state to corrupt.
 *
 * @param {number} minutes
 * @param {number} [nowMs]
 */
export function lookbackSince(minutes, nowMs = Date.now()) {
  return new Date(nowMs - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, '');
}

/**
 * Syncs one product identified by its Unleashed Guid (the webhook path).
 */
export async function syncByGuid({ guid, unleashed, shopify, config, log }) {
  const product = await unleashed.getProductByGuid(guid);
  if (!product) {
    return { outcome: SYNC_OUTCOME.FAILED, notes: [`Unleashed product ${guid} not found`] };
  }
  return syncUnleashedProduct({ unleashedProduct: product, shopify, config, log });
}

/**
 * Syncs one product identified by its product code / SKU (the manual path).
 */
export async function syncByProductCode({ productCode, unleashed, shopify, config, log }) {
  const product = await unleashed.getProductByCode(productCode);
  if (!product) {
    return {
      productCode,
      outcome: SYNC_OUTCOME.FAILED,
      notes: [`No Unleashed product with code ${productCode}`],
    };
  }
  return syncUnleashedProduct({ unleashedProduct: product, shopify, config, log });
}

/**
 * Walks every Unleashed product modified since `sinceIso` and syncs each one.
 * Products are handled sequentially — throughput is irrelevant here and it keeps
 * both APIs well inside their rate limits.
 *
 * @param {{ sinceIso?: string, limit?: number, unleashed: object, shopify: object, config: object, log: object }} input
 */
export async function reconcile({
  sinceIso,
  limit,
  startPage,
  maxPages,
  unleashed,
  shopify,
  config,
  log,
}) {
  const results = [];
  let scanned = 0;
  let lastPage = null;

  for await (const { items, pageNumber, totalPages } of unleashed.iterateProducts({
    sinceIso,
    startPage,
    maxPages: maxPages ?? config.maxPages,
  })) {
    lastPage = { pageNumber, totalPages };
    log.info?.(`reconcile: page ${pageNumber}/${totalPages} — ${items.length} product(s)`);

    for (const unleashedProduct of items) {
      if (limit && results.length >= limit) {
        log.info?.(`reconcile: stopping at limit of ${limit} product(s)`);
        return finish({ results, scanned, sinceIso, truncated: true, lastPage });
      }

      scanned += 1;
      // Products without images are the common case; skip before touching Shopify.
      if (!(unleashedProduct?.Images ?? []).length) continue;

      try {
        const result = await syncUnleashedProduct({ unleashedProduct, shopify, config, log });
        results.push(result);
        if (result.outcome !== SYNC_OUTCOME.UNCHANGED) {
          log.info?.(
            `reconcile: ${result.productCode} → ${result.outcome}` +
              (result.notes.length ? ` (${result.notes.join('; ')})` : ''),
          );
        }
      } catch (error) {
        log.error?.(
          `reconcile: ${unleashedProduct?.ProductCode ?? unleashedProduct?.Guid} failed — ${error.message}`,
        );
        results.push({
          productCode: unleashedProduct?.ProductCode ?? null,
          outcome: SYNC_OUTCOME.FAILED,
          notes: [error.message],
        });
      }
    }
  }

  return finish({ results, scanned, sinceIso, truncated: false, lastPage });
}

function finish({ results, scanned, sinceIso, truncated, lastPage }) {
  const morePages = lastPage && lastPage.pageNumber < lastPage.totalPages;
  return {
    sinceIso: sinceIso ?? null,
    scanned,
    withImages: results.length,
    truncated,
    lastPage: lastPage?.pageNumber ?? null,
    totalPages: lastPage?.totalPages ?? null,
    /** Where to resume; null when the catalogue is exhausted. */
    nextStartPage: morePages ? lastPage.pageNumber + 1 : null,
    byOutcome: summarise(results),
    /** Only the interesting ones — unchanged products are the bulk and are noise. */
    details: results.filter((result) => result.outcome !== SYNC_OUTCOME.UNCHANGED),
  };
}
