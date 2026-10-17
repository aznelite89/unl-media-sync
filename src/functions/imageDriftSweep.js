import { app } from '@azure/functions';

import { loadConfig } from '../utils/config.js';
import { sweepImageDrift } from '../utils/imageDrift.js';
import { summarise, toLog } from '../utils/logger.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Nightly safety net for changes Unleashed never reports. Adding or replacing an
 * image attachment leaves LastModifiedOn alone, so neither the webhook nor the
 * 10-minute reconcile can be relied on to see it. This compares every product's
 * images with the state metafield and syncs whatever has drifted.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  const unleashed = createUnleashedClient(config, log);
  const shopify = createShopifyClient(config, log);

  const report = await sweepImageDrift({ unleashed, shopify, config, log, apply: true });

  log.info(
    `drift: scanned ${report.scanned}, drifted ${report.drifted}, deferred ${report.deferred}, ` +
      `outcomes ${JSON.stringify(summarise(report.results))}${config.dryRun ? ' (DRY RUN)' : ''}`,
  );

  if (report.truncated) log.warn('drift: the Unleashed read stopped short; raise AUDIT_MAX_PAGES');
  if (timer?.isPastDue) log.warn('drift: timer was past due');
}

app.timer('imageDriftSweep', {
  // 17:00 UTC = 03:00 AEST, clear of the 04:15 New Arrivals and Monday 04:30 specials runs.
  schedule: '0 0 17 * * *',
  handler,
});
