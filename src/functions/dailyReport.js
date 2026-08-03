import { app } from '@azure/functions';

import { EMAIL_SUBJECT_TAG, SYNC_HEALTH } from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { toAttachment } from '../utils/email.js';
import { toLog } from '../utils/logger.js';
import { sendReport } from '../utils/notify.js';
import { reconcile } from '../utils/reconcile.js';
import { buildDailyCsv, buildDailySummary, orderedProblemDetails } from '../utils/report.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/** Unleashed wants a naive ISO timestamp, no milliseconds. */
function isoDaysAgo(days, nowMs = Date.now()) {
  return new Date(nowMs - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '');
}

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

  const sinceIso = isoDaysAgo(config.dailyLookbackHours / 24);
  log.info(`daily report: verifying changes since ${sinceIso}`);

  let report;
  try {
    report = await reconcile({ sinceIso, unleashed, shopify, config, log });
  } catch (error) {
    // The check itself failing is the loudest possible signal.
    log.error(`daily report: verification pass failed — ${error.message}`);
    await sendReport({
      config,
      summary: {
        health: SYNC_HEALTH.ALERT,
        subject: `[${EMAIL_SUBJECT_TAG.alert}] Image sync — the daily check could not run`,
        text:
          'The daily verification pass errored before it could check anything.\n\n' +
          `  ${error.message}\n\n` +
          'This usually means the Unleashed or Shopify credentials expired, or one of\n' +
          'those services was unreachable. Until it succeeds, nothing is verifying that\n' +
          'the image sync is working.',
      },
      log,
    });
    return;
  }

  // Nothing changed at all. Widen the window before deciding whether that is a
  // quiet day or a sync that has stopped seeing Unleashed.
  let activity = null;
  if (report.scanned === 0) {
    const probeDays = config.zeroActivityProbeDays;
    try {
      const probeCount = await unleashed.countProductsModifiedSince(isoDaysAgo(probeDays));
      activity = { probeDays, probeCount };
      log.info(`daily report: no changes in the window; ${probeCount} in the last ${probeDays}d`);
    } catch (error) {
      // The probe is a refinement, not the report. Losing it downgrades the
      // verdict's precision; it must not lose the report itself.
      log.warn(`daily report: activity probe failed — ${error.message}`);
    }
  }

  const summary = buildDailySummary({
    report,
    pendingWarnThreshold: config.pendingWarnThreshold,
    lookbackHours: config.dailyLookbackHours,
    activity,
  });

  // The email names the products inline; the CSV is what survives a long day
  // without being truncated, and can be sorted and worked through.
  const problems = orderedProblemDetails(report);
  const attachments = problems.length
    ? [toAttachment('image-sync-detail.csv', buildDailyCsv(report))]
    : [];

  const delivery = await sendReport({ config, summary, attachments, log });
  log.info(
    `daily report: ${summary.health}, ${problems.length} product(s) listed, ` +
      `delivered=${delivery.delivered}` +
      (delivery.reason ? ` (${delivery.reason})` : ''),
  );

  if (timer?.isPastDue) log.warn('daily report: timer was past due');
}

app.timer('dailyReport', {
  // 22:00 UTC = 08:00 AEST, so it lands before the team starts.
  schedule: '0 0 22 * * *',
  handler,
});
