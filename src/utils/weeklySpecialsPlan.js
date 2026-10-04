import {
  DESIGN_SIZE_SUFFIXES,
  LETTER_PENDANT_TYPE_WORD,
  LETTER_SUFFIX,
  MS_PER_DAY,
  SPECIAL_CATEGORY_ORDER,
  SPECIAL_CATEGORY_TYPE_WORDS,
} from '../constants/index.js';
import { normaliseCode } from './audit.js';
import { parseUnleashedDate } from './customerNotesPlan.js';

/**
 * Pure decisions for This Week Specials: no network, so self-test covers them.
 */

/**
 * When each product code last landed: the latest receipt date of a purchase
 * order line that received some of it.
 *
 * @param {object[]} purchaseOrders Unleashed purchase orders with their lines
 * @returns {Map<string, number>} code (lowercased) to receipt time
 */
export function landedDates(purchaseOrders) {
  const landed = new Map();
  for (const order of purchaseOrders) {
    const receivedMs = parseUnleashedDate(order?.ReceivedDate);
    if (receivedMs === null) continue;
    for (const line of order?.PurchaseOrderLines ?? []) {
      if (!(Number(line?.ReceiptQuantity) > 0)) continue;
      const code = normaliseCode(line?.Product?.ProductCode);
      if (code && receivedMs > (landed.get(code) ?? -Infinity)) landed.set(code, receivedMs);
    }
  }
  return landed;
}

/**
 * The specials category for a Shopify product type, or null when it is in none
 * of the four (findings, testers, services).
 *
 * @param {string} productType
 */
export function specialCategory(productType) {
  const type = String(productType ?? '').toLowerCase();
  for (const [category, words] of SPECIAL_CATEGORY_TYPE_WORDS) {
    if (words.some((word) => type.includes(word))) return category;
  }
  return null;
}

/**
 * A code without its chain length, ring size or pendant letter, so the
 * variations of one design count as one piece.
 *
 * @param {string} code
 * @param {string} [productType] Shopify product type
 */
export function designFamily(code, productType = '') {
  const family = DESIGN_SIZE_SUFFIXES.reduce((rest, suffix) => rest.replace(suffix, ''), normaliseCode(code));
  return String(productType).toLowerCase().includes(LETTER_PENDANT_TYPE_WORD)
    ? family.replace(LETTER_SUFFIX, '')
    : family;
}

/**
 * Index a stock-on-hand list by code.
 *
 * @param {object[]} rows
 * @param {(row: object) => unknown} pick
 */
export function byCode(rows, pick) {
  const map = new Map();
  for (const row of rows) {
    const code = normaliseCode(row?.ProductCode);
    if (code) map.set(code, pick(row));
  }
  return map;
}

/**
 * Which Shopify products are this week's specials, and the tag changes that
 * get there.
 *
 * A website product qualifies when, across all its Unleashed codes:
 *   - one of them is in stock in the warehouse,
 *   - none sold in the last `unsoldMonths` months,
 *   - the first was created before then (a new product has not had the chance), and
 *   - its product type is in one of the four categories.
 * Qualifying products with no purchase order receipt cannot be ranked by
 * landed date; they are returned as `undated` for the office and left out.
 * The rest are ranked most recently landed first, one size per design, and
 * the first `perCategory` of each category are picked.
 *
 * @param {{
 *   products: object[],
 *   daysSinceSale: Map<string, number | null>,
 *   warehouseQty: Map<string, number>,
 *   landed: Map<string, number>,
 *   skus: Map<string, { productId: string, title: string, productCount: number, productType: string, onWebsite: boolean }>,
 *   tagged: Set<string>,
 *   nowMs: number,
 *   cutoffMs: number,
 *   perCategory: number,
 *   force?: boolean,
 * }} input
 */
export function planWeeklySpecials({
  products,
  daysSinceSale,
  warehouseQty,
  landed,
  skus,
  tagged,
  nowMs,
  cutoffMs,
  perCategory,
  force = false,
}) {
  const ambiguous = [];
  const listings = new Map();

  for (const product of products) {
    if (product?.Obsolete) continue;
    const code = normaliseCode(product?.ProductCode);
    const match = skus.get(code);
    if (!code || !match?.productId) continue;
    if (match.productCount > 1) {
      ambiguous.push(code);
      continue;
    }
    let listing = listings.get(match.productId);
    if (!listing) {
      listing = { ...match, codes: [] };
      listings.set(match.productId, listing);
    }
    listing.codes.push({
      code,
      productCode: product.ProductCode,
      description: product.ProductDescription ?? '',
      createdMs: parseUnleashedDate(product?.CreatedOn),
      daysSinceSale: daysSinceSale.get(code) ?? null,
      qty: Number(warehouseQty.get(code) ?? 0),
      landedMs: landed.get(code) ?? null,
    });
  }

  const soldSinceDays = (nowMs - cutoffMs) / MS_PER_DAY;
  const candidates = new Map(SPECIAL_CATEGORY_ORDER.map((category) => [category, []]));
  const undated = [];

  for (const listing of listings.values()) {
    if (!listing.onWebsite) continue;
    const category = specialCategory(listing.productType);
    if (!category) continue;
    const inStock = listing.codes.filter((entry) => entry.qty > 0);
    if (inStock.length === 0) continue;
    if (listing.codes.some((entry) => entry.daysSinceSale !== null && entry.daysSinceSale < soldSinceDays)) continue;
    const created = listing.codes.map((entry) => entry.createdMs).filter((ms) => ms !== null);
    if (created.length === 0 || Math.min(...created) > cutoffMs) continue;

    const newest = listing.codes
      .filter((entry) => entry.landedMs !== null)
      .sort((a, b) => b.landedMs - a.landedMs)[0];
    const entry = { productId: listing.productId, title: listing.title, category };
    if (!newest) {
      undated.push({
        ...entry,
        productCodes: inStock.map((code) => code.productCode),
        description: inStock[0].description,
      });
      continue;
    }
    candidates.get(category).push({
      ...entry,
      code: newest.productCode,
      landedMs: newest.landedMs,
      family: designFamily(newest.code, listing.productType),
    });
  }

  const wanted = new Map();
  const shortfalls = [];
  for (const [category, list] of candidates) {
    list.sort((a, b) => b.landedMs - a.landedMs || a.code.localeCompare(b.code));
    const families = new Set();
    let picked = 0;
    for (const candidate of list) {
      if (picked >= perCategory) break;
      if (families.has(candidate.family)) continue;
      families.add(candidate.family);
      wanted.set(candidate.productId, candidate);
      picked += 1;
    }
    if (picked < perCategory) shortfalls.push({ category, picked, wanted: perCategory });
  }

  undated.sort(
    (a, b) =>
      SPECIAL_CATEGORY_ORDER.indexOf(a.category) - SPECIAL_CATEGORY_ORDER.indexOf(b.category) ||
      a.productCodes[0].localeCompare(b.productCodes[0]),
  );

  const add = [...wanted.values()].filter((entry) => !tagged.has(entry.productId));
  const remove = [...tagged].filter((productId) => !wanted.has(productId));
  // An empty pick is a failed read, not a week with no slow stock: keep last week's.
  const removalHeld = !force && wanted.size === 0 && remove.length > 0;

  return {
    wanted,
    add,
    remove: removalHeld ? [] : remove,
    heldRemovals: removalHeld ? remove : [],
    undated,
    shortfalls,
    ambiguous,
    qualifying: [...candidates.values()].reduce((sum, list) => sum + list.length, 0) + undated.length,
  };
}
