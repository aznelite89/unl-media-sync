import { NOTES_BASELINE_PAGE_SIZE, NOTES_OUTCOME } from '../constants/index.js';
import { driftedFields, toUpdateBody } from './customerSuburbPlan.js';
import {
  NOTES_ACTION,
  NOTES_RETRY_OUTCOMES,
  buildNotesCsv,
  clearedEntry,
  emptySnapshot,
  ordersCreatedSince,
  parseUnleashedDate,
  planNotes,
  recordedEntry,
  sameNotes,
  toUnleashedSince,
  windowStartMs,
} from './customerNotesPlan.js';
import { summarise } from './logger.js';

export { buildNotesCsv };

/**
 * Writes the snapshot's text back into one customer's Notes, then re-reads to
 * prove it landed and that nothing else moved.
 */
export async function restoreNotes({ customer, entry, unleashed, log, nowIso, base }) {
  try {
    const body = toUpdateBody({ ...customer, Notes: entry.notes }, customer.Addresses ?? []);
    await unleashed.updateCustomer(customer.Guid, body);
    const after = await unleashed.getCustomerByGuid(customer.Guid);
    const drifted = driftedFields(customer, after).filter((field) => field !== 'Notes');
    if (drifted.length) {
      log.warn?.(`notes guard: ${customer.CustomerCode} — fields other than Notes changed on write: ${drifted.join(', ')}`);
    }
    if (!sameNotes(after?.Notes, entry.notes)) {
      return { ...base, outcome: NOTES_OUTCOME.FAILED, entry, error: 'Notes still differ after the update' };
    }
    const { clearedAt, ...kept } = entry;
    return { ...base, outcome: NOTES_OUTCOME.RESTORED, drifted, entry: { ...kept, seenAt: nowIso, restoredAt: nowIso } };
  } catch (error) {
    log.error?.(`notes guard: ${customer.CustomerCode} — ${error.message}`);
    return { ...base, outcome: NOTES_OUTCOME.FAILED, entry, error: error.message };
  }
}

/**
 * Decides, and if need be restores, one customer. Returns the outcome and the
 * snapshot entry to keep for it.
 *
 * `orderSinceMs` is when the window opened: a website order created since then
 * is what marks a blanking as the connector's rather than a person's.
 */
export async function guardCustomerNotes({
  customer,
  entry,
  baseline,
  orderSinceMs,
  unleashed,
  config,
  log,
  apply,
  nowIso,
}) {
  const base = { customerCode: customer.CustomerCode, guid: customer.Guid };
  const action = planNotes(customer, entry);

  if (action === NOTES_ACTION.NONE) return { ...base, outcome: NOTES_OUTCOME.UNCHANGED, entry };
  if (action === NOTES_ACTION.RECORD) {
    const outcome = baseline ? NOTES_OUTCOME.BASELINE : NOTES_OUTCOME.RECORDED;
    return { ...base, outcome, entry: recordedEntry(customer, entry, nowIso) };
  }

  const found = await unleashed.listShopifyOrdersForCustomer(customer.CustomerCode, toUnleashedSince(orderSinceMs));
  const orders = ordersCreatedSince(found, orderSinceMs).map((order) => order.OrderNumber);

  if (action === NOTES_ACTION.REPLACE) {
    const outcome = orders.length ? NOTES_OUTCOME.REPLACED_WITH_WEB_ORDER : NOTES_OUTCOME.RECORDED;
    return { ...base, outcome, orders, entry: recordedEntry(customer, entry, nowIso) };
  }

  // NOTES_ACTION.WIPED
  if (!orders.length) return { ...base, outcome: NOTES_OUTCOME.CLEARED, entry: clearedEntry(entry, customer, nowIso) };
  if (!apply || config.dryRun) return { ...base, outcome: NOTES_OUTCOME.DRY_RUN, orders, entry };
  return restoreNotes({ customer, entry, unleashed, log, nowIso, base: { ...base, orders } });
}

/**
 * One pass of the guard.
 *
 * With no snapshot yet this is the baseline: every customer's text is recorded
 * and nothing is compared. Afterwards each pass reads only customers modified
 * since the previous whole pass (less the slack), plus any left pending by a
 * failed or dry-run restore, which keep the window they were first seen in.
 *
 * `persist` saves the snapshot. Only a whole pass (no `customerCode`) moves the
 * window on, and a report-only CLI run must not persist: a wipe it saw but did
 * not restore would otherwise fall out of the next run's window.
 *
 * @param {{ unleashed: object, store: object, config: object, log: object, apply: boolean, persist: boolean, customerCode?: string, nowMs?: number }} input
 */
export async function guardNotes({ unleashed, store, config, log, apply, persist, customerCode, nowMs = Date.now() }) {
  const { snapshot: loaded, etag } = await store.load();
  const baseline = loaded === null;
  if (baseline && customerCode) {
    throw new Error('There is no notes snapshot yet; a whole pass has to run first.');
  }

  const snapshot = loaded ?? emptySnapshot();
  const nowIso = new Date(nowMs).toISOString();
  const startMs = baseline ? null : (windowStartMs(snapshot) ?? nowMs);
  const results = [];
  const visited = new Set();
  let scanned = 0;

  async function visit(customer, orderSinceMs) {
    visited.add(customer.Guid);
    scanned += 1;
    const result = await guardCustomerNotes({
      customer,
      entry: snapshot.customers[customer.Guid],
      baseline,
      orderSinceMs,
      unleashed,
      config,
      log,
      apply,
      nowIso,
    });
    if (result.entry) snapshot.customers[customer.Guid] = result.entry;
    if (NOTES_RETRY_OUTCOMES.has(result.outcome)) {
      snapshot.pending[customer.Guid] = snapshot.pending[customer.Guid] ?? toUnleashedSince(orderSinceMs);
    } else {
      delete snapshot.pending[customer.Guid];
    }
    if (result.outcome !== NOTES_OUTCOME.UNCHANGED) results.push(result);
  }

  const pages = unleashed.iterateCustomers({
    sinceIso: baseline ? undefined : toUnleashedSince(startMs),
    customerCode,
    pageSize: baseline ? NOTES_BASELINE_PAGE_SIZE : undefined,
  });
  for await (const page of pages) {
    for (const customer of page.items) {
      // Unleashed's customerCode filter is a prefix match; keep exact only.
      if (customerCode && String(customer.CustomerCode).toLowerCase() !== customerCode.toLowerCase()) continue;
      await visit(customer, parseUnleashedDate(snapshot.pending[customer.Guid]) ?? startMs);
    }
  }

  if (!customerCode) {
    for (const [guid, since] of Object.entries(snapshot.pending)) {
      if (visited.has(guid)) continue;
      await visit(await unleashed.getCustomerByGuid(guid), parseUnleashedDate(since));
    }
    snapshot.takenAt = nowIso;
  }

  if (persist) await store.save(snapshot, etag);

  return {
    baseline,
    windowStart: startMs === null ? null : new Date(startMs).toISOString(),
    scanned,
    byOutcome: summarise(results),
    results,
    tracked: Object.keys(snapshot.customers).length,
    pending: Object.keys(snapshot.pending).length,
  };
}

/**
 * Puts one customer's snapshot text back regardless of web orders — for a
 * blanking the guard classed as `cleared` that the team says was not theirs.
 */
export async function forceRestore({ customerCode, unleashed, store, config, log, apply, nowMs = Date.now() }) {
  const { snapshot, etag } = await store.load();
  if (!snapshot) throw new Error('There is no notes snapshot yet.');
  const wanted = customerCode.toLowerCase();
  const found = Object.entries(snapshot.customers).find(([, entry]) => String(entry.code).toLowerCase() === wanted);
  if (!found) throw new Error(`The snapshot holds no notes for ${customerCode}.`);

  const [guid, entry] = found;
  const customer = await unleashed.getCustomerByGuid(guid);
  const base = { customerCode: customer.CustomerCode, guid };
  if (sameNotes(customer.Notes, entry.notes)) return { ...base, outcome: NOTES_OUTCOME.UNCHANGED, entry };
  if (!apply || config.dryRun) return { ...base, outcome: NOTES_OUTCOME.DRY_RUN, entry, current: customer.Notes };

  const nowIso = new Date(nowMs).toISOString();
  const result = await restoreNotes({ customer, entry, unleashed, log, nowIso, base });
  snapshot.customers[guid] = result.entry;
  if (result.outcome === NOTES_OUTCOME.RESTORED) delete snapshot.pending[guid];
  await store.save(snapshot, etag);
  return result;
}
