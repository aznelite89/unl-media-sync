/**
 * Every literal the sync compares against lives here — no raw string/number
 * comparisons in the logic modules.
 */

export const UNLEASHED_API_BASE = 'https://api.unleashedsoftware.com';

/**
 * Unleashed pages list endpoints with the page number as a PATH segment
 * (`/Products/2?pageSize=200`). The signature is computed over the query string
 * only, so the page number never takes part in signing.
 */
export const UNLEASHED_PAGE_IN_PATH = true;
export const UNLEASHED_PAGE_SIZE = 200;
export const UNLEASHED_FIRST_PAGE = 1;

/** Sent as `client-type`; Unleashed requires `<company>/<app>`, lowercase. */
export const CLIENT_TYPE = 'searay/unleashed-media-sync';

export const UNLEASHED_HEADER = {
  AUTH_ID: 'api-auth-id',
  SIGNATURE: 'api-auth-signature',
  CLIENT_TYPE: 'client-type',
  WEBHOOK_SIGNATURE: 'x-unleashed-signature',
  WEBHOOK_TIMESTAMP: 'x-unleashed-timestamp',
};

export const UNLEASHED_EVENT = {
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_DELETED: 'product.deleted',
};

/** Events this service subscribes to and acts on. */
export const SUBSCRIBED_EVENTS = [
  UNLEASHED_EVENT.PRODUCT_CREATED,
  UNLEASHED_EVENT.PRODUCT_UPDATED,
];

/** Unleashed signs `{timestamp}.{rawBody}`; deliveries older than this are rejected. */
export const WEBHOOK_MAX_AGE_SECONDS = 300;

export const SHOPIFY_API_VERSION = '2026-07';
export const SHOPIFY_TOKEN_HEADER = 'X-Shopify-Access-Token';

export const MEDIA_CONTENT_TYPE = {
  IMAGE: 'IMAGE',
};

export const MEDIA_STATUS = {
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
};

/** Where this service records which media it owns. Never trust anything else. */
export const STATE_METAFIELD = {
  NAMESPACE: 'custom',
  KEY: 'unleashed_media',
  TYPE: 'json',
};

export const STATE_VERSION = 1;

/** How a managed media entry came to exist. */
export const MEDIA_ORIGIN = {
  /** Uploaded by this service. */
  SYNCED: 'synced',
  /** Pre-existing Shopify media recognised as the same Unleashed file. */
  ADOPTED: 'adopted',
};

export const SYNC_OUTCOME = {
  /** Media was added, detached or reordered. */
  SYNCED: 'synced',
  /** Shopify already matched Unleashed. */
  UNCHANGED: 'unchanged',
  /** No Shopify variant carries this Unleashed product code. */
  UNMATCHED: 'unmatched',
  /** The product code resolves to more than one Shopify product. */
  AMBIGUOUS: 'ambiguous',
  /** Unleashed holds no images for this product. */
  NO_IMAGES: 'no_images',
  /**
   * Nothing was uploaded solely because the Shopify product is at its image
   * cap. Distinct from `unchanged` on purpose: reports filter `unchanged` out
   * as noise, which would hide every capped image and make a silently
   * truncated run look clean.
   */
  CAPPED: 'capped',
  /** Would have changed something, but DRY_RUN is on. */
  DRY_RUN: 'dry_run',
  FAILED: 'failed',
};

export const HTTP_STATUS = {
  OK: 200,
  ACCEPTED: 202,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

/** Shopify returns this in `extensions.errors` / userErrors when cost-limited. */
export const SHOPIFY_THROTTLED_CODE = 'THROTTLED';

export const RETRY = {
  MAX_ATTEMPTS: 4,
  BASE_DELAY_MS: 750,
  MAX_DELAY_MS: 8000,
};

/** Ceiling from the brief: at most 5 Unleashed images reach Shopify per product. */
export const DEFAULT_MAX_SYNCED_IMAGES = 5;

/**
 * Ceiling on TOTAL media on one Shopify product, agreed 2026-07-31: "5 per
 * unleashed product, cap each web page at 5 as well".
 *
 * Counts every image on the page, including ones added by hand in Shopify —
 * the cap is about what a shopper sees, not about who put it there. The sync
 * only ever declines to add; it never removes anything to make room.
 */
export const DEFAULT_MAX_MEDIA_PER_PRODUCT = 5;

/**
 * The reconcile timer re-reads a window rather than persisting a watermark.
 * Overlap is harmless because the sync is diff-based and idempotent.
 */
export const DEFAULT_RECONCILE_LOOKBACK_MINUTES = 60;

/** Media pages pulled when diffing a product. Shopify caps a product at 250 media. */
export const MEDIA_PAGE_SIZE = 100;

/** Guard against a runaway reconcile run. */
export const RECONCILE_MAX_PAGES = 25;
