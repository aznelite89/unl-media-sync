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
  /**
   * An image Unleashed no longer lists is still on the Shopify product, because
   * `DELETE_REMOVED_MEDIA` is off or the detach call threw. Distinct from
   * `synced` and `unchanged` for the same reason `capped` is: both are filtered
   * out of the daily report as noise, so a product carrying only this note would
   * never reach anyone. Someone deleting an image in Unleashed and watching it
   * stay on the website is the whole point of saying so.
   */
  RETAINED: 'retained',
  /** Would have changed something, but DRY_RUN is on. */
  DRY_RUN: 'dry_run',
  FAILED: 'failed',
};

/**
 * Outcomes the daily report names product by product, worst first.
 *
 * `unmatched` and `capped` are in this list even though they never alert: the
 * counts alone prompted "which SKUs?" every time, and the answer was only ever
 * in the logs. `retained` is here for the same reason, and does warn — but only
 * when removal is switched on, because only then does it mean a write failed.
 * Ordering is severity, so a truncated inline list still leads with the things
 * that need doing rather than the steady-state data facts.
 */
export const DAILY_REPORTED_OUTCOMES = [
  SYNC_OUTCOME.FAILED,
  SYNC_OUTCOME.DRY_RUN,
  SYNC_OUTCOME.AMBIGUOUS,
  SYNC_OUTCOME.UNMATCHED,
  SYNC_OUTCOME.RETAINED,
  SYNC_OUTCOME.CAPPED,
];

/** Plain English for the report table — nobody outside this repo reads `dry_run`. */
export const OUTCOME_LABEL = {
  [SYNC_OUTCOME.FAILED]: 'failed',
  [SYNC_OUTCOME.DRY_RUN]: 'pending',
  [SYNC_OUTCOME.AMBIGUOUS]: 'ambiguous SKU',
  [SYNC_OUTCOME.UNMATCHED]: 'unmatched SKU',
  [SYNC_OUTCOME.CAPPED]: 'declined by the image cap',
  [SYNC_OUTCOME.RETAINED]: 'deleted in Unleashed, still on Shopify',
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

/** `Date#getUTCDay()` numbering. */
export const WEEKDAY = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

export const MS_PER_HOUR = 3_600_000;
export const HOURS_PER_DAY = 24;

/** AEST. Fixed, like the timer schedules: they are written in UTC and do not move with daylight saving. */
export const REPORT_UTC_OFFSET_HOURS = 10;

/**
 * The weekly report day, in AEST: the one day a healthy pass is emailed, and the
 * day the pass looks back a week instead of a day.
 *
 * The pass still runs every day and a WARN or ALERT is emailed the day it
 * happens. Only the OK verdict waits for Monday: seven "nothing outstanding"
 * emails a week were being read as noise, and a report that is filtered to
 * trash cannot deliver the one alert that matters.
 */
export const OK_REPORT_WEEKDAY = WEEKDAY.MONDAY;

/** How far back the Monday pass looks, so the one healthy email covers the week. */
export const DEFAULT_WEEKLY_LOOKBACK_HOURS = 7 * HOURS_PER_DAY;

/**
 * Products the report checks at once. It only reads, and each product is two
 * Shopify round trips, so a week is network wait: 587 products took 454s one at
 * a time on 2026-09-29, most of the 10-minute `functionTimeout`. The live sync
 * stays sequential.
 */
export const REPORT_SYNC_CONCURRENCY = 4;

/**
 * Wall-clock ceiling for the report's check, under `host.json`'s 10-minute
 * `functionTimeout`. A host-killed invocation sends no email at all, so the
 * check stops itself and the email says it is partial instead.
 */
export const REPORT_SCAN_BUDGET_MS = 7 * 60_000;

/** Why a report was logged but not emailed. */
export const REPORT_SKIP_REASON = {
  OK_NOT_DUE: 'healthy report, emailed on Mondays only; logged only',
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
 * How many products must be seen still carrying images before an empty
 * `Images[]` is believed and acted on.
 *
 * A product whose Unleashed image list has dropped to zero is the one case where
 * "Unleashed says so" is not enough on its own: a fault that returns products
 * with their images stripped is indistinguishable, per product, from somebody
 * deliberately deleting the last photo — and acting on the wrong one takes every
 * picture off a live product. What has to be established is narrow and checkable:
 * that the feed is serving image data at all.
 *
 * Counted first from the run's own window, and — because a ten-minute window
 * usually holds nothing with photos — then from a one-page catalogue probe. See
 * `corroborateEmptyImages`. Failing both, nothing is touched, which is the
 * pre-2026-08-21 behaviour.
 */
export const EMPTY_IMAGES_CORROBORATION_MIN = 5;

/**
 * Ceiling on how many image-less products one run will check against Shopify.
 *
 * Most of the catalogue has no photographs and never did, so most of these
 * lookups find nothing to do — on live windows it is routinely every product in
 * the run. A ten-minute window makes that a couple of dozen products and the
 * cost is trivial, but `--all` walks thousands, and two Shopify calls apiece
 * would spend the whole function timeout confirming that products with no
 * pictures still have no pictures.
 *
 * The cap keeps the ordinary path uncapped in practice while stopping a
 * catalogue-wide pass from starving the work that matters. What it drops is
 * logged, never silent, and the next run picks them up.
 */
export const EMPTY_IMAGES_MAX_PER_RUN = 200;

/**
 * Bytes read from the head of an Unleashed image to fingerprint it.
 *
 * Covers a PNG's IHDR (byte 16) and most JPEG frame headers, while the
 * `Content-Range` on the reply carries the file's total size — so one 4 KB
 * request usually yields both halves of the fingerprint without ever
 * downloading the picture.
 */
export const IMAGE_PROBE_BYTES = 4096;

/**
 * Second, larger probe, used only when the first cannot find the dimensions.
 *
 * 4 KB was assumed to clear "even a long EXIF block". It does not: the
 * 9KDR251SIZE* eternity ring photographs carry an ICC profile that pushes the
 * JPEG frame header past 16 KB. `readImageSize` then returned null, the
 * fingerprint with it, and content adoption silently fell back to uploading —
 * so every sibling product code added its own copy of one photograph, exactly
 * the duplicate that fingerprinting exists to prevent.
 *
 * Escalating rather than simply raising the first probe keeps the common case
 * at 4 KB; only images that need it pay for the second request.
 */
export const IMAGE_PROBE_BYTES_MAX = 65536;

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

/**
 * Duplicate groups that mean SOMETHING ELSE put a copy on the page — one or more
 * copies belong to no state entry.
 *
 * This is what a health verdict keys on, never "any duplicate". A product whose
 * Unleashed images include two byte-identical files uploads both (dedup happens
 * against the Shopify page, not within one product's own `Images[]`), producing
 * an `all_managed` group on every run forever. Warning on that daily would be
 * exactly the noise that teaches people to ignore the report.
 */
export const FOREIGN_DUPLICATE_KINDS = [DUPLICATE_KIND.MIXED, DUPLICATE_KIND.ALL_UNMANAGED];

/** Products per page when scanning the store for duplicate media. */
export const DUPLICATE_SCAN_PAGE_SIZE = 50;

/**
 * Media inspected per product during that scan. Four times the page cap of 5, so
 * a duplicate beyond it would already be on a product far outside policy — and
 * the scan warns rather than truncating silently. Kept low because the sweep is
 * throttle-bound: cost scales with products x media, so this halves wall-clock.
 */
export const DUPLICATE_SCAN_MEDIA_SIZE = 20;

/** Guard against a runaway duplicate scan. */
export const DUPLICATE_SCAN_MAX_PAGES = 200;

/**
 * Wall-clock ceiling for a whole-store sweep, under `host.json`'s 10-minute
 * `functionTimeout`. A host-killed invocation sends NO email at all — the exact
 * silent failure this watch exists to prevent — so the sweep stops itself early
 * and reports a partial, explicitly-truncated result instead.
 */
export const DUPLICATE_SCAN_BUDGET_MS = 7 * 60_000;

/**
 * Customer suburb fill.
 *
 * Unleashed's own Shopify connector writes a Shopify address's `city` (labelled
 * "Suburb" in Shopify's Australian address form) into the Unleashed `City`
 * field and leaves `Suburb` empty — the field every hand-entered Unleashed
 * address uses. The hub offers no mapping for this, so a job copies City into
 * an empty Suburb after the fact. City is left as it was.
 */
export const CUSTOMER_PAGE_SIZE = 200;
export const CUSTOMER_MAX_PAGES = 50;
export const DEFAULT_SUBURB_LOOKBACK_MINUTES = 60;

/** Returned by GET /Customers but not accepted back on update. */
export const CUSTOMER_READ_ONLY_FIELDS = ['CreatedOn', 'CreatedBy', 'LastModifiedOn', 'LastModifiedBy'];

export const SUBURB_OUTCOME = {
  /** At least one address had its empty Suburb filled from City. */
  FILLED: 'filled',
  /** Every address already had a Suburb, or had no City to copy. */
  UNCHANGED: 'unchanged',
  /** Would have filled something, but writes are off. */
  DRY_RUN: 'dry_run',
  /** The update call threw, or the re-read did not show the fill. */
  FAILED: 'failed',
};

/**
 * Customer notes guard.
 *
 * On every website order the connector copies the Shopify customer's `note`
 * into the Unleashed customer's Notes, including a blank one, which wipes
 * whatever Searay had typed there (trading terms, quoted prices). Reproduced by
 * Jian on MB712 / price@searay.net.au, 21-22 Sep 2026. The hub has no setting
 * for it, so a snapshot of every customer's Notes is kept and a wipe that
 * arrives together with a website order is put back.
 */
export const NOTES_OUTCOME = {
  /** Notes were wiped alongside a website order and have been put back. */
  RESTORED: 'restored',
  /** Would have restored, but writes are off. */
  DRY_RUN: 'dry_run',
  /** Blanked with no website order since the last run: a person cleared them. Left alone; the text stays in the snapshot. */
  CLEARED: 'cleared',
  /** New or edited text, recorded in the snapshot. */
  RECORDED: 'recorded',
  /** Text replaced (not blanked) in the same window as a website order. Kept, previous text saved. */
  REPLACED_WITH_WEB_ORDER: 'replaced_with_web_order',
  /** First run: recorded, nothing compared. */
  BASELINE: 'baseline',
  /** Nothing to do. */
  UNCHANGED: 'unchanged',
  /** The update threw, or the re-read did not show the notes back. */
  FAILED: 'failed',
};

/** `CreatedBy` on sales orders the Shopify connector creates (their numbers are `web#NNNN`). */
export const SHOPIFY_ORDER_CREATOR = 'Shopify';

/**
 * Margin taken off the previous run's time when deciding which customers and
 * website orders are new: covers clock skew and a connector write landing while
 * the previous run was mid-walk.
 */
export const NOTES_WINDOW_SLACK_MINUTES = 30;

export const NOTES_SNAPSHOT_VERSION = 1;
export const NOTES_SNAPSHOT_CONTAINER = 'customer-notes';
export const NOTES_SNAPSHOT_BLOB = 'snapshot.json';
/** One copy per day (UTC), overwritten through the day, kept as restore points. */
export const NOTES_HISTORY_PREFIX = 'history/';

/** Wider pages for the first whole-list walk; Unleashed allows up to 1000. */
export const NOTES_BASELINE_PAGE_SIZE = 1000;

/**
 * What POST /Customers/{guid} accepts, per the API docs. GET returns more
 * (Contacts, XeroContactId, SourceId, Reminder, address Guids, extra Currency
 * fields) and sending any of it back is answered with a bare HTTP 500.
 */
export const CUSTOMER_UPDATE_FIELDS = [
  'Guid', 'CustomerCode', 'CustomerName', 'CustomerType', 'CustomerTypeGuid',
  'ContactFirstName', 'ContactLastName', 'Email', 'EmailCC',
  'PhoneNumber', 'MobileNumber', 'FaxNumber', 'DDINumber', 'TollFreeNumber', 'Website',
  'BankAccount', 'BankBranch', 'BankName', 'GSTVATNumber', 'EORINumber',
  'Notes', 'Taxable', 'TaxCode', 'TaxRate', 'DiscountRate', 'PaymentTerm',
  'SellPriceTier', 'SalesPerson', 'SalesOrderGroup',
  'DeliveryMethod', 'DefaultWarehouse', 'HasCreditLimit', 'CreditLimit',
  'PrintInvoice', 'PrintPackingSlipInsteadOfInvoice', 'StopCredit', 'Obsolete',
  'XeroSalesAccount', 'XeroCostOfGoodsAccount',
];
export const CURRENCY_UPDATE_FIELDS = ['CurrencyCode', 'Description', 'Guid'];
export const ADDRESS_UPDATE_FIELDS = [
  'AddressType', 'AddressName', 'StreetAddress', 'StreetAddress2', 'Suburb', 'City',
  'Region', 'Country', 'PostalCode', 'IsDefault', 'DeliveryInstruction',
];
/** Docs: Salesperson needs Guid (Email/FullName optional); DefaultWarehouse needs Guid or WarehouseCode. */
export const SALESPERSON_UPDATE_FIELDS = ['Guid', 'Email', 'FullName'];
export const WAREHOUSE_UPDATE_FIELDS = ['Guid', 'WarehouseCode'];

/**
 * New Arrivals (Christina, 2026-10-02): products created in Unleashed in the
 * last six months that are in stock, kept up to date without anyone picking
 * them by hand.
 *
 * Shopify cannot tell the age: every product was re-created there by the
 * 31 Aug 2026 reload, so its createdAt is the reload date. The Unleashed
 * CreatedOn is the real one. A timer tags the products whose Unleashed code is
 * young enough, and the `new-arrivals` smart collection is TAG + "inventory
 * stock greater than 0", so stock moves products in and out on its own.
 */
export const NEW_ARRIVAL_TAG = 'new-arrival';
export const DEFAULT_NEW_ARRIVAL_COLLECTION_HANDLE = 'new-arrivals';
export const DEFAULT_NEW_ARRIVAL_MONTHS = 6;

export const NEW_ARRIVAL_OUTCOME = {
  TAGGED: 'tagged',
  UNTAGGED: 'untagged',
  DRY_RUN: 'dry_run',
  FAILED: 'failed',
};

/**
 * A run that would take the tag off more than this share of the products that
 * carry it is not ageing out, it is a short Unleashed read. Removals are held
 * back and logged; the next run decides again. `--force` on the CLI overrides.
 */
export const NEW_ARRIVAL_MAX_REMOVAL_SHARE = 0.5;
/** Below this many removals the share check is skipped: a small list ages out in big fractions. */
export const NEW_ARRIVAL_REMOVAL_GUARD_MIN = 10;

/** Shopify's ceiling on `collectionReorderProducts` moves per call. */
export const COLLECTION_REORDER_MAX_MOVES = 250;
/** Products read from the collection when ordering it; far above its expected size. */
export const NEW_ARRIVAL_COLLECTION_MAX_PRODUCTS = 1000;
/** The collection sort the ordering needs; any other sort is left alone. */
export const COLLECTION_SORT_MANUAL = 'MANUAL';

/** Seconds Shopify takes to move freshly tagged products into a smart collection. */
export const SMART_COLLECTION_SETTLE_MS = 15_000;

/**
 * Weekly "products without images" list (2026-10-05): the office needs telling
 * which products still want a photo uploaded in Unleashed. Limited to products
 * created in the last 12 months, because most of the older catalogue has no
 * photographs and never will, and listing it would bury the ones worth doing.
 */
export const DEFAULT_MISSING_IMAGE_MONTHS = 12;

/**
 * Unleashed codes that are not goods and will never have a photo: service and
 * freight lines. Left out of the list. Overridable with MISSING_IMAGE_EXCLUDE_CODES.
 */
export const DEFAULT_MISSING_IMAGE_EXCLUDE_CODES = ['RETURN-ITEM', 'Air Freight'];

/** Products listed inline in that email; the rest ride in the CSV. */
export const MISSING_IMAGES_INLINE_LIMIT = 40;

/** Where a product without an Unleashed image stands on the website. Order is the list's sort order. */
export const WEBSITE_IMAGE_STATUS = {
  /** Live on the website with no picture at all: what a shopper sees. */
  LISTED_NO_IMAGE: 'listed_no_image',
  /** On the website with a picture someone added in Shopify; only Unleashed lacks one. */
  LISTED_HAS_IMAGE: 'listed_has_image',
  /** No Shopify variant carries the product code. */
  NOT_LISTED: 'not_listed',
};

export const WEBSITE_IMAGE_STATUS_ORDER = [
  WEBSITE_IMAGE_STATUS.LISTED_NO_IMAGE,
  WEBSITE_IMAGE_STATUS.LISTED_HAS_IMAGE,
  WEBSITE_IMAGE_STATUS.NOT_LISTED,
];

export const WEBSITE_IMAGE_STATUS_LABEL = {
  [WEBSITE_IMAGE_STATUS.LISTED_NO_IMAGE]: 'on website, no image',
  [WEBSITE_IMAGE_STATUS.LISTED_HAS_IMAGE]: 'on website, image added in Shopify only',
  [WEBSITE_IMAGE_STATUS.NOT_LISTED]: 'not on website',
};

/**
 * This Week Specials (2026-10-05): 48 pieces a week, 12 from each of four
 * categories, picked from stock in the main warehouse that has not sold in 18
 * months, most recently landed first.
 *
 * "Landed" is the latest purchase order receipt. Stock loaded at the March 2024
 * Unleashed setup has none, so it cannot be ranked; it is left out and emailed
 * to the office instead. The `sale` collection, titled
 * "This Week Specials", is TAG + "inventory stock greater than 0", sorted
 * manually; the weekly timer moves the tag and sets the order.
 */
export const WEEKLY_SPECIAL_TAG = 'weekly-special';
export const DEFAULT_WEEKLY_SPECIALS_COLLECTION_HANDLE = 'sale';
export const DEFAULT_WEEKLY_SPECIALS_PER_CATEGORY = 12;
export const DEFAULT_WEEKLY_SPECIALS_UNSOLD_MONTHS = 18;
/** "1. Warehouse", the stock the office can pick from. */
export const DEFAULT_WEEKLY_SPECIALS_WAREHOUSE = 'WH';

/** Same shape as the New Arrivals outcomes; both jobs move one tag. */
export const WEEKLY_SPECIAL_OUTCOME = NEW_ARRIVAL_OUTCOME;

export const MS_PER_DAY = MS_PER_HOUR * HOURS_PER_DAY;

export const SPECIAL_CATEGORY = {
  CHAINS_BRACELETS: 'chains_bracelets',
  EARRINGS: 'earrings',
  RINGS: 'rings',
  PENDANTS: 'pendants',
};

export const SPECIAL_CATEGORY_ORDER = [
  SPECIAL_CATEGORY.CHAINS_BRACELETS,
  SPECIAL_CATEGORY.EARRINGS,
  SPECIAL_CATEGORY.RINGS,
  SPECIAL_CATEGORY.PENDANTS,
];

export const SPECIAL_CATEGORY_LABEL = {
  [SPECIAL_CATEGORY.CHAINS_BRACELETS]: 'Chains & bracelets',
  [SPECIAL_CATEGORY.EARRINGS]: 'Earrings',
  [SPECIAL_CATEGORY.RINGS]: 'Rings',
  [SPECIAL_CATEGORY.PENDANTS]: 'Pendants',
};

/**
 * Words in the Shopify product type that put a product in each category,
 * matching the Earrings, Chains & Bracelets, Rings and Pendants collections.
 * Checked in this order: earrings first, because "Earrings" contains "ring".
 */
export const SPECIAL_CATEGORY_TYPE_WORDS = [
  [SPECIAL_CATEGORY.EARRINGS, ['stud', 'hoop', 'huggie', 'earring']],
  [SPECIAL_CATEGORY.CHAINS_BRACELETS, ['chain', 'bracelet', 'necklet', 'bangle']],
  [SPECIAL_CATEGORY.RINGS, ['ring']],
  [SPECIAL_CATEGORY.PENDANTS, ['pendant', 'locket']],
];

/**
 * Size endings on a code: a chain's length ("9KBELY05950CM" is the 50cm
 * 9KBELY059) and a ring size ("9KSR034SIZEP"). Lengths and sizes of one design
 * look the same on the website, so only one of each design is picked.
 */
export const DESIGN_SIZE_SUFFIXES = [/\d{2}cm$/i, /size[a-z]{1,2}$/i];

/**
 * Letter pendants differ only by the letter on the end of the code ("9KDLW3C",
 * "9KDLW3R"), so one letter of each design is picked. Matched on the Shopify
 * product type.
 */
export const LETTER_PENDANT_TYPE_WORD = 'letter';
export const LETTER_SUFFIX = /[a-z]$/i;

/** Rows of specials-eligible stock with no landed date listed in the email; the rest ride in the CSV. */
export const WEEKLY_SPECIALS_INLINE_LIMIT = 40;
