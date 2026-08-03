import { AUDIT_MAX_PAGES, AUDIT_PAGE_SIZE, NEAR_MISS_PREFIX } from '../constants/index.js';

/**
 * Whole-catalogue audit of Unleashed products whose images can never appear on
 * the website, because no Shopify variant carries their product code as a SKU.
 *
 * The daily report cannot find these: it only looks at products modified in the
 * last 24 hours, so a product that has been mismatched for months never comes
 * back round. Left alone the list quietly rots — the images exist, someone
 * photographed them, and nothing on the site will ever show them.
 *
 * Deliberately a set difference rather than a sync pass. Reading every Shopify
 * SKU once (~25 requests) and diffing in memory replaces one Shopify lookup per
 * Unleashed product (thousands), which is both slower than a function timeout
 * allows and far heavier on the API.
 */

/** @param {unknown} value */
export function normaliseCode(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Groups SKUs by leading characters so near-miss lookup does not rescan the
 * whole store for every unmatched code.
 *
 * @param {Iterable<string>} skuKeys
 * @returns {Map<string, string[]>}
 */
export function buildPrefixIndex(skuKeys) {
  const index = new Map();
  for (const sku of skuKeys) {
    const prefix = sku.slice(0, NEAR_MISS_PREFIX);
    const bucket = index.get(prefix);
    if (bucket) bucket.push(sku);
    else index.set(prefix, [sku]);
  }
  return index;
}

/**
 * Finds a Shopify SKU that is almost the Unleashed code.
 *
 * The real mismatches in this catalogue are suffixes on one side or the other —
 * `18KDSC10` against `18KDSC10W`, `9KTFY055` against `9KTFY05542CM` — so a
 * containment test in both directions catches them and a typo-distance metric
 * would only add false suggestions.
 *
 * @param {string} code Already normalised.
 * @param {Map<string, string[]>} index
 * @returns {string | null}
 */
export function findNearMiss(code, index) {
  if (code.length < NEAR_MISS_PREFIX) return null;

  const candidates = index.get(code.slice(0, NEAR_MISS_PREFIX)) ?? [];
  let best = null;
  for (const sku of candidates) {
    if (sku === code) continue;
    if (!sku.startsWith(code) && !code.startsWith(sku)) continue;
    // Prefer the closest in length — the smallest edit someone has to reason about.
    if (best === null || Math.abs(sku.length - code.length) < Math.abs(best.length - code.length)) {
      best = sku;
    }
  }
  return best;
}

/**
 * Pure diff of Unleashed products against the Shopify SKU set.
 *
 * Only products that actually hold images are considered: a product with no
 * images has nothing to lose by being unmatched, and including them would bury
 * the actionable list under inventory that was never going to show a photo.
 *
 * @param {{ products: object[], skus: Map<string, object> }} input
 */
export function diffCatalogue({ products, skus }) {
  const index = buildPrefixIndex(skus.keys());
  const unmatched = [];
  const duplicates = [];
  let withImages = 0;
  let matched = 0;

  for (const product of products) {
    const imageCount = (product?.Images ?? []).length;
    if (imageCount === 0) continue;
    withImages += 1;

    const code = normaliseCode(product?.ProductCode);
    const hit = code ? skus.get(code) : null;

    if (hit) {
      matched += 1;
      if (hit.productCount > 1) {
        duplicates.push({
          productCode: product.ProductCode,
          description: product?.ProductDescription ?? '',
          productCount: hit.productCount,
        });
      }
      continue;
    }

    unmatched.push({
      productCode: product?.ProductCode ?? '',
      description: product?.ProductDescription ?? '',
      imageCount,
      suggestion: findNearMiss(code, index) ?? '',
    });
  }

  // Near-misses first: a one-character SKU fix is the cheapest thing the team
  // can action, so it should not be buried under products genuinely absent.
  unmatched.sort((a, b) => {
    if (Boolean(b.suggestion) !== Boolean(a.suggestion)) return b.suggestion ? 1 : -1;
    return b.imageCount - a.imageCount;
  });

  return { withImages, matched, unmatched, duplicates };
}

/**
 * Runs the audit against the live APIs.
 *
 * @param {{ unleashed: object, shopify: object, log?: object, pageSize?: number, maxPages?: number }} input
 */
export async function auditCatalogue({
  unleashed,
  shopify,
  log = console,
  pageSize = AUDIT_PAGE_SIZE,
  maxPages = AUDIT_MAX_PAGES,
}) {
  const skus = await shopify.listAllVariantSkus();

  const products = [];
  let pagesRead = 0;
  let truncated = false;

  // No `sinceIso`: the whole point is the backlog, not recent changes.
  for await (const page of unleashed.iterateProducts({ pageSize, maxPages })) {
    products.push(...page.items);
    pagesRead = page.pageNumber;
    if (page.pageNumber >= maxPages && page.pageNumber < page.totalPages) truncated = true;
    log.info?.(`audit: page ${page.pageNumber}/${page.totalPages} — ${products.length} so far`);
  }

  const diff = diffCatalogue({ products, skus });

  return {
    scanned: products.length,
    skuCount: skus.size,
    pagesRead,
    truncated,
    ...diff,
  };
}
