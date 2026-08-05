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
  /** Pre-existing Shopify media recognised as the same Unleashed file by NAME. */
  ADOPTED: 'adopted',
  /**
   * Pre-existing Shopify media recognised as the same picture by its BYTES.
   *
   * Kept distinct from `adopted` because it means something different: the file
   * reached Shopify by a route that did not preserve the Unleashed filename —
   * in practice, a person uploading the photo by hand — so only the content
   * could identify it. Reports can then show how often that is happening.
   */
  ADOPTED_BY_CONTENT: 'adopted_by_content',
};

/** Every origin that means "already on the page; this service did not add it". */
export const ADOPTED_ORIGINS = [MEDIA_ORIGIN.ADOPTED, MEDIA_ORIGIN.ADOPTED_BY_CONTENT];

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

/**
 * Outcomes the daily report names product by product, worst first.
 *
 * `unmatched` and `capped` are in this list even though they never alert: the
 * counts alone prompted "which SKUs?" every time, and the answer was only ever
 * in the logs. Ordering is severity, so a truncated inline list still leads with
 * the things that need doing rather than the steady-state data facts.
 */
export const DAILY_REPORTED_OUTCOMES = [
  SYNC_OUTCOME.FAILED,
  SYNC_OUTCOME.DRY_RUN,
  SYNC_OUTCOME.AMBIGUOUS,
  SYNC_OUTCOME.UNMATCHED,
  SYNC_OUTCOME.CAPPED,
];

/** Plain English for the report table — nobody outside this repo reads `dry_run`. */
export const OUTCOME_LABEL = {
  [SYNC_OUTCOME.FAILED]: 'failed',
  [SYNC_OUTCOME.DRY_RUN]: 'pending',
  [SYNC_OUTCOME.AMBIGUOUS]: 'ambiguous SKU',
  [SYNC_OUTCOME.UNMATCHED]: 'unmatched SKU',
  [SYNC_OUTCOME.CAPPED]: 'declined by the image cap',
  [SYNC_OUTCOME.SYNCED]: 'synced',
  [SYNC_OUTCOME.UNCHANGED]: 'already correct',
  [SYNC_OUTCOME.NO_IMAGES]: 'no images',
};

/** Products named inline in the daily report; the rest ride in the attached CSV. */
export const DAILY_INLINE_LIMIT = 40;

/** Keeps one verbose note from turning a table row into a paragraph. */
export const REPORT_NOTE_MAX_CHARS = 200;

/**
 * Health of a daily verification pass.
 *
 * The pass re-checks the last day's Unleashed changes in dry-run mode. The live
 * sync should already have handled them, so anything still pending is evidence
 * the sync is failing or falling behind — that is the signal worth alerting on.
 */
export const SYNC_HEALTH = {
  OK: 'ok',
  WARN: 'warn',
  ALERT: 'alert',
};

/** Products still needing a sync before a daily pass is considered unhealthy. */
export const DEFAULT_PENDING_WARN_THRESHOLD = 5;

/** How far back the daily verification pass looks. */
export const DEFAULT_DAILY_LOOKBACK_HOURS = 24;

/**
 * When a daily pass sees no Unleashed changes at all, it widens the window to
 * this many days before deciding anything is wrong.
 *
 * A quiet 24 hours is ordinary — weekends, public holidays, a week nobody edits
 * products. Alerting on that alone would fire most weekends and be filtered to
 * trash within a fortnight. A catalogue this size going a full week without one
 * modification is not ordinary, so the wider window is what actually separates
 * "quiet" from "the sync has stopped seeing Unleashed".
 */
export const ZERO_ACTIVITY_PROBE_DAYS = 7;

/**
 * Whole-catalogue audit paging. Unleashed allows up to 1000 per page, which
 * turns a ~6,500 product pass into single-digit requests instead of 33.
 */
export const AUDIT_PAGE_SIZE = 1000;
export const AUDIT_MAX_PAGES = 100;

/** Shopify's ceiling for a paged connection. */
export const SHOPIFY_BULK_PAGE_SIZE = 250;

/** ~25k variants before the audit would under-report; the store is far below that. */
export const SHOPIFY_BULK_MAX_PAGES = 100;

/** Unmatched SKUs listed inline in the weekly email; the rest ride in the CSV. */
export const AUDIT_INLINE_LIMIT = 40;

/**
 * Leading characters used to bucket SKUs when hunting for a near-miss match.
 * Short enough that `18KDSC10` and `18KDSC10W` land together, long enough that
 * buckets stay small.
 */
export const NEAR_MISS_PREFIX = 5;

/** Resend is already the store's transactional sender (searay-email-func). */
export const RESEND_API_BASE = 'https://api.resend.com';

export const DEFAULT_EMAIL_FROM = 'Searay Image Sync <no-reply@searay.net.au>';

/** Overridable with EMAIL_TO so recipients change without a redeploy. */
export const DEFAULT_EMAIL_TO = [
  'info@searay.net.au',
  'christina.l@searay.net.au',
  'thongz0819@live.com',
];

/** Subject prefixes, so the inbox is filterable without opening anything. */
export const EMAIL_SUBJECT_TAG = {
  ok: 'OK',
  warn: 'WARN',
  alert: 'ALERT',
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

/**
 * Shopify's code for a missing access scope. Worth recognising by name: it is
 * a property of the token, identical for every product, so a bulk run must stop
 * on the first one instead of repeating the same error once per product.
 */
export const SHOPIFY_ACCESS_DENIED_CODE = 'ACCESS_DENIED';

/**
 * Detaching media from a product is `fileUpdate`, which needs `write_files` —
 * NOT covered by the `write_products` the sync uses for everything else.
 */
export const SHOPIFY_DETACH_SCOPE = 'write_files';

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

/**
 * Bytes read from the head of an Unleashed image to fingerprint it.
 *
 * Enough to cover a PNG's IHDR (byte 16) and a JPEG's frame header even behind a
 * long EXIF block, while the `Content-Range` on the reply carries the file's
 * total size. So one 4 KB request yields both halves of the fingerprint without
 * ever downloading the picture.
 */
export const IMAGE_PROBE_BYTES = 4096;

/** `206 Partial Content` — a range request the CDN honoured. */
export const HTTP_PARTIAL_CONTENT = 206;

/**
 * Why two Shopify media items on one product hold the same picture, which
 * decides whether anything can safely be done about it.
 */
export const DUPLICATE_KIND = {
  /**
   * One copy this service owns, one it does not. The unowned copy was almost
   * always uploaded by hand before the same photo reached Unleashed. Safe to
   * repair: drop the copy this service added and let it re-adopt the other.
   */
  MIXED: 'mixed',
  /**
   * Every copy was added by hand. Nothing to do here — this sync has never
   * touched them and must not start now.
   */
  ALL_UNMANAGED: 'all_unmanaged',
  /**
   * Every copy is owned, by sibling Unleashed product codes that each hold their
   * own copy of one photograph — variants of one product, photographed once.
   * Safe to repair now that adoption matches on content: the codes that lose
   * their copy re-adopt the one that remains instead of uploading again.
   */
  ALL_MANAGED: 'all_managed',
};

/** Products per page when scanning the store for duplicate media. */
export const DUPLICATE_SCAN_PAGE_SIZE = 50;

/** Media inspected per product during that scan; the page cap is far below this. */
export const DUPLICATE_SCAN_MEDIA_SIZE = 50;

/** Guard against a runaway duplicate scan. */
export const DUPLICATE_SCAN_MAX_PAGES = 200;
