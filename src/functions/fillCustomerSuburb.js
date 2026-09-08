import { app } from '@azure/functions';

import { loadConfig } from '../utils/config.js';
import { fillSuburbs } from '../utils/customerSuburb.js';
import { toLog } from '../utils/logger.js';
import { lookbackSince } from '../utils/reconcile.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Keeps Unleashed customer suburbs filled after the Shopify connector writes.
 *
 * The connector re-writes a customer's Postal address on every Shopify order,
 * putting the suburb in City and blanking Suburb again, so a one-off backfill
 * would not stay fixed. This re-reads everything modified in the last
 * SUBURB_LOOKBACK_MINUTES and fills whatever came back empty.
 *
 * Does nothing until FILL_CUSTOMER_SUBURB=true; DRY_RUN=true reports only.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  if (!config.fillCustomerSuburb) {
    log.info('suburb fill: FILL_CUSTOMER_SUBURB is off; nothing to do');
    return;
  }

  const unleashed = createUnleashedClient(config, log);
  const sinceIso = lookbackSince(config.suburbLookbackMinutes);
  log.info(`suburb fill: customers modified since ${sinceIso}${config.dryRun ? ' (DRY RUN)' : ''}`);

  const report = await fillSuburbs({ sinceIso, apply: true, unleashed, config, log });

  log.info(`suburb fill: scanned ${report.scanned}, outcomes ${JSON.stringify(report.byOutcome)}`);
  for (const result of report.results) {
    const what = result.changes.map((change) => `${change.addressType}=${change.city}`).join('; ');
    log.info(
      `suburb fill: ${result.customerCode} ${result.outcome} ${what}${result.error ? ` — ${result.error}` : ''}`,
    );
  }
  if (timer?.isPastDue) log.warn('suburb fill: timer was past due');
}

app.timer('fillCustomerSuburb', {
  // Every 15 minutes, offset from the media reconcile.
  schedule: '0 5/15 * * * *',
  handler,
});
