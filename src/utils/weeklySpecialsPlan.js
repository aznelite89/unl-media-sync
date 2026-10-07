import {
  DESIGN_FAMILY_KEY_PREFIX,
  DESIGN_SIZE_SUFFIXES,
  LETTER_PENDANT_TYPE_WORD,
  LETTER_SUFFIX,
  MS_PER_DAY,
  MS_PER_WEEK,
  NO_BIN_LOCATIONS,
  SPECIALS_WEEK_START_OFFSET_MS,
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

/** Lowercased and trimmed, for matching supplier names and bins without case. */
const fold = (value) => String(value ?? '').trim().toLowerCase();

/**
 * What relates a product to others: its bin location in `warehouseCode`
 * (the office finds related stock by bin, e.g. bin `FSY050` holds the 9k and
 * 18k Franco chains in every length), or, with no bin, its design family.
 *
 * @param {object} product Unleashed product with `InventoryDetails`
 * @param {string} warehouseCode
 * @param {string} [productType] Shopify product type
 */
export function relatedKey(product, warehouseCode, productType = '') {
  const detail = (product?.InventoryDetails ?? []).find(
    (row) => row?.Warehouse?.WarehouseCode === warehouseCode,
  );
  const bin = fold(detail?.BinLocation);
  if (!NO_BIN_LOCATIONS.includes(bin)) return bin;
  return DESIGN_FAMILY_KEY_PREFIX + designFamily(product?.ProductCode, productType);
}

/**
 * Whether a supplier is one Searay still buys from.
 *
 * @param {object} product Unleashed product
 * @param {Set<string>} currentSuppliers lowercased supplier names
 */
export function fromCurrentSupplier(product, currentSuppliers) {
  return currentSuppliers.has(fold(product?.Supplier?.SupplierName));
}

/**
 * A number that is fixed for a code within one week and reshuffles the next
 * (FNV-1a). Most specials tie on landed date and last sale, so this decides
 * which of them show; without it the same ones would show every week.
 *
 * @param {string} code
 * @param {number} nowMs
 */
export function weeklyShuffle(code, nowMs) {
  const text = `${Math.floor((nowMs - SPECIALS_WEEK_START_OFFSET_MS) / MS_PER_WEEK)}:${code}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash;
}

/** Oldest landed first (no receipt = landed before Unleashed), then longest unsold design, then this week's shuffle. */
function oldestFirst(a, b) {
  return (
    (a.landedMs ?? -Infinity) - (b.landedMs ?? -Infinity) ||
    (b.designDaysSinceSale ?? Infinity) - (a.designDaysSinceSale ?? Infinity) ||
    a.shuffle - b.shuffle ||
    a.code.localeCompare(b.code)
  );
}

/**
 * Which Shopify products are this week's specials, and the tag changes that
 * get there.
 *
 * A website product qualifies when, across all its Unleashed codes:
 *   - one of them is in stock in the warehouse,
 *   - every one comes from a supplier not in `currentSuppliers`,
 *   - nothing related to any of them (same bin, see `relatedKey`) sold in the
 *     last `unsoldMonths` months,
 *   - the first was created before then (a new product has not had the chance), and
 *   - its product type is in one of the four categories.
 * They are ranked oldest landed first, then longest unsold, then by a
 * shuffle that changes weekly, one per bin, and the first `perCategory` of
 * each category are picked. `rank` on each pick is its place
 * in the collection.
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
 *   warehouseCode: string,
 *   currentSuppliers: Set<string>,
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
  warehouseCode,
  currentSuppliers,
  force = false,
}) {
  const ambiguous = [];
  const listings = new Map();
  // Most recent sale of anything related, in days ago; absent = never sold.
  const relatedDaysSinceSale = new Map();

  for (const product of products) {
    if (product?.Obsolete) continue;
    const code = normaliseCode(product?.ProductCode);
    if (!code) continue;
    const match = skus.get(code);
    const key = relatedKey(product, warehouseCode, match?.productType);
    const days = daysSinceSale.get(code) ?? null;
    if (days !== null) relatedDaysSinceSale.set(key, Math.min(days, relatedDaysSinceSale.get(key) ?? Infinity));

    if (!match?.productId) continue;
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
      key,
      supplier: product?.Supplier?.SupplierName ?? '',
      current: fromCurrentSupplier(product, currentSuppliers),
      createdMs: parseUnleashedDate(product?.CreatedOn),
      qty: Number(warehouseQty.get(code) ?? 0),
      landedMs: landed.get(code) ?? null,
    });
  }

  const soldSinceDays = (nowMs - cutoffMs) / MS_PER_DAY;
  const candidates = new Map(SPECIAL_CATEGORY_ORDER.map((category) => [category, []]));

  for (const listing of listings.values()) {
    if (!listing.onWebsite) continue;
    const category = specialCategory(listing.productType);
    if (!category) continue;
    const inStock = listing.codes.filter((entry) => entry.qty > 0);
    if (inStock.length === 0) continue;
    if (listing.codes.some((entry) => entry.current)) continue;
    const keys = [...new Set(listing.codes.map((entry) => entry.key))];
    const designDays = keys
      .map((key) => relatedDaysSinceSale.get(key))
      .filter((days) => days !== undefined);
    const designDaysSinceSale = designDays.length ? Math.min(...designDays) : null;
    if (designDaysSinceSale !== null && designDaysSinceSale < soldSinceDays) continue;
    const created = listing.codes.map((entry) => entry.createdMs).filter((ms) => ms !== null);
    if (created.length === 0 || Math.min(...created) > cutoffMs) continue;

    const dated = listing.codes.filter((entry) => entry.landedMs !== null);
    const landedMs = dated.length ? Math.max(...dated.map((entry) => entry.landedMs)) : null;
    candidates.get(category).push({
      productId: listing.productId,
      title: listing.title,
      category,
      code: inStock[0].productCode,
      supplier: inStock[0].supplier,
      landedMs,
      designDaysSinceSale,
      shuffle: weeklyShuffle(inStock[0].code, nowMs),
      keys,
    });
  }

  const wanted = new Map();
  const shortfalls = [];
  for (const [category, list] of candidates) {
    list.sort(oldestFirst);
    const seen = new Set();
    let picked = 0;
    for (const candidate of list) {
      if (picked >= perCategory) break;
      if (candidate.keys.some((key) => seen.has(key))) continue;
      for (const key of candidate.keys) seen.add(key);
      wanted.set(candidate.productId, candidate);
      picked += 1;
    }
    if (picked < perCategory) shortfalls.push({ category, picked, wanted: perCategory });
  }
  [...wanted.values()].sort(oldestFirst).forEach((entry, index) => {
    entry.rank = index;
  });

  const add = [...wanted.values()].filter((entry) => !tagged.has(entry.productId));
  const remove = [...tagged].filter((productId) => !wanted.has(productId));
  // An empty pick is a failed read, not a week with no slow stock: keep last week's.
  const removalHeld = !force && wanted.size === 0 && remove.length > 0;

  return {
    wanted,
    add,
    remove: removalHeld ? [] : remove,
    heldRemovals: removalHeld ? remove : [],
    shortfalls,
    ambiguous,
    qualifying: [...candidates.values()].reduce((sum, list) => sum + list.length, 0),
  };
}
