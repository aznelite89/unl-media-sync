import {
  EMPTY_IMAGES_CORROBORATION_MIN,
  EMPTY_IMAGES_MAX_PER_RUN,
  SYNC_OUTCOME,
} from '../constants/index.js';
import { summariseDuplicateGroups } from './duplicates.js';
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
 *
 * `emptyImagesConfirmed` defaults to true here and nowhere else: a person naming
 * one SKU on the command line is the corroboration a scheduled run has to infer
 * from its own evidence. This is the way to clear a product whose last image was
 * deleted in Unleashed.
 */
export async function syncByProductCode({
  productCode,
  unleashed,
  shopify,
  config,
  log,
  emptyImagesConfirmed = true,
}) {
  const product = await unleashed.getProductByCode(productCode);
  if (!product) {
    return {
      productCode,
      outcome: SYNC_OUTCOME.FAILED,
      notes: [`No Unleashed product with code ${productCode}`],
    };
  }
  return syncUnleashedProduct({
    unleashedProduct: product,
    shopify,
    config,
    log,
    emptyImagesConfirmed,
  });
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
  /**
   * Products Unleashed returned with no images at all. Held back rather than
   * skipped: whether that means "the last photo was deleted" or "the feed is
   * having a bad day" cannot be told from the product, only from whether the
   * feed is serving image data at all — and that is not worth establishing
   * until the walk has finished and it is known whether anything needs it.
   */
  const emptyImageProducts = [];
  let withImagesSeen = 0;

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
        return finish({
          results,
          scanned,
          withImagesSeen,
          sinceIso,
          truncated: true,
          lastPage,
          config,
        });
      }

      scanned += 1;
      if (!(unleashedProduct?.Images ?? []).length) {
        // Never touches Shopify here — most of these products simply have no
        // photos and never did. Decided once, after the walk.
        emptyImageProducts.push(unleashedProduct);
        continue;
      }
      withImagesSeen += 1;

      await syncOne(unleashedProduct);
    }
  }

  // The empty-image products, decided now that the feed can be vouched for.
  if (emptyImageProducts.length > 0) {
    const evidence = await corroborateEmptyImages({
      withImagesSeen,
      unleashed,
      log,
    });
    if (evidence.corroborated) {
      log.info?.(
        `reconcile: ${emptyImageProducts.length} product(s) list no images; ` +
          `${evidence.detail}, so the feed is sound`,
      );
      const checking = emptyImageProducts.slice(0, EMPTY_IMAGES_MAX_PER_RUN);
      if (checking.length < emptyImageProducts.length) {
        // Never silent — a run that quietly stopped short would read as "the
        // whole catalogue is clean".
        log.warn?.(
          `reconcile: checking ${checking.length} of ${emptyImageProducts.length} image-less ` +
            `product(s) this run (cap ${EMPTY_IMAGES_MAX_PER_RUN}); the rest are left for the ` +
            'next one.',
        );
      }
      for (const unleashedProduct of checking) {
        await syncOne(unleashedProduct, true);
      }
    } else {
      // Could not establish that the feed is returning image data at all. Left
      // alone, which is what this did unconditionally before 2026-08-21.
      log.warn?.(
        `reconcile: ${emptyImageProducts.length} product(s) list no images, but ` +
          `${evidence.detail} — not enough to rule out an Unleashed fault, so none were ` +
          'touched. The next run will look again.',
      );
    }
  }

  return finish({ results, scanned, withImagesSeen, sinceIso, truncated: false, lastPage, config });

  /**
   * @param {object} unleashedProduct
   * @param {boolean} [emptyImagesConfirmed]
   */
  async function syncOne(unleashedProduct, emptyImagesConfirmed = false) {
    try {
      const result = await syncUnleashedProduct({
        unleashedProduct,
        shopify,
        config,
        log,
        emptyImagesConfirmed,
      });
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

/**
 * Duplicated pictures seen during the run, each counted once.
 *
 * Several Unleashed product codes routinely resolve to ONE Shopify product
 * (18K101-3, -4, -5 … all being sizes of one ring), and each is visited
 * separately against the same page and the same metafield. Keying on the Shopify
 * product id collapses those back to a single finding — otherwise a five-variant
 * chain would report its one duplicate five times.
 *
 * Last observation wins: on a live pass a later sibling looked more recently.
 *
 * @param {object[]} results
 */
function collectDuplicates(results) {
  const byProduct = new Map();
  for (const result of results) {
    if (!result.duplicates) continue;
    byProduct.set(result.duplicates.productId, {
      ...result.duplicates,
      productCode: result.productCode ?? null,
    });
  }

  const products = [...byProduct.values()].sort(
    (a, b) =>
      b.groups.reduce((n, g) => n + g.copies.length - 1, 0) -
      a.groups.reduce((n, g) => n + g.copies.length - 1, 0),
  );

  return { ...summariseDuplicateGroups(products), products };
}

/**
 * Products whose media was actually fetched — the honest denominator for a
 * duplicate count. `unmatched` and `ambiguous` return before `getProduct`, and
 * products with no Unleashed images never reach the sync at all.
 *
 * @param {object[]} results
 */
function countChecked(results) {
  const unchecked = [SYNC_OUTCOME.UNMATCHED, SYNC_OUTCOME.AMBIGUOUS, SYNC_OUTCOME.NO_IMAGES];
  return results.filter((result) => !unchecked.includes(result.outcome)).length;
}

/**
 * Decides whether an empty `Images[]` can be believed.
 *
 * The run's own window is the cheap answer and usually the wrong one: a ten
 * minute slice of a catalogue this size routinely holds a handful of products
 * and none with photos, which would leave a deleted last image sitting on the
 * website until it aged out of the window and stopped being visited at all.
 *
 * So when the window cannot vouch for the feed, ask the catalogue directly —
 * one unfiltered page, no `modifiedSince`. Products carrying images in that page
 * prove Unleashed is returning image data right now, which is the only thing
 * that needs proving; a fault serving stripped products fails it. One request,
 * and only on runs that saw an empty list.
 *
 * @param {{ withImagesSeen: number, unleashed: object, log: object }} input
 * @returns {Promise<{ corroborated: boolean, detail: string }>}
 */
async function corroborateEmptyImages({ withImagesSeen, unleashed, log }) {
  if (withImagesSeen >= EMPTY_IMAGES_CORROBORATION_MIN) {
    return {
      corroborated: true,
      detail: `${withImagesSeen} other(s) in this run came back with images`,
    };
  }

  try {
    let probed = 0;
    let withImages = 0;
    for await (const { items } of unleashed.iterateProducts({
      maxPages: 1,
      warnOnTruncation: false,
    })) {
      probed += items.length;
      withImages += items.filter((item) => (item?.Images ?? []).length > 0).length;
    }
    return {
      corroborated: withImages >= EMPTY_IMAGES_CORROBORATION_MIN,
      detail:
        `${withImages} of ${probed} product(s) in a catalogue probe carry images ` +
        `(${withImagesSeen} in this run's own window)`,
    };
  } catch (error) {
    // A probe that cannot be taken is not evidence of anything. Say so and do
    // nothing — never the other way round.
    log.warn?.(`reconcile: catalogue probe failed — ${error.message}`);
    return { corroborated: false, detail: `the catalogue probe failed (${error.message})` };
  }
}

function finish({ results, scanned, withImagesSeen, sinceIso, truncated, lastPage, config }) {
  const morePages = lastPage && lastPage.pageNumber < lastPage.totalPages;
  return {
    sinceIso: sinceIso ?? null,
    scanned,
    // Products that actually had images, not the size of `results` — image-less
    // products now enter `results` too when the run corroborates them.
    withImages: withImagesSeen,
    truncated,
    lastPage: lastPage?.pageNumber ?? null,
    totalPages: lastPage?.totalPages ?? null,
    /** Where to resume; null when the catalogue is exhausted. */
    nextStartPage: morePages ? lastPage.pageNumber + 1 : null,
    byOutcome: summarise(results),
    /**
     * Carried separately from `details` on purpose: a duplicate usually sits on a
     * product whose outcome is `unchanged`, and `details` drops those as noise.
     */
    duplicates: { ...collectDuplicates(results), productsChecked: countChecked(results) },
    /**
     * Whether removal was on for this run. A retained image means two different
     * things depending on it — a deliberate steady state, or a detach that did
     * not take — and only the second is worth a verdict.
     */
    removalEnabled: Boolean(config?.deleteRemovedMedia),
    /** Only the interesting ones — unchanged products are the bulk and are noise. */
    details: results.filter((result) => result.outcome !== SYNC_OUTCOME.UNCHANGED),
  };
}
