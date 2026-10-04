import { app } from '@azure/functions';

import { EMAIL_SUBJECT_TAG, SYNC_HEALTH } from '../constants/index.js';
import { loadConfig } from '../utils/config.js';
import { toAttachment } from '../utils/email.js';
import { toLog } from '../utils/logger.js';
import { auditMissingImages } from '../utils/missingImages.js';
import { sendReport } from '../utils/notify.js';
import { buildMissingImagesCsv, buildMissingImagesSummary } from '../utils/report.js';
import { createShopifyClient } from '../utils/shopify.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Weekly list of products with no image.
 *
 * Emails the office every product created in Unleashed in the last
 * `MISSING_IMAGE_MONTHS` months (default 12) that holds no image, so someone
 * can upload one. Nothing else reports these: the sync skips a product with no
 * images and the catalogue audit only counts products that have them.
 *
 * Read-only: it never touches Shopify or Unleashed data.
 */
async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  let audit;
  try {
    audit = await auditMissingImages({
      unleashed: createUnleashedClient(config, log),
      shopify: createShopifyClient(config, log),
      config,
    });
  } catch (error) {
    log.error(`weekly missing images: failed — ${error.message}`);
    await sendReport({
      config,
      summary: {
        health: SYNC_HEALTH.ALERT,
        subject: `[${EMAIL_SUBJECT_TAG.alert}] Products without images — the weekly list could not be built`,
        text:
          'The weekly check for products without images errored before it could produce a list.\n\n' +
          `  ${error.message}\n`,
      },
      log,
    });
    return;
  }

  const summary = buildMissingImagesSummary({ audit });

  // Only attach a CSV when there is something to work through.
  const attachments = audit.missing.length
    ? [toAttachment('products-without-images.csv', buildMissingImagesCsv(audit))]
    : [];

  const delivery = await sendReport({ config, summary, attachments, log });
  log.info(
    `weekly missing images: ${audit.missing.length} without an image of ${audit.recent} created since ${audit.cutoff}, ` +
      `delivered=${delivery.delivered}${delivery.reason ? ` (${delivery.reason})` : ''}`,
  );

  if (timer?.isPastDue) log.warn('weekly missing images: timer was past due');
}

app.timer('weeklyMissingImages', {
  // Sunday 23:30 UTC = Monday 09:30 AEST. Half an hour after `weeklyDuplicateAudit`,
  // so the three Monday reports never contend for the same Shopify quota.
  schedule: '0 30 23 * * 0',
  handler,
});
