import { app } from '@azure/functions';

import {
  HTTP_STATUS,
  SUBSCRIBED_EVENTS,
  UNLEASHED_HEADER,
} from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { toLog } from '../utils/logger.js';
import { syncByGuid } from '../utils/reconcile.js';
import { createShopifyClient } from '../utils/shopify.js';
import {
  createUnleashedClient,
  readWebhookProductGuid,
  verifyWebhook,
} from '../utils/unleashed.js';

/**
 * Receives `product.created` / `product.updated` from Unleashed and syncs that
 * one product's images into Shopify.
 *
 * The route is anonymous by design: authenticity comes from the HMAC signature
 * over `{timestamp}.{body}`, which is stronger than a URL key and cannot leak
 * through logs or referrers. An unsigned or stale request is rejected outright.
 */
async function handler(request, context) {
  const log = toLog(context);

  // Read raw text first — re-serialising JSON would change the signed bytes.
  const rawBody = await request.text();

  let config;
  try {
    config = loadConfig({ requireWebhookKey: true });
  } catch (error) {
    log.error(`webhook: ${error.message}`);
    return { status: HTTP_STATUS.INTERNAL_SERVER_ERROR, jsonBody: { error: 'not configured' } };
  }

  const verification = verifyWebhook({
    rawBody,
    signature: request.headers.get(UNLEASHED_HEADER.WEBHOOK_SIGNATURE),
    timestamp: request.headers.get(UNLEASHED_HEADER.WEBHOOK_TIMESTAMP),
    signatureKey: config.unleashed.webhookSignatureKey,
  });
  if (!verification.valid) {
    log.warn(`webhook: rejected — ${verification.reason}`);
    return { status: HTTP_STATUS.UNAUTHORIZED, jsonBody: { error: verification.reason } };
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: 'body is not JSON' } };
  }

  const eventType = envelope?.eventType;
  if (!SUBSCRIBED_EVENTS.includes(eventType)) {
    // Acknowledge so Unleashed does not retry an event we deliberately ignore.
    log.info(`webhook: ignoring ${eventType}`);
    return { status: HTTP_STATUS.OK, jsonBody: { ignored: eventType } };
  }

  const guid = readWebhookProductGuid(envelope);
  if (!guid) {
    log.warn(`webhook: ${eventType} carried no productGuid`);
    return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: 'no productGuid in payload' } };
  }

  const unleashed = createUnleashedClient(config, log);
  const shopify = createShopifyClient(config, log);

  try {
    // Synchronous on purpose: work started after the response returns is not
    // guaranteed to run to completion on Functions.
    const result = await syncByGuid({ guid, unleashed, shopify, config, log });
    log.info(
      `webhook: ${eventType} ${result.productCode ?? guid} → ${result.outcome}` +
        (result.notes?.length ? ` (${result.notes.join('; ')})` : ''),
    );
    return { status: HTTP_STATUS.OK, jsonBody: result };
  } catch (error) {
    // A 500 makes Unleashed retry with backoff, which is what we want.
    log.error(`webhook: sync failed for ${guid} — ${error.message}`);
    return {
      status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
      jsonBody: { error: error.message, productGuid: guid },
    };
  }
}

app.http('unleashedWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'unleashed/product-webhook',
  handler,
});
