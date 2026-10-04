import { WEBSITE_IMAGE_STATUS, WEBSITE_IMAGE_STATUS_ORDER } from '../constants/index.js';
import { normaliseCode } from './audit.js';
import { parseUnleashedDate } from './customerNotesPlan.js';
import { readRecentUnleashed } from './newArrivals.js';
import { newArrivalCutoff } from './newArrivalsPlan.js';

/**
 * Products created in Unleashed in the last N months that hold no image, for
 * the weekly email telling the office which ones still need a photo uploaded.
 *
 * Age is the Unleashed `CreatedOn`: every Shopify product was re-created by the
 * 31 Aug 2026 reload, so Shopify's own date says nothing.
 */

/**
 * Pure: which products created on or after `cutoffMs` have no image, and where
 * each stands on the website. Obsolete products never count.
 *
 * Sorted so a product live on the website with no picture comes first, then
 * newest first within each group.
 *
 * @param {{
 *   products: object[],
 *   skus: Map<string, { title: string, hasImage: boolean }>,
 *   cutoffMs: number,
 * }} input
 */
export function findMissingImages({ products, skus, cutoffMs }) {
  const missing = [];
  let recent = 0;
  let withImages = 0;

  for (const product of products) {
    if (product?.Obsolete) continue;
    const createdMs = parseUnleashedDate(product?.CreatedOn);
    if (createdMs === null || createdMs < cutoffMs) continue;
    recent += 1;

    if ((product?.Images ?? []).length > 0) {
      withImages += 1;
      continue;
    }

    const listing = skus.get(normaliseCode(product?.ProductCode));
    let status = WEBSITE_IMAGE_STATUS.NOT_LISTED;
    if (listing) {
      status = listing.hasImage
        ? WEBSITE_IMAGE_STATUS.LISTED_HAS_IMAGE
        : WEBSITE_IMAGE_STATUS.LISTED_NO_IMAGE;
    }

    missing.push({
      productCode: product?.ProductCode ?? '',
      description: product?.ProductDescription ?? '',
      created: new Date(createdMs).toISOString().slice(0, 10),
      createdMs,
      status,
      websiteTitle: listing?.title ?? '',
    });
  }

  missing.sort(
    (a, b) =>
      WEBSITE_IMAGE_STATUS_ORDER.indexOf(a.status) - WEBSITE_IMAGE_STATUS_ORDER.indexOf(b.status) ||
      b.createdMs - a.createdMs,
  );

  return { recent, withImages, missing };
}

/**
 * Runs the check against the live APIs. Read-only.
 *
 * @param {{ unleashed: object, shopify: object, config: object, nowMs?: number }} input
 */
export async function auditMissingImages({ unleashed, shopify, config, nowMs = Date.now() }) {
  const months = config.missingImageMonths;
  const cutoffMs = newArrivalCutoff(nowMs, months);

  const [{ products, scanned }, skus] = await Promise.all([
    readRecentUnleashed({ unleashed, cutoffMs }),
    shopify.listAllVariantSkus(),
  ]);

  return {
    months,
    cutoff: new Date(cutoffMs).toISOString().slice(0, 10),
    scanned,
    ...findMissingImages({ products, skus, cutoffMs }),
  };
}
