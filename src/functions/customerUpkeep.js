import { app } from '@azure/functions';

import { loadConfig } from '../utils/config.js';
import { guardNotes } from '../utils/customerNotes.js';
import { createBlobNotesStore } from '../utils/customerNotesStore.js';
import { fillSuburbs } from '../utils/customerSuburb.js';
import { toLog } from '../utils/logger.js';
import { lookbackSince } from '../utils/reconcile.js';
import { createUnleashedClient } from '../utils/unleashed.js';

/**
 * Repairs what the Shopify connector does to Unleashed customers on every
 * website order, in this order:
 *
 * 1. Notes guard (GUARD_CUSTOMER_NOTES). The connector copies the Shopify
 *    customer note, usually blank, over the Unleashed Notes. A snapshot of
 *    every customer's Notes is kept and a wipe that came with a website order
 *    is put back.
 * 2. Suburb fill (FILL_CUSTOMER_SUBURB). The connector puts the suburb in City
 *    and blanks Suburb; City is copied back into Suburb.
 *
 * The order matters: the suburb fill writes the whole customer record back as
 * it read it, Notes included, so it has to read after the notes are restored.
 * Running both in one timer is what guarantees that. DRY_RUN=true reports only.
 */
async function guardCustomerNotes(config, unleashed, log) {
  const store = createBlobNotesStore(config.notesStorageConnection);
  const report = await guardNotes({ unleashed, store, config, log, apply: true, persist: true });

  log.info(
    `notes guard: ${report.baseline ? 'BASELINE — ' : ''}scanned ${report.scanned} since ${report.windowStart ?? 'the beginning'}, ` +
      `outcomes ${JSON.stringify(report.byOutcome)}, tracking ${report.tracked}, pending ${report.pending}` +
      `${config.dryRun ? ' (DRY RUN)' : ''}`,
  );
  if (report.baseline) return;
  for (const result of report.results) {
    const orders = result.orders?.length ? ` web orders ${result.orders.join(', ')}` : '';
    const line = `notes guard: ${result.customerCode} ${result.outcome}${orders}${result.error ? ` — ${result.error}` : ''}`;
    if (result.error) log.warn(line);
    else log.info(line);
  }
}

async function fillCustomerSuburbs(config, unleashed, log) {
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
}

async function handler(timer, context) {
  const log = toLog(context);
  const config = loadConfig();

  if (!config.guardCustomerNotes && !config.fillCustomerSuburb) {
    log.info('customer upkeep: GUARD_CUSTOMER_NOTES and FILL_CUSTOMER_SUBURB are both off; nothing to do');
    return;
  }

  const unleashed = createUnleashedClient(config, log);
  let notesError = null;

  if (config.guardCustomerNotes) {
    try {
      await guardCustomerNotes(config, unleashed, log);
    } catch (error) {
      // The suburb fill still runs: its write carries Notes as it reads them,
      // so it can't make a wipe worse, and the snapshot window has not moved,
      // so the next run looks at the same customers again.
      notesError = error;
      log.error(`notes guard: run failed — ${error.message}`);
    }
  }

  if (config.fillCustomerSuburb) await fillCustomerSuburbs(config, unleashed, log);

  if (timer?.isPastDue) log.warn('customer upkeep: timer was past due');
  if (notesError) throw notesError;
}

app.timer('customerUpkeep', {
  // Every 15 minutes, offset from the media reconcile.
  schedule: '0 5/15 * * * *',
  handler,
});
