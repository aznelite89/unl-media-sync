import { app } from '@azure/functions';

import { EMAIL_SUBJECT_TAG, SYNC_HEALTH } from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { toAttachment } from '../utils/email.js';
import { toLog } from '../utils/logger.js';
import { sendReport } from '../utils/notify.js';
import { buildWeeklySpecialsCsv, buildWeeklySpecialsSummary } from '../utils/report.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';
import { syncWeeklySpecials } from '../utils/weeklySpecials.js';

/**
 * Picks This Week Specials every Monday: 12 each of chains & bracelets,
 * earrings, rings and pendants, from warehouse stock of suppliers Searay no
 * longer buys from, where nothing in the same bin has sold in 24 months,
 * oldest landed first. Moves the `weekly-special` tag, orders the collection,
 * and emails the office the picks. No-op until SYNC_WEEKLY_SPECIALS is true;
 * DRY_RUN=true reports only.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  if (!config.syncWeeklySpecials) {
    log.info('weekly specials: SYNC_WEEKLY_SPECIALS is off; nothing to do');
    return;
  }

  let report;
  try {
    report = await syncWeeklySpecials({
      unleashed: createUnleashedClient(config, log),
      shopify: createShopifyClient(config, log),
      config,
      log,
      apply: true,
    });
  } catch (error) {
    log.error(`weekly specials: failed — ${error.message}`);
    await sendReport({
      config,
      summary: {
        health: SYNC_HEALTH.ALERT,
        subject: `[${EMAIL_SUBJECT_TAG.alert}] This Week Specials — this week's picks could not be made`,
        text:
          "The weekly specials job errored before it picked anything; last week's specials are still showing.\n\n" +
          `  ${error.message}\n`,
      },
      log,
    });
    return;
  }

  log.info(
    `weekly specials: ${report.specials.length} picked of ${report.qualifying} qualifying, ` +
      `outcomes ${JSON.stringify(report.byOutcome)}, ` +
      `order: ${report.ordering.status}${report.dryRun ? ' (DRY RUN)' : ''}`,
  );
  for (const result of report.results) {
    const line = `weekly specials: ${result.outcome} ${result.code} ${result.productId}${result.error ? ` — ${result.error}` : ''}`;
    if (result.error) log.warn(line);
    else log.info(line);
  }

  const attachments = [toAttachment('this-week-specials.csv', buildWeeklySpecialsCsv(report))];
  const delivery = await sendReport({
    config,
    summary: buildWeeklySpecialsSummary({ report }),
    attachments,
    log,
  });
  log.info(`weekly specials: email delivered=${delivery.delivered}${delivery.reason ? ` (${delivery.reason})` : ''}`);

  if (timer?.isPastDue) log.warn('weekly specials: timer was past due');
}

app.timer('weeklySpecials', {
  // Sunday 18:30 UTC = Monday 04:30 AEST, before the shop opens and after the 04:15 New Arrivals run.
  schedule: '0 30 18 * * 0',
  handler,
});
