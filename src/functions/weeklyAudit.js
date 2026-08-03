import { app } from '@azure/functions';

import { EMAIL_SUBJECT_TAG, SYNC_HEALTH } from '../constants/index.js';
import { auditCatalogue } from '../utils/audit.js';
import { loadConfig } from '../utils/config.js';
import { toAttachment } from '../utils/email.js';
import { toLog } from '../utils/logger.js';
import { sendReport } from '../utils/notify.js';
import { buildAuditCsv, buildAuditSummary } from '../utils/report.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Weekly whole-catalogue audit.
 *
 * Finds Unleashed products that hold images but have no matching Shopify SKU —
 * photographed stock that can never appear on the website. The daily report
 * cannot see these because it only looks at the last 24 hours of changes, so
 * without this pass the backlog is invisible and simply rots.
 *
 * Read-only: it never touches Shopify or Unleashed data, only reads and diffs.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  const unleashed = createUnleashedClient(config, log);
  const shopify = createShopifyClient(config, log);

  let audit;
  try {
    audit = await auditCatalogue({ unleashed, shopify, log });
  } catch (error) {
    log.error(`weekly audit: failed — ${error.message}`);
    await sendReport({
      config,
      summary: {
        health: SYNC_HEALTH.ALERT,
        subject: `[${EMAIL_SUBJECT_TAG.alert}] Image sync — the weekly audit could not run`,
        text:
          'The weekly catalogue audit errored before it could produce a list.\n\n' +
          `  ${error.message}\n`,
      },
      log,
    });
    return;
  }

  const summary = buildAuditSummary({ audit });

  // Only attach a CSV when there is something to work through.
  const attachments = audit.unmatched.length
    ? [toAttachment('unmatched-skus.csv', buildAuditCsv(audit))]
    : [];

  const delivery = await sendReport({ config, summary, attachments, log });
  log.info(
    `weekly audit: ${audit.unmatched.length} unmatched of ${audit.withImages} with images, ` +
      `delivered=${delivery.delivered}${delivery.reason ? ` (${delivery.reason})` : ''}`,
  );

  if (timer?.isPastDue) log.warn('weekly audit: timer was past due');
}

app.timer('weeklyAudit', {
  // Sunday 22:30 UTC = Monday 08:30 AEST, so the worklist lands at the start of
  // the week rather than on a Friday afternoon.
  schedule: '0 30 22 * * 0',
  handler,
});
