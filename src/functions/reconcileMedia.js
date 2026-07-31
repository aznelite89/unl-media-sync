import { app } from '@azure/functions';

import { loadConfig } from '../utils/config.js';
import { toLog } from '../utils/logger.js';
import { lookbackSince, reconcile } from '../utils/reconcile.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Safety net for the webhook: re-reads everything Unleashed modified in the last
 * RECONCILE_LOOKBACK_MINUTES and syncs it. Covers dropped deliveries, downtime,
 * and the period before the webhook subscription existed.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  const unleashed = createUnleashedClient(config, log);
  const shopify = createShopifyClient(config, log);
  const sinceIso = lookbackSince(config.reconcileLookbackMinutes);

  log.info(`reconcile: products modified since ${sinceIso}${config.dryRun ? ' (DRY RUN)' : ''}`);

  const report = await reconcile({ sinceIso, unleashed, shopify, config, log });

  log.info(
    `reconcile: scanned ${report.scanned}, with images ${report.withImages}, ` +
      `outcomes ${JSON.stringify(report.byOutcome)}`,
  );

  if (timer?.isPastDue) log.warn('reconcile: timer was past due');
}

app.timer('reconcileMedia', {
  // Every 10 minutes.
  schedule: '0 */10 * * * *',
  handler,
});
