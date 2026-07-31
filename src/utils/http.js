import { HTTP_STATUS, RETRY } from '../constants/index.js';

const RETRYABLE_STATUSES = new Set([
  HTTP_STATUS.TOO_MANY_REQUESTS,
  500,
  502,
  503,
  504,
]);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(RETRY.BASE_DELAY_MS * 2 ** (attempt - 1), RETRY.MAX_DELAY_MS);
}

/**
 * `fetch` with retry on transient failures and on 429 (honouring Retry-After).
 * Non-retryable responses are returned as-is for the caller to interpret.
 *
 * @param {() => Promise<Response>} send Builds and sends the request. Called
 *   afresh per attempt so signed requests can be re-signed if needed.
 */
export async function fetchWithRetry(send, { label = 'request', log = console } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= RETRY.MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await send();
    } catch (error) {
      lastError = error;
      if (attempt === RETRY.MAX_ATTEMPTS) break;
      const delay = backoffMs(attempt);
      log.warn?.(`${label}: network error (${error.message}); retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === RETRY.MAX_ATTEMPTS) {
      return response;
    }

    const retryAfter = Number.parseFloat(response.headers.get('retry-after') ?? '');
    const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs(attempt);
    log.warn?.(`${label}: HTTP ${response.status}; retrying in ${delay}ms`);
    await sleep(delay);
  }

  throw lastError ?? new Error(`${label}: exhausted retries`);
}
