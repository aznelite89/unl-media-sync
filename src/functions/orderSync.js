import { app } from '@azure/functions';

import { loadConfig } from '../utils/config.js';
import { toLog } from '../utils/logger.js';
import { describeResult, shadowOrders, syncOrders } from '../utils/orderSync.js';
import { createBlobOrderStore } from '../utils/orderSyncStore.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Catch-up for the Shopify order webhook: every 5 minutes, any website order
 * from the last ORDER_SYNC_LOOKBACK_HOURS that is not yet in Unleashed is
 * created, and held orders (customer not identified, SKU missing) are retried
 * so that mapping a customer in Shopify admin is all the office has to do.
 * Gated by SYNC_SHOPIFY_ORDERS; ORDER_SYNC_SHADOW=true compares with the hub's
 * orders instead of creating any; DRY_RUN=true reports only.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  if (!config.syncShopifyOrders) {
    log.info('order sync: SYNC_SHOPIFY_ORDERS is off; nothing to do');
    return;
  }

  const shopify = createShopifyClient(config, log);
  const unleashed = createUnleashedClient(config, log);
  const store = createBlobOrderStore(config.orderSyncStorageConnection);

  if (config.orderSync.shadow) {
    const report = await shadowOrders({ shopify, unleashed, store, config, log });
    log.info(`order sync SHADOW: ${report.scanned} orders since ${report.since}, verdicts ${JSON.stringify(report.byVerdict)}`);
    for (const result of report.results) log.info(`order sync SHADOW: ${describeResult(result)}`);
    return;
  }

  const report = await syncOrders({ shopify, unleashed, store, config, log, apply: !config.dryRun });
  log.info(
    `order sync: ${report.scanned} orders since ${report.since}, outcomes ${JSON.stringify(report.byOutcome)}` +
      `${config.dryRun ? ' (DRY RUN)' : ''}; email ${report.emailed.delivered ? 'sent' : report.emailed.reason}`,
  );
  for (const result of report.results) log.info(`order sync: ${describeResult(result)}`);

  if (timer?.isPastDue) log.warn('order sync: timer was past due');
}

app.timer('orderSync', {
  // Every 5 minutes, offset from the media reconcile and customer upkeep.
  schedule: '0 2/5 * * * *',
  handler,
});
