import crypto from 'node:crypto';

import {
  AUDIT_MAX_PAGES,
  AUDIT_PAGE_SIZE,
  CLIENT_TYPE,
  CUSTOMER_MAX_PAGES,
  CUSTOMER_PAGE_SIZE,
  UNLEASHED_API_BASE,
  UNLEASHED_FIRST_PAGE,
  UNLEASHED_HEADER,
  UNLEASHED_PAGE_SIZE,
  RECONCILE_MAX_PAGES,
  SHOPIFY_ORDER_CREATOR,
  WEBHOOK_MAX_AGE_SECONDS,
} from '../constants/index.js';
import { fetchWithRetry } from './http.js';

/**
 * Unleashed signs the query string only — no leading `?`, no path, no body —
 * with HMAC-SHA256 keyed on the API key, base64 encoded. Requests with no query
 * string sign the empty string.
 *
 * @param {string} queryString Exactly the string sent after `?`.
 * @param {string} apiKey
 */
export function signQueryString(queryString, apiKey) {
  return crypto.createHmac('sha256', apiKey).update(queryString, 'utf8').digest('base64');
}

/**
 * Verifies an Unleashed webhook delivery. The signed payload is
 * `{timestamp}.{rawBody}` — the RAW body, so callers must pass the untouched
 * request text rather than a re-serialised object.
 *
 * @param {{ rawBody: string, signature: string, timestamp: string, signatureKey: string, nowMs?: number }} input
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyWebhook({ rawBody, signature, timestamp, signatureKey, nowMs = Date.now() }) {
  if (!signature) return { valid: false, reason: 'missing signature header' };
  if (!timestamp) return { valid: false, reason: 'missing timestamp header' };

  const sentAtMs = Number.isFinite(Number(timestamp))
    ? Number(timestamp) * (String(timestamp).length > 10 ? 1 : 1000)
    : Date.parse(timestamp);
  if (!Number.isFinite(sentAtMs)) return { valid: false, reason: 'unparseable timestamp' };

  const ageSeconds = Math.abs(nowMs - sentAtMs) / 1000;
  if (ageSeconds > WEBHOOK_MAX_AGE_SECONDS) {
    return { valid: false, reason: `timestamp is ${Math.round(ageSeconds)}s old` };
  }

  const expected = crypto
    .createHmac('sha256', signatureKey)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return { valid: false, reason: 'signature mismatch' };
  }

  return { valid: true };
}

/**
 * @param {{ unleashed: { apiId: string, apiKey: string } }} config
 * @param {{ info?: Function, warn?: Function, error?: Function }} [log]
 */
/**
 * Builds the query string that is both signed and sent.
 *
 * Colons are left raw. `URLSearchParams` percent-encodes them, and Unleashed
 * rejects `%3A` in the signed query string with a bare HTTP 403 — so every
 * request carrying a `modifiedSince` timestamp fails while parameter-free
 * requests succeed. A colon is a legal query character under RFC 3986, and
 * sending it raw is what Unleashed's own examples do.
 *
 * @param {Record<string, string | number | undefined>} params
 */
export function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.append(key, String(value));
    }
  }
  return search.toString().replace(/%3A/g, ':');
}

export function createUnleashedClient(config, log = console) {
  const { apiId, apiKey } = config.unleashed;

  /**
   * @param {string} path Leading slash, may include a page number segment.
   * @param {Record<string, string | number | undefined>} [params]
   */
  async function get(path, params = {}) {
    // Sign exactly what goes on the wire — encoding must not diverge.
    const queryString = buildQueryString(params);
    const url = `${UNLEASHED_API_BASE}${path}${queryString ? `?${queryString}` : ''}`;

    const response = await fetchWithRetry(
      () =>
        fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            [UNLEASHED_HEADER.AUTH_ID]: apiId,
            [UNLEASHED_HEADER.SIGNATURE]: signQueryString(queryString, apiKey),
            [UNLEASHED_HEADER.CLIENT_TYPE]: CLIENT_TYPE,
          },
        }),
      { label: `unleashed GET ${path}`, log },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Unleashed GET ${path} failed: HTTP ${response.status} ${body.slice(0, 500)}`,
      );
    }

    return response.json();
  }

  /**
   * Signed POST. Unleashed uses POST for both create and update; the signature
   * covers the query string only, which is empty here, so it signs `''`.
   *
   * @param {string} path Leading slash.
   * @param {object} body
   */
  async function post(path, body) {
    const response = await fetchWithRetry(
      () =>
        fetch(`${UNLEASHED_API_BASE}${path}`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            [UNLEASHED_HEADER.AUTH_ID]: apiId,
            [UNLEASHED_HEADER.SIGNATURE]: signQueryString('', apiKey),
            [UNLEASHED_HEADER.CLIENT_TYPE]: CLIENT_TYPE,
          },
          body: JSON.stringify(body),
        }),
      { label: `unleashed POST ${path}`, log },
    );

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Unleashed POST ${path} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /**
   * A single product, including its `Images` collection.
   * @param {string} guid
   */
  async function getProductByGuid(guid) {
    return get(`/Products/${encodeURIComponent(guid)}`);
  }

  /**
   * @param {string} productCode
   * @returns {Promise<object | null>}
   */
  async function getProductByCode(productCode) {
    const page = await get('/Products', { productCode, pageSize: 2 });
    const items = page?.Items ?? [];
    const exact = items.find(
      (item) => String(item?.ProductCode ?? '').trim().toLowerCase() === productCode.trim().toLowerCase(),
    );
    return exact ?? items[0] ?? null;
  }

  /**
   * Yields every product modified since `sinceIso`, one page at a time.
   * Page number is a path segment (`/Products/2?pageSize=200`).
   *
   * `startPage` makes a catalogue pass resumable: a run can cover pages 1–8,
   * the next 9–16, and so on, without repeating work. Page numbering is stable
   * for a given `pageSize` and filter.
   *
   * `warnOnTruncation` exists for callers that mean to read one page. Stopping
   * short is news for a reconcile — work was left undone — but not for a sampler
   * like the empty-image corroboration probe, which asks for a single page on
   * purpose. Warning there puts "this run stops at page 1" in the log of every
   * run that probes, which reads as a truncated sync and is not one.
   *
   * @param {{ sinceIso?: string, pageSize?: number, maxPages?: number, startPage?: number, warnOnTruncation?: boolean }} options
   */
  async function* iterateProducts({
    sinceIso,
    pageSize = UNLEASHED_PAGE_SIZE,
    maxPages = RECONCILE_MAX_PAGES,
    startPage = UNLEASHED_FIRST_PAGE,
    warnOnTruncation = true,
  } = {}) {
    let pageNumber = Math.max(UNLEASHED_FIRST_PAGE, startPage);
    const endPage = pageNumber + maxPages - 1;
    // Unknown until the first response. Starting at 1 would abort any run whose
    // startPage is beyond it, silently yielding nothing; the empty-page check
    // below is what actually terminates the loop.
    let totalPages = Number.POSITIVE_INFINITY;

    while (pageNumber <= totalPages && pageNumber <= endPage) {
      const page = await get(`/Products/${pageNumber}`, {
        pageSize,
        modifiedSince: sinceIso,
        includeObsolete: 'false',
      });

      totalPages = Number(page?.Pagination?.NumberOfPages ?? 1) || 1;
      const items = page?.Items ?? [];
      if (items.length === 0) return;

      // Unleashed clamps an out-of-range page number to the LAST page rather
      // than returning nothing, so a chunk starting past the end would re-sync
      // page N while reporting itself as the page that was asked for.
      if (pageNumber > totalPages) {
        log.warn?.(
          `Requested page ${pageNumber} but the catalogue has ${totalPages}; nothing to do.`,
        );
        return;
      }

      yield { items, pageNumber, totalPages };

      if (warnOnTruncation && totalPages > endPage && pageNumber === endPage) {
        log.warn?.(
          `Unleashed has ${totalPages} pages; this run stops at page ${endPage}. ` +
            `Continue with --start-page ${endPage + 1}, or raise RECONCILE_MAX_PAGES.`,
        );
      }
      pageNumber += 1;
    }
  }

  /**
   * How many products changed since `sinceIso`, without pulling any of them.
   *
   * Used to tell a quiet day apart from a broken feed: a silent 24 hours is
   * ordinary, a silent week is not. Asks for one item and reads the total off
   * the pagination envelope.
   *
   * @param {string} sinceIso
   * @returns {Promise<number>}
   */
  async function countProductsModifiedSince(sinceIso) {
    const page = await get(`/Products/${UNLEASHED_FIRST_PAGE}`, {
      pageSize: 1,
      modifiedSince: sinceIso,
      includeObsolete: 'false',
    });
    return Number(page?.Pagination?.NumberOfItems ?? 0) || 0;
  }

  /**
   * Registers a webhook subscription. The returned `signatureKey` is shown once
   * only — store it in UNLEASHED_WEBHOOK_SIGNATURE_KEY immediately.
   *
   * @param {{ description: string, notificationUrl: string, eventTypes: string[] }} subscription
   */
  async function createWebhookSubscription(subscription) {
    const response = await fetchWithRetry(
      () =>
        fetch(`${UNLEASHED_API_BASE}/webhooks/subscriptions`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            [UNLEASHED_HEADER.AUTH_ID]: apiId,
            [UNLEASHED_HEADER.SIGNATURE]: signQueryString('', apiKey),
            [UNLEASHED_HEADER.CLIENT_TYPE]: CLIENT_TYPE,
          },
          body: JSON.stringify(subscription),
        }),
      { label: 'unleashed POST /webhooks/subscriptions', log },
    );

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Creating webhook subscription failed: HTTP ${response.status} ${body}`);
    }
    return JSON.parse(body);
  }

  /** @param {string} guid */
  async function getCustomerByGuid(guid) {
    return get(`/Customers/${encodeURIComponent(guid)}`);
  }

  /**
   * Yields customers modified since `sinceIso` (or every customer when it is
   * omitted), one page at a time. Same paging rules as `iterateProducts`.
   *
   * @param {{ sinceIso?: string, customerCode?: string, pageSize?: number, maxPages?: number }} options
   */
  async function* iterateCustomers({
    sinceIso,
    customerCode,
    pageSize = CUSTOMER_PAGE_SIZE,
    maxPages = CUSTOMER_MAX_PAGES,
  } = {}) {
    let pageNumber = UNLEASHED_FIRST_PAGE;
    let totalPages = Number.POSITIVE_INFINITY;

    while (pageNumber <= totalPages && pageNumber <= maxPages) {
      const page = await get(`/Customers/${pageNumber}`, {
        pageSize,
        modifiedSince: sinceIso,
        customerCode,
      });
      totalPages = Number(page?.Pagination?.NumberOfPages ?? 1) || 1;
      const items = page?.Items ?? [];
      if (items.length === 0 || pageNumber > totalPages) return;
      yield { items, pageNumber, totalPages };
      if (totalPages > maxPages && pageNumber === maxPages) {
        log.warn?.(`Unleashed has ${totalPages} customer pages; this run stops at page ${maxPages}.`);
      }
      pageNumber += 1;
    }
  }

  /**
   * Updates a customer. Send the full record as read from GET (minus the
   * read-only fields) with only the intended change applied: the API does not
   * document which omitted fields survive an update and which are blanked.
   *
   * @param {string} guid
   * @param {object} body
   */
  async function updateCustomer(guid, body) {
    return post(`/Customers/${encodeURIComponent(guid)}`, body);
  }

  /**
   * Sales orders the Shopify connector created for one customer, modified since
   * `sinceIso`. A new order's LastModifiedOn is never before its CreatedOn, so
   * the filter cannot drop one created in the window; the caller checks
   * CreatedOn itself. `customerCode` is a prefix match in Unleashed, so the
   * code is compared exactly here.
   *
   * @param {string} customerCode
   * @param {string} sinceIso
   */
  async function listShopifyOrdersForCustomer(customerCode, sinceIso) {
    const wanted = String(customerCode).toLowerCase();
    const orders = [];
    let pageNumber = UNLEASHED_FIRST_PAGE;
    let totalPages = 1;
    while (pageNumber <= totalPages) {
      const page = await get(`/SalesOrders/${pageNumber}`, {
        customerCode,
        modifiedSince: sinceIso,
        pageSize: CUSTOMER_PAGE_SIZE,
      });
      totalPages = Number(page?.Pagination?.NumberOfPages ?? 1) || 1;
      for (const order of page?.Items ?? []) {
        const code = String(order?.Customer?.CustomerCode ?? '').toLowerCase();
        if (code === wanted && order?.CreatedBy === SHOPIFY_ORDER_CREATOR) orders.push(order);
      }
      pageNumber += 1;
    }
    return orders;
  }

  /**
   * Every row of a paged list endpoint. Throws rather than returning a short
   * list: callers rank and exclude on these rows, and a missing page would
   * quietly mis-pick.
   *
   * @param {string} resource e.g. `StockOnHand`
   * @param {Record<string, string | number | undefined>} [params]
   */
  async function listAll(resource, params = {}) {
    const items = [];
    let totalPages = 1;
    for (let pageNumber = UNLEASHED_FIRST_PAGE; pageNumber <= totalPages; pageNumber += 1) {
      if (pageNumber > AUDIT_MAX_PAGES) {
        throw new Error(`Unleashed ${resource} has ${totalPages} pages, more than the ${AUDIT_MAX_PAGES} read`);
      }
      const page = await get(`/${resource}/${pageNumber}`, { ...params, pageSize: AUDIT_PAGE_SIZE });
      totalPages = Number(page?.Pagination?.NumberOfPages ?? 1) || 1;
      items.push(...(page?.Items ?? []));
    }
    return items;
  }

  /**
   * Stock on hand, one row per product. With `warehouseCode`, that warehouse's
   * quantities; without, all warehouses together. `DaysSinceLastSale` is null
   * for a product never sold since the March 2024 setup.
   *
   * @param {{ warehouseCode?: string }} [options]
   */
  async function listStockOnHand({ warehouseCode } = {}) {
    return listAll('StockOnHand', { warehouseCode });
  }

  /** Every purchase order, with its lines. */
  async function listPurchaseOrders() {
    return listAll('PurchaseOrders');
  }

  /** Every product that is not obsolete. */
  async function listProducts() {
    return listAll('Products', { includeObsolete: 'false' });
  }

  return {
    get,
    post,
    getCustomerByGuid,
    iterateCustomers,
    updateCustomer,
    listShopifyOrdersForCustomer,
    getProductByGuid,
    getProductByCode,
    iterateProducts,
    countProductsModifiedSince,
    createWebhookSubscription,
    listStockOnHand,
    listPurchaseOrders,
    listProducts,
  };
}

/**
 * Pulls the product identifier out of a webhook envelope. `data` arrives as a
 * JSON-encoded string in some deliveries and as an object in others.
 *
 * @param {object} envelope
 */
export function readWebhookProductGuid(envelope) {
  let data = envelope?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data?.productGuid ?? data?.ProductGuid ?? data?.guid ?? null;
}
