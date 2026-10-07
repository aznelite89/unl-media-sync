import {
  LANDED_BEFORE_UNLEASHED,
  MS_PER_DAY,
  NO_SALE_ON_RECORD,
  SMART_COLLECTION_SETTLE_MS,
  SPECIAL_CATEGORY_ORDER,
  WEEKLY_SPECIAL_OUTCOME,
  WEEKLY_SPECIAL_TAG,
} from '../constants/index.js';
import { sleep } from './http.js';
import { summarise } from './logger.js';
import { applyTagChanges, orderCollection } from './newArrivals.js';
import { newArrivalCutoff } from './newArrivalsPlan.js';
import { byCode, landedDates, planWeeklySpecials } from './weeklySpecialsPlan.js';

const LABEL = 'weekly specials';

const toDay = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

const describeSpecial = (change) => ({
  code: change.code ?? '',
  title: change.title ?? '',
  category: change.category ?? '',
  landed: change.landedMs ? toDay(change.landedMs) : LANDED_BEFORE_UNLEASHED,
});

/**
 * Picks this week's specials and moves the `weekly-special` tag onto them:
 * `config.weeklySpecialsPerCategory` products from each category, from stock
 * in the warehouse from a supplier not in `config.weeklySpecialsCurrentSuppliers`,
 * where nothing in the same bin has sold in `config.weeklySpecialsUnsoldMonths`
 * months, oldest landed first. Then orders the collection the same way.
 * The collection's own rule adds "in stock", so a piece that sells mid-week
 * drops off.
 *
 * `apply` is the write switch; `config.dryRun` wins over it.
 *
 * @param {{ unleashed: object, shopify: object, config: object, log: object, apply: boolean, force?: boolean, nowMs?: number, settleMs?: number }} input
 */
export async function syncWeeklySpecials({
  unleashed,
  shopify,
  config,
  log,
  apply,
  force = false,
  nowMs = Date.now(),
  settleMs = SMART_COLLECTION_SETTLE_MS,
}) {
  const writes = apply && !config.dryRun;
  const cutoffMs = newArrivalCutoff(nowMs, config.weeklySpecialsUnsoldMonths);

  // Unleashed one call at a time; it throttles bursts. Shopify alongside.
  const shopifyReads = Promise.all([shopify.listAllVariantSkus(), shopify.listProductIdsWithTag(WEEKLY_SPECIAL_TAG)]);
  const products = await unleashed.listProducts();
  const allWarehouses = await unleashed.listStockOnHand();
  const warehouse = await unleashed.listStockOnHand({ warehouseCode: config.weeklySpecialsWarehouse });
  const purchaseOrders = await unleashed.listPurchaseOrders();
  const [skus, tagged] = await shopifyReads;

  const plan = planWeeklySpecials({
    products,
    daysSinceSale: byCode(allWarehouses, (row) => row?.DaysSinceLastSale ?? null),
    warehouseQty: byCode(warehouse, (row) => Number(row?.QtyOnHand ?? 0)),
    landed: landedDates(purchaseOrders),
    skus,
    tagged,
    nowMs,
    cutoffMs,
    perCategory: config.weeklySpecialsPerCategory,
    warehouseCode: config.weeklySpecialsWarehouse,
    currentSuppliers: new Set(config.weeklySpecialsCurrentSuppliers.map((name) => name.trim().toLowerCase())),
    force,
  });
  if (plan.heldRemovals.length) {
    log.warn?.(
      `${LABEL}: nothing qualified, so last week's ${plan.heldRemovals.length} stay — check the Unleashed read`,
    );
  }

  const results = await applyTagChanges({
    plan,
    shopify,
    writes,
    log,
    tag: WEEKLY_SPECIAL_TAG,
    label: LABEL,
    describe: describeSpecial,
  });
  const tagsChanged = results.some((result) => result.outcome !== WEEKLY_SPECIAL_OUTCOME.DRY_RUN);
  if (tagsChanged && settleMs > 0) await sleep(settleMs);

  let ordering;
  try {
    ordering = await orderCollection({
      shopify,
      handle: config.weeklySpecialsCollectionHandle,
      wanted: plan.wanted,
      writes,
      log,
      label: LABEL,
      // Ascending rank: the orderer puts the largest value first.
      dateOf: (entry) => -entry.rank,
    });
  } catch (error) {
    ordering = { status: `failed — ${error.message}` };
  }

  const specials = [...plan.wanted.values()]
    .sort(
      (a, b) =>
        SPECIAL_CATEGORY_ORDER.indexOf(a.category) - SPECIAL_CATEGORY_ORDER.indexOf(b.category) || a.rank - b.rank,
    )
    .map((entry) => ({
      ...entry,
      landed: entry.landedMs ? toDay(entry.landedMs) : LANDED_BEFORE_UNLEASHED,
      lastSold:
        entry.designDaysSinceSale === null
          ? NO_SALE_ON_RECORD
          : toDay(nowMs - entry.designDaysSinceSale * MS_PER_DAY),
    }));

  return {
    unsoldSince: toDay(cutoffMs),
    perCategory: config.weeklySpecialsPerCategory,
    warehouse: config.weeklySpecialsWarehouse,
    currentSuppliers: config.weeklySpecialsCurrentSuppliers,
    scanned: products.length,
    qualifying: plan.qualifying,
    specials,
    shortfalls: plan.shortfalls,
    ambiguous: plan.ambiguous,
    taggedBefore: tagged.size,
    heldRemovals: plan.heldRemovals,
    results,
    byOutcome: summarise(results),
    ordering,
    dryRun: !writes,
  };
}
