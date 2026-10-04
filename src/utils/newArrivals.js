import {
  AUDIT_MAX_PAGES,
  AUDIT_PAGE_SIZE,
  COLLECTION_SORT_MANUAL,
  NEW_ARRIVAL_COLLECTION_MAX_PRODUCTS,
  NEW_ARRIVAL_OUTCOME,
  NEW_ARRIVAL_TAG,
  SMART_COLLECTION_SETTLE_MS,
} from '../constants/index.js';
import { toUnleashedSince } from './customerNotesPlan.js';
import { sleep } from './http.js';
import { summarise } from './logger.js';
import { newArrivalCutoff, newestFirst, planNewArrivals, recentCodes, reorderMoves } from './newArrivalsPlan.js';

/**
 * Every Unleashed product created since `cutoffMs`.
 *
 * Filtered on `modifiedSince` first: a product is never modified before it is
 * created, so this cannot drop one, and it skips most of the 2024 catalogue.
 * A walk that stops short of the last page throws rather than returning a
 * partial list, because a partial list would take the tag off products that
 * are still new.
 */
export async function readRecentUnleashed({ unleashed, cutoffMs }) {
  const sinceIso = toUnleashedSince(cutoffMs);
  const products = [];
  let lastPage = 0;
  let totalPages = 0;
  for await (const page of unleashed.iterateProducts({
    sinceIso,
    pageSize: AUDIT_PAGE_SIZE,
    maxPages: AUDIT_MAX_PAGES,
  })) {
    products.push(...page.items);
    lastPage = page.pageNumber;
    totalPages = page.totalPages;
  }
  if (lastPage < totalPages) {
    throw new Error(`Unleashed walk stopped at page ${lastPage} of ${totalPages}`);
  }
  return { products, scanned: products.length, sinceIso };
}

/** The fields a New Arrivals result row carries besides its outcome. */
const describeNewArrival = (change) => ({
  code: change.code ?? '',
  title: change.title ?? '',
  created: change.createdMs ? new Date(change.createdMs).toISOString().slice(0, 10) : '',
});

/**
 * Adds `tag` to `plan.add` and takes it off `plan.remove`, one product at a
 * time so one failure does not stop the rest. Shared by the jobs that keep a
 * tag-driven collection: `describe` picks the fields each result row carries.
 */
export async function applyTagChanges({
  plan,
  shopify,
  writes,
  log,
  tag = NEW_ARRIVAL_TAG,
  label = 'new arrivals',
  describe = describeNewArrival,
}) {
  const results = [];
  const changes = [
    ...plan.add.map((entry) => ({ ...entry, action: NEW_ARRIVAL_OUTCOME.TAGGED })),
    ...plan.remove.map((productId) => ({ productId, action: NEW_ARRIVAL_OUTCOME.UNTAGGED })),
  ];
  for (const change of changes) {
    const base = { productId: change.productId, ...describe(change) };
    if (!writes) {
      results.push({ ...base, outcome: NEW_ARRIVAL_OUTCOME.DRY_RUN, action: change.action });
      continue;
    }
    try {
      const write = change.action === NEW_ARRIVAL_OUTCOME.TAGGED ? shopify.addTags : shopify.removeTags;
      await write({ productId: change.productId, tags: [tag] });
      results.push({ ...base, outcome: change.action });
    } catch (error) {
      log.warn?.(`${label}: ${change.action} ${change.productId} failed — ${error.message}`);
      results.push({ ...base, outcome: NEW_ARRIVAL_OUTCOME.FAILED, action: change.action, error: error.message });
    }
  }
  return results;
}

/**
 * Puts the collection newest first by `dateOf` each wanted entry. Only when it
 * is sorted manually: any other sort means someone chose it in Shopify admin,
 * and Shopify would refuse the moves anyway.
 */
export async function orderCollection({
  shopify,
  handle,
  wanted,
  writes,
  log,
  label = 'new arrivals',
  dateOf,
}) {
  const collection = await shopify.getCollectionProducts(handle, {
    maxProducts: NEW_ARRIVAL_COLLECTION_MAX_PRODUCTS,
  });
  if (!collection) return { status: `collection "${handle}" not found` };
  if (collection.sortOrder !== COLLECTION_SORT_MANUAL) {
    return { status: `sorted ${collection.sortOrder}, left alone`, products: collection.productIds.length };
  }

  const desired = newestFirst(collection.productIds, wanted, dateOf);
  const moves = reorderMoves(collection.productIds, desired);
  if (moves.length === 0) return { status: 'already newest first', products: desired.length };
  if (!writes) return { status: `would move ${moves.length}`, products: desired.length };

  await shopify.reorderCollection({ collectionId: collection.id, moves });
  log.info?.(`${label}: reordered ${moves.length} of ${desired.length} in "${handle}"`);
  return { status: `moved ${moves.length}`, products: desired.length };
}

/**
 * Tags products created in Unleashed in the last `config.newArrivalMonths`
 * months with `new-arrival`, untags the ones that aged out, then orders the
 * collection newest first. The collection's own rule adds "in stock".
 *
 * `apply` is the write switch; `config.dryRun` wins over it.
 *
 * @param {{ unleashed: object, shopify: object, config: object, log: object, apply: boolean, force?: boolean, nowMs?: number, settleMs?: number }} input
 */
export async function syncNewArrivals({
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
  const cutoffMs = newArrivalCutoff(nowMs, config.newArrivalMonths);

  const { products, scanned, sinceIso } = await readRecentUnleashed({ unleashed, cutoffMs });
  const recent = recentCodes(products, cutoffMs);
  const [skus, tagged] = await Promise.all([
    shopify.listAllVariantSkus(),
    shopify.listProductIdsWithTag(NEW_ARRIVAL_TAG),
  ]);

  const plan = planNewArrivals({ recent, skus, tagged, force });
  if (plan.heldRemovals.length) {
    log.warn?.(
      `new arrivals: held back ${plan.heldRemovals.length} tag removals of ${tagged.size} tagged — ` +
        'too many at once to be ageing out; check the Unleashed read',
    );
  }

  const results = await applyTagChanges({ plan, shopify, writes, log });
  const tagsChanged = results.some((result) => result.outcome !== NEW_ARRIVAL_OUTCOME.DRY_RUN);
  if (tagsChanged && settleMs > 0) await sleep(settleMs);

  let ordering;
  try {
    ordering = await orderCollection({
      shopify,
      handle: config.newArrivalCollectionHandle,
      wanted: plan.wanted,
      writes,
      log,
    });
  } catch (error) {
    ordering = { status: `failed — ${error.message}` };
  }

  return {
    cutoff: new Date(cutoffMs).toISOString().slice(0, 10),
    sinceIso,
    scanned,
    recent: recent.size,
    wanted: plan.wanted.size,
    taggedBefore: tagged.size,
    unmatched: plan.unmatched,
    ambiguous: plan.ambiguous,
    heldRemovals: plan.heldRemovals,
    results,
    byOutcome: summarise(results),
    ordering,
    dryRun: !writes,
  };
}
