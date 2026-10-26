import crypto from 'node:crypto';

import { app } from '@azure/functions';

import { HTTP_STATUS, ORDER_SYNC_OUTCOME, SHOPIFY_WEBHOOK_HEADER } from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { toLog } from '../utils/logger.js';
import { describeResult, importOrder, sendProblemEmail, toStateEntry } from '../utils/orderSync.js';
import { createBlobOrderStore } from '../utils/orderSyncStore.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Shopify signs each delivery with base64 HMAC-SHA256 of the raw body, keyed
 * on the custom app's API secret key.
 */
export function verifyShopifyWebhook({ rawBody, signature, secret }) {
  if (!signature) return { valid: false, reason: 'missing signature header' };
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const actual = Buffer.from(signature, 'base64');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}

/**
 * Receives `orders/create` from Shopify and creates that order in Unleashed.
 *
 * The delivery body is only used for the order id: the order is re-read
 * through GraphQL so the webhook and the timer build from the same fields.
 * A 500 makes Shopify retry (for up to 48 hours), and the 5-minute timer
 * covers anything that still slips through.
 */
async function handler(request, context) {
  const log = toLog(context);
  const rawBody = await request.text();

  let config;
  try {
    config = loadConfig({ requireShopifyWebhookSecret: true });
  } catch (error) {
    log.error(`order webhook: ${error.message}`);
    return { status: HTTP_STATUS.INTERNAL_SERVER_ERROR, jsonBody: { error: 'not configured' } };
  }

  const verification = verifyShopifyWebhook({
    rawBody,
    signature: request.headers.get(SHOPIFY_WEBHOOK_HEADER.HMAC),
    secret: config.shopify.webhookSecret,
  });
  if (!verification.valid) {
    log.warn(`order webhook: rejected — ${verification.reason}`);
    return { status: HTTP_STATUS.UNAUTHORIZED, jsonBody: { error: verification.reason } };
  }

  const shopDomain = request.headers.get(SHOPIFY_WEBHOOK_HEADER.SHOP_DOMAIN);
  if (shopDomain && shopDomain !== config.shopify.storeDomain) {
    log.warn(`order webhook: delivery for ${shopDomain}, not ${config.shopify.storeDomain}`);
    return { status: HTTP_STATUS.OK, jsonBody: { ignored: shopDomain } };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: 'body is not JSON' } };
  }
  const orderId = payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Order/${payload.id}` : null);
  if (!orderId) return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: 'no order id in payload' } };

  if (config.orderSync.shadow) {
    log.info(`order webhook: shadow run; ${payload?.name ?? orderId} left to the timer to compare`);
    return { status: HTTP_STATUS.OK, jsonBody: { ignored: 'shadow' } };
  }
  if (!config.syncShopifyOrders) {
    log.info(`order webhook: SYNC_SHOPIFY_ORDERS is off; ${payload?.name ?? orderId} acknowledged, not imported`);
    return { status: HTTP_STATUS.OK, jsonBody: { ignored: 'sync off' } };
  }

  const shopify = createShopifyClient(config, log);
  const unleashed = createUnleashedClient(config, log);

  try {
    const orderNode = await shopify.getOrder(orderId);
    if (!orderNode) return { status: HTTP_STATUS.OK, jsonBody: { ignored: 'order not found' } };

    // Synchronous on purpose: work after the response is not guaranteed to finish.
    const result = await importOrder({ orderNode, unleashed, config, log, apply: !config.dryRun });
    log.info(`order webhook: ${describeResult(result)}`);

    try {
      const store = createBlobOrderStore(config.orderSyncStorageConnection);
      const { state, etag } = await store.load();
      const nowIso = new Date().toISOString();
      const entry = toStateEntry(result, nowIso);
      if (result.outcome !== ORDER_SYNC_OUTCOME.CREATED && result.outcome !== ORDER_SYNC_OUTCOME.EXISTS) {
        const emailed = await sendProblemEmail({ results: [result], config, log });
        if (emailed.delivered) entry.emailedAt = nowIso;
      }
      state.orders[result.id] = entry;
      await store.save(state, etag);
    } catch (error) {
      // The timer re-reads Unleashed and the state on its next pass.
      log.warn(`order webhook: state not saved — ${error.message}`);
    }

    const transient = result.outcome === ORDER_SYNC_OUTCOME.FAILED;
    const { body, ...summary } = result;
    return { status: transient ? HTTP_STATUS.INTERNAL_SERVER_ERROR : HTTP_STATUS.OK, jsonBody: summary };
  } catch (error) {
    log.error(`order webhook: ${orderId} — ${error.message}`);
    return { status: HTTP_STATUS.INTERNAL_SERVER_ERROR, jsonBody: { error: error.message, orderId } };
  }
}

app.http('shopifyOrderWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'shopify/order-webhook',
  handler,
});
