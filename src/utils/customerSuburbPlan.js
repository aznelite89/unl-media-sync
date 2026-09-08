import {
  ADDRESS_UPDATE_FIELDS,
  CURRENCY_UPDATE_FIELDS,
  CUSTOMER_READ_ONLY_FIELDS,
  CUSTOMER_UPDATE_FIELDS,
  SALESPERSON_UPDATE_FIELDS,
  WAREHOUSE_UPDATE_FIELDS,
} from '../constants/index.js';

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source && Object.hasOwn(source, field)) out[field] = source[field];
  }
  return out;
}

/**
 * Pure planning for the suburb fill — no I/O in this module.
 */

/**
 * Copies City into every address whose Suburb is empty. Returns the new
 * address list and what changed, touches nothing else. City is kept: the
 * request was "suburb as well", and an invoice template that prints both is a
 * separate decision from getting the data in the right field.
 *
 * @param {object} customer A customer as returned by GET /Customers.
 * @returns {{ changes: Array<{ addressType: string, city: string }>, addresses: object[] }}
 */
export function planSuburbFill(customer) {
  const changes = [];
  const addresses = (customer?.Addresses ?? []).map((address) => {
    const suburb = String(address?.Suburb ?? '').trim();
    const city = String(address?.City ?? '').trim();
    if (suburb || !city) return address;
    changes.push({ addressType: address.AddressType, city });
    return { ...address, Suburb: city };
  });
  return { changes, addresses };
}

/**
 * Every field the API accepts on update, exactly as read, with the planned
 * addresses in. Sending everything sendable means nothing Unleashed might treat
 * "missing" as "blank" (Notes, price tier, payment term) is at risk; sending
 * anything beyond that list (Contacts, address Guids, the extra Currency
 * fields GET adds) is answered with a bare HTTP 500, which is how the first
 * live attempt on 8 Sep 2026 failed.
 */
export function toUpdateBody(customer, addresses) {
  const body = pick(customer, CUSTOMER_UPDATE_FIELDS);
  if (customer?.Currency) body.Currency = pick(customer.Currency, CURRENCY_UPDATE_FIELDS);
  // Nested objects come back from GET with LastModifiedOn / Obsolete / WarehouseName
  // on them; only the documented keys go back. SellPriceTierReference is derived
  // from SellPriceTier and has no documented update shape, so it is not sent.
  if (customer?.SalesPerson) body.SalesPerson = pick(customer.SalesPerson, SALESPERSON_UPDATE_FIELDS);
  if (customer?.DefaultWarehouse) {
    body.DefaultWarehouse = pick(customer.DefaultWarehouse, WAREHOUSE_UPDATE_FIELDS);
  }
  body.Addresses = addresses.map((address) => pick(address, ADDRESS_UPDATE_FIELDS));
  return body;
}

/**
 * Top-level fields (other than the address list and timestamps) whose value
 * differs between two reads of the same customer. Used after a write to prove
 * the update changed only what it was meant to.
 */
export function driftedFields(before, after) {
  const ignore = new Set([...CUSTOMER_READ_ONLY_FIELDS, 'Addresses']);
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const drifted = [];
  for (const key of keys) {
    if (ignore.has(key)) continue;
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) {
      drifted.push(key);
    }
  }
  return drifted;
}

/** Addresses that still carry a City but no Suburb. */
export function addressesStillEmpty(customer) {
  return (customer?.Addresses ?? []).filter(
    (address) => !String(address?.Suburb ?? '').trim() && String(address?.City ?? '').trim(),
  );
}

/** Rows for a CSV of what was, or would be, changed. */
export function buildSuburbCsv(report) {
  const lines = ['customer_code,address_type,suburb_from_city,outcome,error'];
  for (const result of report.results) {
    for (const change of result.changes) {
      const cells = [result.customerCode, change.addressType, change.city, result.outcome, result.error ?? ''];
      lines.push(cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','));
    }
  }
  return lines.join('\n');
}
