import {
  MEDIA_ORIGIN,
  MEDIA_STATUS,
  STATE_VERSION,
  SYNC_OUTCOME,
} from '../constants/index.js';
import { imageKey, isSameImage, orderedUnleashedImages } from './imageIdentity.js';

/**
 * Reads the state this service wrote on a previous run. Anything malformed is
 * treated as "no state" — the reconciler can always rebuild it by adoption.
 *
 * @param {{ value?: string } | null} metafield
 */
export function parseState(metafield) {
  const empty = { version: STATE_VERSION, managed: [], syncedAt: null };
  if (!metafield?.value) return empty;

  try {
    const parsed = JSON.parse(metafield.value);
    if (!Array.isArray(parsed?.managed)) return empty;
    return {
      version: parsed.version ?? STATE_VERSION,
      syncedAt: parsed.syncedAt ?? null,
      managed: parsed.managed.filter((entry) => entry?.url && entry?.mediaId),
    };
  } catch {
    return empty;
  }
}

/**
 * Works out, without calling Shopify, what should happen to a product's media.
 *
 * Rules, in priority order:
 *  1. An image already tracked in state keeps its media — nothing is re-uploaded.
 *  2. An untracked image that matches existing Shopify media by filename is
 *     ADOPTED. This is what stops the first run duplicating the single image
 *     Unleashed's built-in connector already pushed.
 *  3. Anything left is uploaded.
 *  4. Media this service does not own is never removed, reordered away, or
 *     otherwise touched.
 *
 * MANY-TO-ONE: several Unleashed products routinely map to one Shopify product,
 * because alloy and size are Shopify *variant options* (e.g. 18K101-3 … -10 all
 * resolve to one product). They therefore share a single state metafield, so
 * every entry records the `productCode` that put it there. An image is resolved
 * against entries from ANY product code — reusing media beats duplicating it —
 * but only entries belonging to the CURRENT code are ever detach candidates.
 * Without that split, syncing -4 would detach -3's image and the two would
 * destroy each other's images on alternate runs.
 *
 * PAGE CAP: `maxMediaPerProduct` limits the TOTAL images on the Shopify product,
 * counting media the sync did not add. Uploads beyond the cap are skipped and
 * reported — nothing is ever removed to make room. Because `desired` is ordered
 * default-image-first, the image that survives the cut is the default one.
 *
 * @param {{ desired: Array<{url: string, isDefault: boolean}>, liveMedia: object[], state: object, productCode: string, maxMediaPerProduct?: number }} input
 */
export function planMediaChanges({
  desired,
  liveMedia,
  state,
  productCode,
  maxMediaPerProduct = Number.POSITIVE_INFINITY,
}) {
  const liveById = new Map(liveMedia.map((media) => [media.id, media]));

  // State entries whose media has since been deleted in Shopify are stale.
  const tracked = state.managed.filter((entry) => liveById.has(entry.mediaId));
  const trackedByKey = new Map(tracked.map((entry) => [imageKey(entry.url), entry]));
  const managedIds = new Set(tracked.map((entry) => entry.mediaId));
  const ownedByThisCode = tracked.filter((entry) => entry.productCode === productCode);

  const claimed = new Set();
  const resolved = [];
  const toUpload = [];

  for (const image of desired) {
    const key = imageKey(image.url);

    const trackedEntry = trackedByKey.get(key);
    if (trackedEntry && !claimed.has(trackedEntry.mediaId)) {
      claimed.add(trackedEntry.mediaId);
      resolved.push({
        url: image.url,
        mediaId: trackedEntry.mediaId,
        origin: trackedEntry.origin ?? MEDIA_ORIGIN.SYNCED,
        isDefault: image.isDefault,
        media: liveById.get(trackedEntry.mediaId),
      });
      continue;
    }

    const adoptable = liveMedia.find(
      (media) =>
        !claimed.has(media.id) &&
        !managedIds.has(media.id) &&
        isSameImage(media.image?.url, image.url),
    );
    if (adoptable) {
      claimed.add(adoptable.id);
      resolved.push({
        url: image.url,
        mediaId: adoptable.id,
        origin: MEDIA_ORIGIN.ADOPTED,
        isDefault: image.isDefault,
        media: adoptable,
      });
      continue;
    }

    toUpload.push(image);
  }

  // Only ever removable: media THIS product code put here that Unleashed dropped.
  // Entries owned by sibling product codes are deliberately excluded.
  const desiredKeys = new Set(desired.map((image) => imageKey(image.url)));
  const toDetach = ownedByThisCode.filter((entry) => !desiredKeys.has(imageKey(entry.url)));

  const unmanagedMedia = liveMedia.filter(
    (media) => !managedIds.has(media.id) && !claimed.has(media.id),
  );

  // Page cap. Adopted and already-tracked images are part of liveMedia, so they
  // occupy slots without needing one reserved.
  const capacity = Math.max(0, maxMediaPerProduct - liveMedia.length);
  const skippedForCap = toUpload.slice(capacity);
  const allowedUploads = toUpload.slice(0, capacity);

  const failedMedia = resolved.filter((entry) => entry.media?.status === MEDIA_STATUS.FAILED);

  // Media on this product owned by a sibling Unleashed product code.
  const siblingManaged = tracked.filter(
    (entry) => entry.productCode !== productCode && !claimed.has(entry.mediaId),
  );

  return {
    resolved,
    toUpload: allowedUploads,
    skippedForCap,
    mediaOnPage: liveMedia.length,
    toDetach,
    unmanagedMedia,
    siblingManaged,
    failedMedia,
    managedIds,
  };
}

/**
 * Syncs one Unleashed product's images into Shopify product media.
 *
 * @param {{
 *   unleashedProduct: object,
 *   shopify: import('./shopify.js').createShopifyClient extends (...a: any) => infer R ? R : never,
 *   config: object,
 *   log?: { info?: Function, warn?: Function, error?: Function },
 * }} input
 */
export async function syncUnleashedProduct({ unleashedProduct, shopify, config, log = console }) {
  const productCode = String(unleashedProduct?.ProductCode ?? '').trim();
  const result = {
    productCode,
    unleashedGuid: unleashedProduct?.Guid ?? null,
    outcome: SYNC_OUTCOME.FAILED,
    added: [],
    adopted: [],
    detached: [],
    reordered: false,
    notes: [],
  };

  if (!productCode) {
    result.notes.push('Unleashed product has no ProductCode');
    return result;
  }

  const desired = orderedUnleashedImages(unleashedProduct?.Images, config.maxSyncedImages);
  const totalImages = (unleashedProduct?.Images ?? []).length;
  if (totalImages > desired.length) {
    result.notes.push(
      `Unleashed holds ${totalImages} images; syncing the first ${desired.length} (cap ${config.maxSyncedImages}).`,
    );
  }

  if (desired.length === 0) {
    result.outcome = SYNC_OUTCOME.NO_IMAGES;
    return result;
  }

  const { products } = await shopify.findProductsBySku(productCode);
  if (products.length === 0) {
    result.outcome = SYNC_OUTCOME.UNMATCHED;
    result.notes.push('No Shopify variant carries this product code');
    return result;
  }
  if (products.length > 1) {
    result.outcome = SYNC_OUTCOME.AMBIGUOUS;
    result.notes.push(
      `Product code resolves to ${products.length} Shopify products: ${products
        .map((product) => product.id)
        .join(', ')}`,
    );
    return result;
  }

  const shopifyProductId = products[0].id;
  result.shopifyProductId = shopifyProductId;

  const product = await shopify.getProduct(shopifyProductId);
  const state = parseState(product.stateMetafield);
  const plan = planMediaChanges({
    desired,
    liveMedia: product.media,
    state,
    productCode,
    maxMediaPerProduct: config.maxMediaPerProduct,
  });
  const liveMediaIdsBefore = new Set(product.media.map((media) => media.id));
  result.mediaOnPage = plan.mediaOnPage;

  if (plan.skippedForCap.length > 0) {
    // Never silent: a skipped image must be visible in the run report.
    result.skippedForCap = plan.skippedForCap.map((image) => image.url);
    result.notes.push(
      `page cap reached (${plan.mediaOnPage}/${config.maxMediaPerProduct} images already on this product); ` +
        `skipped ${plan.skippedForCap.length} image(s) from ${productCode}`,
    );
    log.warn?.(
      `${productCode}: page cap ${config.maxMediaPerProduct} reached on ${shopifyProductId} — ` +
        `${plan.skippedForCap.length} image(s) not synced`,
    );
  }

  for (const failed of plan.failedMedia) {
    log.warn?.(
      `${productCode}: media ${failed.mediaId} is in FAILED state ` +
        `(${JSON.stringify(failed.media?.mediaErrors ?? [])}). Left in place — remove it in Shopify to retry.`,
    );
    result.notes.push(`media ${failed.mediaId} is FAILED in Shopify`);
  }

  const willDetach = config.deleteRemovedMedia ? plan.toDetach : [];
  if (!config.deleteRemovedMedia && plan.toDetach.length > 0) {
    result.notes.push(
      `${plan.toDetach.length} previously synced image(s) no longer in Unleashed, left in place (DELETE_REMOVED_MEDIA is off)`,
    );
  }

  // Reordering is skipped when hand-added media is present: forcing Unleashed's
  // order would move images someone deliberately arranged in Shopify. It is also
  // skipped when a sibling Unleashed product owns media here — otherwise each
  // sibling would shove its own images to the front on every run.
  const canReorder =
    config.reorderMedia &&
    plan.unmanagedMedia.length === 0 &&
    plan.siblingManaged.length === 0 &&
    plan.toUpload.length + plan.resolved.length > 1;
  if (config.reorderMedia && plan.unmanagedMedia.length > 0) {
    result.notes.push(
      `${plan.unmanagedMedia.length} media item(s) were not added by this sync; skipping reorder to preserve manual arrangement`,
    );
  }
  if (config.reorderMedia && plan.siblingManaged.length > 0) {
    result.notes.push(
      `${plan.siblingManaged.length} media item(s) belong to sibling Unleashed product(s) on this Shopify product; skipping reorder`,
    );
  }

  // Without this check a settled multi-image product would be reordered on every
  // single reconcile pass.
  let currentOrderIds = product.media.map((media) => media.id);
  const reorderNeededNow =
    canReorder && !orderAlreadyCorrect(currentOrderIds, plan.resolved.map((entry) => entry.mediaId));

  const hasWork = plan.toUpload.length > 0 || willDetach.length > 0;
  if (!hasWork && !reorderNeededNow) {
    result.outcome = SYNC_OUTCOME.UNCHANGED;
    result.adopted = plan.resolved
      .filter((entry) => entry.origin === MEDIA_ORIGIN.ADOPTED)
      .map((entry) => entry.mediaId);

    // Adoption is itself worth persisting so later runs skip the lookup.
    if (result.adopted.length > 0 && !config.dryRun) {
      await shopify.saveState({
        productId: shopifyProductId,
        state: buildState({
          productCode,
          entries: plan.resolved,
          previousManaged: state.managed,
          liveMediaIds: liveMediaIdsBefore,
        }),
      });
    }
    return result;
  }

  if (config.dryRun) {
    result.outcome = SYNC_OUTCOME.DRY_RUN;
    result.notes.push(
      `would upload ${plan.toUpload.length}, detach ${willDetach.length}, ` +
        `adopt ${plan.resolved.filter((entry) => entry.origin === MEDIA_ORIGIN.ADOPTED).length}, ` +
        `reorder: ${reorderNeededNow || (canReorder && plan.toUpload.length > 0)}`,
    );
    result.added = plan.toUpload.map((image) => ({ url: image.url, mediaId: null }));
    result.detached = willDetach.map((entry) => entry.mediaId);
    return result;
  }

  const knownMediaIds = new Set(product.media.map((media) => media.id));
  const uploaded = [];

  for (const image of plan.toUpload) {
    try {
      const { media, allMedia } = await shopify.appendImage({
        productId: shopifyProductId,
        url: image.url,
        alt: product.title,
        knownMediaIds,
      });
      for (const node of allMedia) knownMediaIds.add(node.id);
      // Newly appended media lands last; keep the live order for the reorder check.
      if (allMedia.length > 0) currentOrderIds = allMedia.map((node) => node.id);

      if (media) {
        uploaded.push({
          url: image.url,
          mediaId: media.id,
          origin: MEDIA_ORIGIN.SYNCED,
          isDefault: image.isDefault,
        });
        result.added.push({ url: image.url, mediaId: media.id });
      } else {
        result.notes.push(`could not identify created media for ${image.url}`);
      }
    } catch (error) {
      // One unreachable URL must not cost the product its other images.
      log.error?.(`${productCode}: uploading ${image.url} failed — ${error.message}`);
      result.notes.push(`upload failed for ${image.url}: ${error.message}`);
    }
  }

  if (willDetach.length > 0) {
    try {
      await shopify.detachMedia({
        productId: shopifyProductId,
        mediaIds: willDetach.map((entry) => entry.mediaId),
      });
      result.detached = willDetach.map((entry) => entry.mediaId);
      const detached = new Set(result.detached);
      currentOrderIds = currentOrderIds.filter((id) => !detached.has(id));
    } catch (error) {
      log.error?.(`${productCode}: detaching media failed — ${error.message}`);
      result.notes.push(`detach failed: ${error.message}`);
    }
  }

  // Final managed set, in Unleashed's order.
  const entries = [];
  for (const image of desired) {
    const key = imageKey(image.url);
    const fromResolved = plan.resolved.find((entry) => imageKey(entry.url) === key);
    const fromUploaded = uploaded.find((entry) => imageKey(entry.url) === key);
    const entry = fromResolved ?? fromUploaded;
    if (entry) {
      entries.push({
        url: entry.url,
        mediaId: entry.mediaId,
        origin: entry.origin,
        isDefault: image.isDefault,
      });
    }
  }

  const desiredOrderIds = entries.map((entry) => entry.mediaId);
  if (canReorder && entries.length > 1 && !orderAlreadyCorrect(currentOrderIds, desiredOrderIds)) {
    try {
      await shopify.reorderMedia({ productId: shopifyProductId, orderedMediaIds: desiredOrderIds });
      result.reordered = true;
    } catch (error) {
      log.warn?.(`${productCode}: reorder failed — ${error.message}`);
      result.notes.push(`reorder failed: ${error.message}`);
    }
  }

  await shopify.saveState({
    productId: shopifyProductId,
    state: buildState({
      productCode,
      entries,
      previousManaged: state.managed,
      liveMediaIds: knownMediaIds,
    }),
  });

  result.adopted = entries
    .filter((entry) => entry.origin === MEDIA_ORIGIN.ADOPTED)
    .map((entry) => entry.mediaId);
  result.outcome = SYNC_OUTCOME.SYNCED;
  return result;
}

/**
 * True when `desiredIds` already occupy the leading positions of `currentIds`,
 * in order — i.e. there is nothing for a reorder to achieve.
 *
 * @param {string[]} currentIds Media ids in their current Shopify order.
 * @param {string[]} desiredIds Media ids in the order Unleashed implies.
 */
export function orderAlreadyCorrect(currentIds, desiredIds) {
  if (desiredIds.length === 0) return true;
  return desiredIds.every((id, index) => currentIds[index] === id);
}

/**
 * Rewrites this product code's entries while preserving those belonging to
 * sibling Unleashed products that share the same Shopify product. Dropping the
 * siblings would make their images look unowned and, with deletion enabled,
 * expose them to being detached.
 *
 * @param {{ productCode: string, entries: object[], previousManaged?: object[], liveMediaIds?: Set<string> }} input
 */
export function buildState({ productCode, entries, previousManaged = [], liveMediaIds }) {
  const foreign = previousManaged.filter(
    (entry) =>
      entry.productCode !== productCode && (!liveMediaIds || liveMediaIds.has(entry.mediaId)),
  );

  return {
    version: STATE_VERSION,
    syncedAt: new Date().toISOString(),
    managed: [
      ...foreign,
      ...entries.map((entry) => ({
        url: entry.url,
        mediaId: entry.mediaId,
        origin: entry.origin,
        isDefault: entry.isDefault === true,
        productCode,
      })),
    ],
  };
}
