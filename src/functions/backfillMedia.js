import { app } from '@azure/functions';

import { HTTP_STATUS } from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { toLog } from '../utils/logger.js';
import { lookbackSince, reconcile, syncByProductCode } from '../utils/reconcile.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Operator-triggered sync, protected by the function key. Used for the initial
 * catch-up over the existing catalogue and for checking a single SKU.
 *
 *   POST /api/unleashed/backfill?sku=9KCH37145CM
 *   POST /api/unleashed/backfill?since=2026-01-01&limit=25&dryRun=true
 *   POST /api/unleashed/backfill?all=true            // whole catalogue
 */
async function handler(request, context) {
  const log = toLog(context);
  const config = loadConfig();

  const url = new URL(request.url);
  const sku = url.searchParams.get('sku');
  const since = url.searchParams.get('since');
  const all = url.searchParams.get('all') === 'true';
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10) || undefined;

  // Per-request override so a first pass can be rehearsed without writing.
  if (url.searchParams.get('dryRun') === 'true') config.dryRun = true;

  const unleashed = createUnleashedClient(config, log);
  const shopify = createShopifyClient(config, log);

  try {
    if (sku) {
      const result = await syncByProductCode({
        productCode: sku,
        unleashed,
        shopify,
        config,
        log,
      });
      return { status: HTTP_STATUS.OK, jsonBody: { dryRun: config.dryRun, result } };
    }

    if (!all && !since) {
      return {
        status: HTTP_STATUS.BAD_REQUEST,
        jsonBody: { error: 'pass one of ?sku=, ?since=YYYY-MM-DD, or ?all=true' },
      };
    }

    const sinceIso = all ? undefined : (since ?? lookbackSince(config.reconcileLookbackMinutes));
    log.info(
      `backfill: ${all ? 'whole catalogue' : `since ${sinceIso}`}` +
        `${limit ? `, limit ${limit}` : ''}${config.dryRun ? ' (DRY RUN)' : ''}`,
    );

    const report = await reconcile({ sinceIso, limit, unleashed, shopify, config, log });
    return { status: HTTP_STATUS.OK, jsonBody: { dryRun: config.dryRun, ...report } };
  } catch (error) {
    log.error(`backfill failed — ${error.message}`);
    return { status: HTTP_STATUS.INTERNAL_SERVER_ERROR, jsonBody: { error: error.message } };
  }
}

app.http('backfillMedia', {
  methods: ['POST', 'GET'],
  authLevel: 'function',
  route: 'unleashed/backfill',
  handler,
});
