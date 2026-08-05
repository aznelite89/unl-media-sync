import { app } from '@azure/functions';

import { EMAIL_SUBJECT_TAG, SYNC_HEALTH } from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { auditDuplicates } from '../utils/duplicates.js';
import { toAttachment } from '../utils/email.js';
import { toLog } from '../utils/logger.js';
import { sendReport } from '../utils/notify.js';
import { buildDuplicateCsv, buildDuplicateSummary } from '../utils/report.js';
import { createShopifyClient } from '../utils/shopify.js';

/**
 * Weekly whole-store duplicate census.
 *
 * The daily report also counts duplicates, but only across the products it
 * synced that day — and a second writer can put a copy on a product Unleashed
 * has not touched, which the daily pass never visits. This pass looks at every
 * product, so it is the number that can be trusted as a total.
 *
 * Deliberately its own function rather than part of `weeklyAudit`: `host.json`
 * caps an invocation at 10 minutes, that audit already spends a couple, and a
 * sweep killed by the host would send NO email at all — the precise silent
 * failure this watch exists to prevent. Its own function means its own budget.
 *
 * Read-only, and hard-coded so: `apply: false` is a literal, not a setting.
 * There is deliberately no app setting that could turn a reporting job into a
 * writer. Repair stays a human act: `sync-cli.js --duplicates --apply`, taken
 * after confirming any other writer is switched off.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();
  const shopify = createShopifyClient(config, log);

  let audit;
  try {
    audit = await auditDuplicates({ shopify, log, apply: false });
  } catch (error) {
    log.error(`weekly duplicate audit: failed — ${error.message}`);
    await sendReport({
      config,
      summary: {
        health: SYNC_HEALTH.ALERT,
        subject: `[${EMAIL_SUBJECT_TAG.alert}] Image sync — the duplicate scan could not run`,
        text:
          'The weekly duplicate scan errored before it could produce a list.\n\n' +
          `  ${error.message}\n\n` +
          'Until it succeeds, nothing is checking whether a second integration has\n' +
          'started putting duplicate copies of product photos into Shopify.',
      },
      log,
    });
    return;
  }

  const summary = buildDuplicateSummary({ audit });

  // Only attach a CSV when there is something to work through.
  const attachments = audit.products.length
    ? [toAttachment('image-sync-duplicates.csv', buildDuplicateCsv(audit))]
    : [];

  const delivery = await sendReport({ config, summary, attachments, log });
  log.info(
    `weekly duplicate audit: ${audit.products.length} product(s) affected, ` +
      `${audit.wastedSlots} wasted slot(s), ${audit.foreignGroups} from another writer, ` +
      `delivered=${delivery.delivered}${delivery.reason ? ` (${delivery.reason})` : ''}`,
  );

  if (timer?.isPastDue) log.warn('weekly duplicate audit: timer was past due');
}

app.timer('weeklyDuplicateAudit', {
  // Sunday 23:00 UTC = Monday 09:00 AEST. Half an hour after `weeklyAudit` so the
  // two never share an invocation budget or contend for the same Shopify quota.
  schedule: '0 0 23 * * 0',
  handler,
});
