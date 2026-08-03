import crypto from 'node:crypto';

import {
  CLIENT_TYPE,
  UNLEASHED_API_BASE,
  UNLEASHED_FIRST_PAGE,
  UNLEASHED_HEADER,
  UNLEASHED_PAGE_SIZE,
  RECONCILE_MAX_PAGES,
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
export function createUnleashedClient(config, log = console) {
  const { apiId, apiKey } = config.unleashed;

  /**
   * @param {string} path Leading slash, may include a page number segment.
   * @param {Record<string, string | number | undefined>} [params]
   */
  async function get(path, params = {}) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        search.append(key, String(value));
      }
    }
    // Sign exactly what goes on the wire — encoding must not diverge.
    const queryString = search.toString();
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
   * @param {{ sinceIso?: string, pageSize?: number, maxPages?: number, startPage?: number }} options
   */
  async function* iterateProducts({
    sinceIso,
    pageSize = UNLEASHED_PAGE_SIZE,
    maxPages = RECONCILE_MAX_PAGES,
    startPage = UNLEASHED_FIRST_PAGE,
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

      if (totalPages > endPage && pageNumber === endPage) {
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

  return {
    get,
    getProductByGuid,
    getProductByCode,
    iterateProducts,
    countProductsModifiedSince,
    createWebhookSubscription,
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
