import { NOTES_BASELINE_PAGE_SIZE, RESTORE_OUTCOME } from '../constants/index.js';
import { buildLookups, buildRestoreCsv, changesLanded, planRestore } from './customerFieldsRestorePlan.js';
import { driftedFields, toUpdateBody } from './customerSuburbPlan.js';
import { summarise } from './logger.js';

export { buildRestoreCsv };

/**
 * Restores one customer's blank fields from its export row.
 *
 * `apply` is the write switch; `config.dryRun` wins over it. The whole record
 * goes back with the planned fields written over it, then the customer is
 * re-read: the outcome is `restored` only if every planned field landed, and
 * any other top-level field that moved is reported.
 */
export async function restoreCustomerFields({ customer, row, lookups, unleashed, config, log, apply }) {
  const base = { customerCode: customer.CustomerCode, guid: customer.Guid, before: customer };
  if (!row) return { ...base, outcome: RESTORE_OUTCOME.NOT_IN_EXPORT, changes: {}, kept: [], problems: [] };

  const { changes, kept, problems } = planRestore(customer, row, lookups);
  const planned = { ...base, changes, kept, problems };
  if (Object.keys(changes).length === 0) return { ...planned, outcome: RESTORE_OUTCOME.UNCHANGED };
  if (!apply || config.dryRun) return { ...planned, outcome: RESTORE_OUTCOME.DRY_RUN };

  try {
    await unleashed.updateCustomer(customer.Guid, toUpdateBody({ ...customer, ...changes }, customer.Addresses ?? []));
    const after = await unleashed.getCustomerByGuid(customer.Guid);
    const drifted = driftedFields(customer, after).filter((field) => !(field in changes));
    if (drifted.length) {
      log.warn?.(`fields restore: ${customer.CustomerCode} — fields not planned changed on write: ${drifted.join(', ')}`);
    }
    if (!changesLanded(changes, after)) {
      return { ...planned, outcome: RESTORE_OUTCOME.FAILED, drifted, error: 'a planned field still differs after the update' };
    }
    return { ...planned, outcome: RESTORE_OUTCOME.RESTORED, drifted };
  } catch (error) {
    log.error?.(`fields restore: ${customer.CustomerCode} — ${error.message}`);
    return { ...planned, outcome: RESTORE_OUTCOME.FAILED, error: error.message };
  }
}

/**
 * Restores every listed customer code. One pass over all production customers
 * first, for the Guid behind each code and for the salesperson and warehouse
 * objects the API wants; then each customer is re-read just before its write.
 *
 * @param {{ exportByCode: Map<string, object>, codes: string[], limit?: number, apply: boolean, unleashed: object, config: object, log: object }} input
 */
export async function restoreCustomers({ exportByCode, codes, limit, apply, unleashed, config, log }) {
  const all = [];
  for await (const page of unleashed.iterateCustomers({ pageSize: NOTES_BASELINE_PAGE_SIZE })) all.push(...page.items);
  const lookups = buildLookups(all);
  const guidByCode = new Map(all.map((customer) => [String(customer.CustomerCode).toLowerCase(), customer.Guid]));
  log.info?.(
    `scanned ${all.length} production customers; ${lookups.salesPeopleByEmail.size} salespeople, ${lookups.warehousesByCode.size} warehouse(s)`,
  );

  const results = [];
  for (const code of codes) {
    const key = code.toLowerCase();
    const guid = guidByCode.get(key);
    if (!guid) {
      results.push({ customerCode: code, outcome: RESTORE_OUTCOME.FAILED, error: 'not found in production', changes: {}, kept: [], problems: [] });
      continue;
    }
    const customer = await unleashed.getCustomerByGuid(guid);
    const result = await restoreCustomerFields({
      customer,
      row: exportByCode.get(key),
      lookups,
      unleashed,
      config,
      log,
      apply,
    });
    results.push(result);
    if (limit && results.filter((r) => r.outcome !== RESTORE_OUTCOME.UNCHANGED).length >= limit) {
      return { scanned: results.length, byOutcome: summarise(results), results, truncated: true };
    }
  }
  return { scanned: results.length, byOutcome: summarise(results), results, truncated: false };
}
