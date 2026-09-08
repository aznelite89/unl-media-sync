import { SUBURB_OUTCOME } from '../constants/index.js';
import {
  addressesStillEmpty,
  buildSuburbCsv,
  driftedFields,
  planSuburbFill,
  toUpdateBody,
} from './customerSuburbPlan.js';
import { summarise } from './logger.js';

export { buildSuburbCsv };

/**
 * Fills the empty suburbs on one customer.
 *
 * `apply` is the write switch; `config.dryRun` wins over it. After a write the
 * record is re-read: the outcome is `filled` only if every planned Suburb is
 * now present, and any other top-level field that changed is reported so a
 * silent blanking would be seen on the first record, not the hundredth.
 *
 * @param {{ customer: object, unleashed: object, config: object, log: object, apply: boolean }} input
 */
export async function fillCustomerSuburb({ customer, unleashed, config, log, apply }) {
  const { changes, addresses } = planSuburbFill(customer);
  const base = { customerCode: customer.CustomerCode, guid: customer.Guid, changes };

  if (changes.length === 0) return { ...base, outcome: SUBURB_OUTCOME.UNCHANGED };
  if (!apply || config.dryRun) return { ...base, outcome: SUBURB_OUTCOME.DRY_RUN };

  try {
    await unleashed.updateCustomer(customer.Guid, toUpdateBody(customer, addresses));
    const after = await unleashed.getCustomerByGuid(customer.Guid);
    const drifted = driftedFields(customer, after);
    if (drifted.length) {
      log.warn?.(
        `suburb fill: ${customer.CustomerCode} — fields other than Addresses changed on write: ${drifted.join(', ')}`,
      );
    }
    const stillEmpty = addressesStillEmpty(after);
    if (stillEmpty.length) {
      return {
        ...base,
        outcome: SUBURB_OUTCOME.FAILED,
        drifted,
        error: `${stillEmpty.length} address(es) still have an empty Suburb after the update`,
      };
    }
    return { ...base, outcome: SUBURB_OUTCOME.FILLED, drifted };
  } catch (error) {
    log.error?.(`suburb fill: ${customer.CustomerCode} — ${error.message}`);
    return { ...base, outcome: SUBURB_OUTCOME.FAILED, error: error.message };
  }
}

/**
 * Walks customers (all, or those modified since `sinceIso`, or one code) and
 * fills their suburbs.
 *
 * @param {{ sinceIso?: string, customerCode?: string, limit?: number, apply: boolean, unleashed: object, config: object, log: object }} input
 */
export async function fillSuburbs({ sinceIso, customerCode, limit, apply, unleashed, config, log }) {
  const results = [];
  let scanned = 0;

  for await (const page of unleashed.iterateCustomers({ sinceIso, customerCode })) {
    for (const customer of page.items) {
      // Unleashed's customerCode filter is a prefix match; keep exact only.
      if (customerCode && String(customer.CustomerCode).toLowerCase() !== customerCode.toLowerCase()) {
        continue;
      }
      scanned += 1;
      const result = await fillCustomerSuburb({ customer, unleashed, config, log, apply });
      if (result.outcome !== SUBURB_OUTCOME.UNCHANGED) results.push(result);
      if (limit && results.length >= limit) {
        return { scanned, byOutcome: summarise(results), results, truncated: true };
      }
    }
  }

  return { scanned, byOutcome: summarise(results), results, truncated: false };
}
