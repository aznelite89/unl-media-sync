import {
  ADOPTED_ORIGINS,
  MEDIA_ORIGIN,
  MEDIA_STATUS,
  SYNC_OUTCOME,
} from '../constants/index.js';
import { findDuplicateGroups, planDuplicateCleanup } from './duplicates.js';
import { imageKey, isSameImage, orderedUnleashedImages } from './imageIdentity.js';
import { fingerprintImages, isSameContent, shopifyFingerprint } from './imageFingerprint.js';
import { buildState, parseState } from './state.js';

// Re-exported so callers that think of these as part of the sync surface — the
// tests and the CLI among them — do not need to know where they moved to.
export { buildState, parseState };

/**
 * Works out, without calling Shopify, what should happen to a product's media.
 *
 * Rules, in priority order:
 *  1. An image already tracked in state keeps its media — nothing is re-uploaded.
 *  2. An untracked image that matches existing Shopify media by filename is
 *     ADOPTED. This is what stops the first run duplicating the single image
 *     Unleashed's built-in connector already pushed.
 *  3. An untracked image whose BYTES match media already on the page is adopted
 *     too. Filenames cannot reach this case: Unleashed's API exposes only a GUID
 *     URL, so neither a photo someone uploaded by hand (which keeps its human
 *     filename) nor a sibling code's copy of the same photograph (which has its
 *     own GUID) can ever be matched by name. Requires `fingerprints`; see
 *     imageFingerprint.js.
 *  4. Anything left is uploaded.
 *  5. Media this service does not own is never removed, reordered away, or
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
 * Those siblings usually hold the SAME photograph, each under its own Unleashed
 * GUID, so name matching saw a page of different images and every code added its
 * own copy — five identical pictures filling a five-image page on 9KBELY040*.
 * Content matching is what collapses them to one. The consequence is that one
 * media item can now be referenced by several codes' entries, which is why
 * `toDetach` also skips anything a sibling still points at.
 *
 * PAGE CAP: `maxMediaPerProduct` limits the TOTAL images on the Shopify product,
 * counting media the sync did not add. Uploads beyond the cap are skipped and
 * reported — nothing is ever removed to make room. Because `desired` is ordered
 * default-image-first, the image that survives the cut is the default one.
 *
 * @param {{ desired: Array<{url: string, isDefault: boolean}>, liveMedia: object[], state: object, productCode: string, maxMediaPerProduct?: number, fingerprints?: Map<string, object> }} input
 */
export function planMediaChanges({
  desired,
  liveMedia,
  state,
  productCode,
  maxMediaPerProduct = Number.POSITIVE_INFINITY,
  fingerprints = new Map(),
}) {
  const liveById = new Map(liveMedia.map((media) => [media.id, media]));

  // State entries whose media has since been deleted in Shopify are stale.
  const tracked = state.managed.filter((entry) => liveById.has(entry.mediaId));
  const trackedByKey = new Map(tracked.map((entry) => [imageKey(entry.url), entry]));
  const managedIds = new Set(tracked.map((entry) => entry.mediaId));
  const ownedByThisCode = tracked.filter((entry) => entry.productCode === productCode);
  const ownedIdsByThisCode = new Set(ownedByThisCode.map((entry) => entry.mediaId));

  /**
   * Media this product code does not already own, and so may claim: added by
   * hand, or placed by a sibling code. Claiming a sibling's copy is the whole
   * point of content matching here — variants that share one photograph must
   * show it once, not once per Unleashed code.
   */
  const contentCandidates = liveMedia.filter((media) => !ownedIdsByThisCode.has(media.id));

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

    // Only media nobody has spoken for yet.
    const available = (media) => !claimed.has(media.id);

    // Filename first: free, and what connector-pushed media matches on.
    let adoptable = contentCandidates.find(
      (media) => available(media) && isSameImage(media.image?.url, image.url),
    );
    let origin = MEDIA_ORIGIN.ADOPTED;

    // Then the bytes — the only thing that can recognise a copy uploaded by hand
    // under a human filename, or a sibling code's copy of the same photograph
    // sitting under a different Unleashed GUID.
    if (!adoptable) {
      const wanted = fingerprints.get(key);
      if (wanted) {
        adoptable = contentCandidates.find(
          (media) => available(media) && isSameContent(wanted, shopifyFingerprint(media)),
        );
        origin = MEDIA_ORIGIN.ADOPTED_BY_CONTENT;
      }
    }

    if (adoptable) {
      claimed.add(adoptable.id);
      resolved.push({
        url: image.url,
        mediaId: adoptable.id,
        origin,
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

  /**
   * Media a sibling code also has a state entry for. Once codes can share one
   * media item — which is exactly what content adoption across siblings
   * produces — "this code no longer wants it" stops meaning "nobody wants it",
   * and detaching on one code's behalf would take the photograph off the page
   * for every other code still using it.
   */
  const sharedWithOtherCodes = new Set(
    tracked.filter((entry) => entry.productCode !== productCode).map((entry) => entry.mediaId),
  );

  const toDetach = ownedByThisCode.filter(
    (entry) =>
      !desiredKeys.has(imageKey(entry.url)) &&
      !claimed.has(entry.mediaId) &&
      !sharedWithOtherCodes.has(entry.mediaId),
  );

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
    contentCandidates,
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
 *   fetchImpl?: Function,
 * }} input
 */
export async function syncUnleashedProduct({
  unleashedProduct,
  shopify,
  config,
  log = console,
  // Every other call this function makes goes through the injected Shopify
  // client; fingerprinting reads Unleashed's CDN directly, so it comes in the
  // same way rather than reaching for a global.
  fetchImpl = fetch,
  /**
   * Whether the caller has corroborated that an empty `Images[]` is real rather
   * than a fault. Only `reconcile` can — it sees a whole run — so this defaults
   * to false and the webhook path leaves image-less products to the next
   * scheduled pass. See EMPTY_IMAGES_CORROBORATION_MIN.
   */
  emptyImagesConfirmed = false,
}) {
  const productCode = String(unleashedProduct?.ProductCode ?? '').trim();
  const result = {
    productCode,
    unleashedGuid: unleashedProduct?.Guid ?? null,
    // Carried on every result so a report row can say what is at stake and which
    // product it is, without a second Unleashed lookup at reporting time.
    imageCount: (unleashedProduct?.Images ?? []).length,
    description: String(unleashedProduct?.ProductDescription ?? '').trim(),
    outcome: SYNC_OUTCOME.FAILED,
    added: [],
    adopted: [],
    /** Subset of `adopted` recognised by bytes rather than by filename. */
    adoptedByContent: [],
    /** Pictures found more than once on this product. Reported, never acted on. */
    duplicates: null,
    detached: [],
    /** Media Unleashed dropped that is still on the page — see SYNC_OUTCOME.RETAINED. */
    retained: [],
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

  if (desired.length === 0 && !emptyImagesConfirmed) {
    // Unleashed lists no images, and nothing has corroborated that. Returning
    // here is the safe default: an API fault that strips `Images[]` reads
    // exactly like a deliberate deletion from inside one product, and acting on
    // the wrong one takes every picture off a live product. The caller decides
    // — see EMPTY_IMAGES_CORROBORATION_MIN — and the next run asks again.
    result.outcome = SYNC_OUTCOME.NO_IMAGES;
    return result;
  }
  if (desired.length === 0) {
    // Corroborated: the run saw plenty of other products still carrying images,
    // so this one is empty on purpose. Fall through and let the ordinary plan
    // handle it — every existing guard still applies, so only media this code
    // owns, that no sibling still points at, is a candidate, and it comes off
    // only with DELETE_REMOVED_MEDIA on.
    result.notes.push('Unleashed lists no images for this product');
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

  // Free surveillance. The media and the ownership state are already in hand, so
  // spotting a second writer's copy of a picture costs nothing extra.
  //
  // Snapshotted BEFORE anything is written, so it describes what was on the page
  // when we looked. Reported only, never acted on: removal stays behind
  // `--duplicates --apply`. Repairing here would fight a live second writer in a
  // loop — detach, it re-adds, forever — on a customer-facing product.
  //
  // Shaped exactly like one element of `auditDuplicates().products` so the daily
  // and weekly reports share `buildDuplicateCsv`.
  const duplicateGroups = findDuplicateGroups({ media: product.media, state });
  if (duplicateGroups.length > 0) {
    result.duplicates = {
      productId: shopifyProductId,
      title: product.title ?? '',
      mediaCount: product.media.length,
      groups: duplicateGroups,
      removals: planDuplicateCleanup(duplicateGroups),
    };
    const wasted = duplicateGroups.reduce((total, g) => total + g.copies.length - 1, 0);
    result.notes.push(
      `${duplicateGroups.length} picture(s) appear more than once on this product ` +
        `(${wasted} wasted image slot(s))`,
    );
  }

  const planInput = {
    desired,
    liveMedia: product.media,
    state,
    productCode,
    maxMediaPerProduct: config.maxMediaPerProduct,
  };
  let plan = planMediaChanges(planInput);

  // Second pass, only when it can change the answer: we are about to upload, and
  // the page holds media this code does not own that could already BE one of
  // these pictures under a name filename matching can never recognise. Costs one
  // small ranged request per image that would otherwise be uploaded, and nothing
  // at all once the adoption is written to state.
  if (
    plan.toUpload.length > 0 &&
    plan.contentCandidates.some((media) => shopifyFingerprint(media) !== null)
  ) {
    const fingerprints = await fingerprintImages(plan.toUpload, { log, fetchImpl });
    if (fingerprints.size > 0) plan = planMediaChanges({ ...planInput, fingerprints });
  }

  const adoptedByContent = plan.resolved.filter(
    (entry) => entry.origin === MEDIA_ORIGIN.ADOPTED_BY_CONTENT,
  );
  if (adoptedByContent.length > 0) {
    result.adoptedByContent = adoptedByContent.map((entry) => entry.mediaId);
    result.notes.push(
      `${adoptedByContent.length} image(s) were already on this product under a different ` +
        'filename; adopted instead of uploading a duplicate',
    );
    log.info?.(
      `${productCode}: adopted ${adoptedByContent.length} existing image(s) on ${shopifyProductId} ` +
        'by content — a duplicate upload was avoided',
    );
  }

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
    log.warn?.(
      `${productCode}: ${plan.toDetach.length} image(s) removed in Unleashed are still on ` +
        `${shopifyProductId} — DELETE_REMOVED_MEDIA is off`,
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
    // A product blocked entirely by the cap must not report as `unchanged`,
    // or reports that drop `unchanged` rows will hide the skipped images. The
    // same applies to an image Unleashed dropped that is still on the page:
    // `unchanged` is exactly what it looks like from here, and exactly what
    // stops anyone being told.
    result.outcome = reportableOutcome({
      skippedForCap: plan.skippedForCap.length,
      retained: plan.toDetach.length,
      changed: false,
    });
    result.retained = plan.toDetach.map((entry) => entry.mediaId);
    result.adopted = plan.resolved
      .filter((entry) => ADOPTED_ORIGINS.includes(entry.origin))
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
          // Nothing was detached on this path, so everything Unleashed dropped is
          // still on the page and must keep its ownership record.
          retained: plan.toDetach,
        }),
      });
    }
    return result;
  }

  if (config.dryRun) {
    result.outcome = SYNC_OUTCOME.DRY_RUN;
    result.notes.push(
      `would upload ${plan.toUpload.length}, detach ${willDetach.length}, ` +
        `adopt ${plan.resolved.filter((entry) => ADOPTED_ORIGINS.includes(entry.origin)).length}, ` +
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

  // Whatever we meant to detach but did not — deletion disabled, or the call
  // threw — is still on the page, so it keeps its ownership record.
  const detachedIds = new Set(result.detached);
  const stillOnPage = plan.toDetach.filter((entry) => !detachedIds.has(entry.mediaId));
  result.retained = stillOnPage.map((entry) => entry.mediaId);

  await shopify.saveState({
    productId: shopifyProductId,
    state: buildState({
      productCode,
      entries,
      previousManaged: state.managed,
      liveMediaIds: knownMediaIds,
      retained: stillOnPage,
    }),
  });

  result.adopted = entries
    .filter((entry) => ADOPTED_ORIGINS.includes(entry.origin))
    .map((entry) => entry.mediaId);
  // `synced` is filtered out of the daily report just as `unchanged` is, so a
  // run that uploaded the new image but could not take the old one off would
  // otherwise report as a clean success.
  result.outcome = reportableOutcome({
    skippedForCap: plan.skippedForCap.length,
    retained: stillOnPage.length,
    changed: true,
  });
  return result;
}

/**
 * The outcome a product's report row carries.
 *
 * `synced` and `unchanged` are both dropped from the daily report as noise, so
 * anything still outstanding on an otherwise successful product has to be said
 * through the outcome itself or it is never said at all. Severity order: an
 * image that should have come off and did not outranks one the cap declined,
 * because the first means a write did not take and the second is a data fact.
 *
 * @param {{ skippedForCap: number, retained: number, changed: boolean }} input
 */
function reportableOutcome({ skippedForCap, retained, changed }) {
  if (retained > 0) return SYNC_OUTCOME.RETAINED;
  if (skippedForCap > 0) return SYNC_OUTCOME.CAPPED;
  return changed ? SYNC_OUTCOME.SYNCED : SYNC_OUTCOME.UNCHANGED;
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

