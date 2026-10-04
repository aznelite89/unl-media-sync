import { app } from '@azure/functions';

import { loadConfig } from '../utils/config.js';
import { toLog } from '../utils/logger.js';
import { syncNewArrivals } from '../utils/newArrivals.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Keeps the New Arrivals collection to products created in Unleashed in the
 * last six months: tags them `new-arrival`, untags the ones that aged out, and
 * orders the collection newest first. The collection's rule adds "in stock".
 * No-op until SYNC_NEW_ARRIVALS is true; DRY_RUN=true reports only.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  if (!config.syncNewArrivals) {
    log.info('new arrivals: SYNC_NEW_ARRIVALS is off; nothing to do');
    return;
  }

  const report = await syncNewArrivals({
    unleashed: createUnleashedClient(config, log),
    shopify: createShopifyClient(config, log),
    config,
    log,
    apply: true,
  });

  log.info(
    `new arrivals: created since ${report.cutoff}, ${report.recent} Unleashed codes -> ${report.wanted} products ` +
      `(${report.taggedBefore} tagged before), outcomes ${JSON.stringify(report.byOutcome)}, ` +
      `unmatched ${report.unmatched.length}, ambiguous ${report.ambiguous.length}, order: ${report.ordering.status}` +
      `${report.dryRun ? ' (DRY RUN)' : ''}`,
  );
  for (const result of report.results) {
    const line = `new arrivals: ${result.outcome} ${result.code} ${result.productId}${result.error ? ` — ${result.error}` : ''}`;
    if (result.error) log.warn(line);
    else log.info(line);
  }
  if (timer?.isPastDue) log.warn('new arrivals: timer was past due');
}

app.timer('newArrivals', {
  // 18:15 UTC = 04:15 AEST, before the shop opens and clear of the 22:00 daily report.
  schedule: '0 15 18 * * *',
  handler,
});
