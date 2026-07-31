import { app } from '@azure/functions';

import { SYNC_HEALTH } from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { toLog } from '../utils/logger.js';
import { sendDailySummary } from '../utils/notify.js';
import { reconcile } from '../utils/reconcile.js';
import { buildDailySummary, summariseProblems } from '../utils/report.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Daily verification pass.
 *
 * Re-checks the last day's Unleashed changes in dry-run mode and reports what
 * it finds. The webhook and the 10-minute timer should already have handled all
 * of it, so anything still pending means the live sync is failing or behind —
 * which is otherwise invisible, since a broken sync looks exactly like a quiet
 * day.
 *
 * This pass NEVER writes: config.dryRun is forced on regardless of the app
 * setting, so a reporting job can't quietly become a second writer.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = { ...loadConfig(), dryRun: true };

  const unleashed = createUnleashedClient(config, log);
  const shopify = createShopifyClient(config, log);

  const sinceIso = new Date(Date.now() - config.dailyLookbackHours * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, '');

  log.info(`daily report: verifying changes since ${sinceIso}`);

  let report;
  try {
    report = await reconcile({ sinceIso, unleashed, shopify, config, log });
  } catch (error) {
    // The check itself failing is the loudest possible signal.
    log.error(`daily report: verification pass failed — ${error.message}`);
    await sendDailySummary({
      config,
      summary: {
        health: SYNC_HEALTH.ALERT,
        text:
          ':rotating_light: *Image sync check could not run*\n\n' +
          `The daily verification pass errored: \`${error.message}\`\n` +
          'This usually means credentials expired or Unleashed/Shopify is unreachable.',
      },
      log,
    });
    return;
  }

  const summary = buildDailySummary({
    report,
    pendingWarnThreshold: config.pendingWarnThreshold,
    lookbackHours: config.dailyLookbackHours,
  });

  // Name the offending products only when something is actually wrong.
  const extra = summary.health === SYNC_HEALTH.OK ? null : summariseProblems(report);

  const delivery = await sendDailySummary({ config, summary, extra, log });
  log.info(
    `daily report: ${summary.health}, delivered=${delivery.delivered}` +
      (delivery.reason ? ` (${delivery.reason})` : ''),
  );

  if (timer?.isPastDue) log.warn('daily report: timer was past due');
}

app.timer('dailyReport', {
  // 22:00 UTC = 08:00 AEST, so it lands before the team starts.
  schedule: '0 0 22 * * *',
  handler,
});
