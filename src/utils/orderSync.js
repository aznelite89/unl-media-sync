/**
 * Shopify → Unleashed order sync: the replacement for the eCommerce Hub's
 * order import and customer synchronisation.
 *
 * What it does that the hub did not: it never writes to a customer record.
 * The hub copied the Shopify customer (blank notes, full-state postal address)
 * over the Unleashed one on every website order; this chooses the customer
 * and stops there. What it keeps from the hub: `web#NNNN` numbering, one line
 * per piece for chain, the AIOD discount as a line discount, a FREIGHT line.
 *
 * Every create is preceded by a lookup of `web#NNNN` in Unleashed, so a
 * webhook retry, a timer overlap or a lost state file cannot produce a second
 * order. An order whose customer cannot be identified is NOT created on a
 * placeholder — Unleashed does not allow the customer to be changed after
 * the fact — it is held, the office is emailed once, and it is retried every
 * run until the office maps the Shopify customer (metafield) or names the
 * code on the CLI.
 */

import {
  CUSTOMER_MATCH,
  ORDER_SYNC_DONE_OUTCOMES,
  ORDER_SYNC_OUTCOME,
  ORDER_SYNC_PROBLEM_OUTCOMES,
  SHADOW_RETRY_VERDICTS,
  SHADOW_VERDICT,
  SHOPIFY_ORDER_CREATOR,
} from '../constants/index.js';
import { sendEmail, escapeHtml } from './email.js';
import { summarise } from './logger.js';
import { buildSalesOrder, chooseCustomer, describeLines, normaliseOrder } from './orderSyncPlan.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Looks the customer up in Unleashed and chooses one. `explicitCode` (from the
 * CLI) wins over everything; otherwise the Shopify customer's mapped code,
 * then the email.
 */
async function resolveCustomer({ order, unleashed, explicitCode }) {
  if (explicitCode) {
    const customer = await unleashed.getCustomerByCode(explicitCode);
    if (!customer) throw new Error(`no Unleashed customer with code ${explicitCode}`);
    if (customer.Obsolete) throw new Error(`Unleashed customer ${explicitCode} is obsolete`);
    return { customer, via: CUSTOMER_MATCH.EXPLICIT, reason: null, warnings: [] };
  }

  const mapped = order.customer?.mappedCode
    ? await unleashed.getCustomerByCode(order.customer.mappedCode)
    : null;
  if (mapped && !mapped.Obsolete) return chooseCustomer({ order, mapped, byEmail: [] });

  const email = order.customer?.email || order.email;
  const byEmail = email ? await unleashed.findCustomersByEmail(email) : [];
  return chooseCustomer({ order, mapped, byEmail });
}

/** The Unleashed product for every distinct SKU on the order, plus freight. */
async function loadProducts({ order, unleashed, settings }) {
  const products = {};
  const missing = [];
  for (const sku of new Set(order.lineItems.map((item) => item.sku))) {
    const product = sku ? await unleashed.getProductByCode(sku) : null;
    if (product && String(product.ProductCode).trim().toLowerCase() === sku.toLowerCase()) {
      products[sku] = product;
    } else {
      missing.push(sku || '(blank SKU)');
    }
  }
  const needsFreight = order.shippingLines.some((line) => line.price > 0);
  const freightProduct = needsFreight ? await unleashed.getProductByCode(settings.freightCode) : null;
  if (needsFreight && !freightProduct) missing.push(settings.freightCode);
  return { products, freightProduct, missing };
}

/**
 * Imports one Shopify order.
 *
 * @param {{
 *   orderNode: object, unleashed: object, config: object, log: object,
 *   apply: boolean, explicitCode?: string, ignoreExisting?: boolean,
 * }} input
 * `ignoreExisting` is for the CLI's side-by-side view only: the plan is built
 * even though the order is already in Unleashed, and never written.
 * @returns {Promise<object>} A result with `outcome`, `name`, `orderNumber`, and what was decided.
 */
export async function importOrder({ orderNode, unleashed, config, log, apply, explicitCode, ignoreExisting = false }) {
  if (ignoreExisting && apply) throw new Error('ignoreExisting is read-only');
  const settings = config.orderSync;
  const order = normaliseOrder(orderNode);
  const orderNumber = `${settings.prefix}${order.name}`;
  const base = { id: order.id, name: order.name, orderNumber, createdAt: order.createdAt, warnings: [] };

  if (order.cancelledAt || order.test) {
    return { ...base, outcome: ORDER_SYNC_OUTCOME.SKIPPED, reason: order.test ? 'test order' : `cancelled ${order.cancelledAt}` };
  }
  if (order.currencyCode && order.currencyCode !== settings.currencyCode) {
    return { ...base, outcome: ORDER_SYNC_OUTCOME.FAILED, reason: `order is in ${order.currencyCode}, not ${settings.currencyCode}` };
  }

  const existing = ignoreExisting ? null : await unleashed.findSalesOrderByNumber(orderNumber);
  if (existing) {
    return {
      ...base,
      outcome: ORDER_SYNC_OUTCOME.EXISTS,
      unleashedGuid: existing.Guid,
      customerCode: existing.Customer?.CustomerCode ?? null,
      createdBy: existing.CreatedBy ?? null,
    };
  }

  let chosen;
  try {
    chosen = await resolveCustomer({ order, unleashed, explicitCode });
  } catch (error) {
    return { ...base, outcome: ORDER_SYNC_OUTCOME.FAILED, reason: error.message };
  }
  base.warnings.push(...chosen.warnings);
  if (!chosen.customer) {
    const ambiguous = /share/.test(chosen.reason ?? '');
    return {
      ...base,
      outcome: ambiguous ? ORDER_SYNC_OUTCOME.AMBIGUOUS : ORDER_SYNC_OUTCOME.UNMATCHED,
      reason: chosen.reason,
      email: order.customer?.email || order.email || null,
      shopifyCustomerId: order.customer?.id ?? null,
      company: order.shippingAddress?.company || order.customer?.company || null,
    };
  }

  const { products, freightProduct, missing } = await loadProducts({ order, unleashed, settings });
  if (missing.length) {
    return {
      ...base,
      outcome: ORDER_SYNC_OUTCOME.UNKNOWN_SKU,
      reason: `not in Unleashed: ${missing.join(', ')}`,
      customerCode: chosen.customer.CustomerCode,
    };
  }

  let plan;
  try {
    plan = buildSalesOrder({ order, customer: chosen.customer, products, settings, freightProduct });
  } catch (error) {
    return { ...base, outcome: ORDER_SYNC_OUTCOME.FAILED, reason: error.message, customerCode: chosen.customer.CustomerCode };
  }
  base.warnings.push(...plan.warnings);

  const decided = {
    ...base,
    customerCode: chosen.customer.CustomerCode,
    customerName: chosen.customer.CustomerName,
    via: chosen.via,
    totals: plan.totals,
    lineCount: plan.body.SalesOrderLines.length,
    body: plan.body,
  };

  if (!apply) return { ...decided, outcome: ORDER_SYNC_OUTCOME.PLANNED };

  try {
    const created = await unleashed.createSalesOrder(plan.body);
    return { ...decided, outcome: ORDER_SYNC_OUTCOME.CREATED, unleashedGuid: created?.Guid ?? null };
  } catch (error) {
    log.error?.(`order sync: Unleashed rejected ${orderNumber} — ${error.message}`);
    return { ...decided, outcome: ORDER_SYNC_OUTCOME.FAILED, reason: error.message };
  }
}

/** The state entry kept for a result: everything but the request body. */
export function toStateEntry(result, nowIso) {
  const { body, ...rest } = result;
  return { ...rest, at: nowIso };
}

export function lookbackIso(hours, nowMs = Date.now()) {
  return new Date(nowMs - hours * ONE_HOUR_MS).toISOString();
}

/**
 * One pass: every Shopify order created in the window that is not already
 * settled is imported, and the state is saved.
 *
 * @param {{
 *   shopify: object, unleashed: object, store: object, config: object, log: object,
 *   apply: boolean, sinceIso?: string, notify?: boolean,
 * }} input
 */
export async function syncOrders({ shopify, unleashed, store, config, log, apply, sinceIso, notify = true }) {
  const since = sinceIso ?? lookbackIso(config.orderSync.lookbackHours);
  const { state, etag } = await store.load();
  const nodes = await shopify.listOrdersCreatedSince(since);
  const nowIso = new Date().toISOString();
  const results = [];
  const fresh = [];

  for (const node of nodes) {
    const previous = state.orders[node.id];
    if (previous && ORDER_SYNC_DONE_OUTCOMES.includes(previous.outcome)) continue;

    const result = await importOrder({ orderNode: node, unleashed, config, log, apply });
    results.push(result);
    const entry = toStateEntry(result, nowIso);
    // Tell the office about a problem once; a repeat of the same outcome is not news.
    const alreadyTold = previous?.emailedAt && previous.outcome === result.outcome;
    if (alreadyTold) entry.emailedAt = previous.emailedAt;
    if (apply || previous) state.orders[node.id] = entry;
    if (ORDER_SYNC_PROBLEM_OUTCOMES.includes(result.outcome) && !alreadyTold) fresh.push(result);
  }

  state.lastRunAt = nowIso;
  let saved = false;
  if (apply) {
    try {
      await store.save(state, etag);
      saved = true;
    } catch (error) {
      // The next run re-reads Unleashed, so nothing is lost but this log line.
      log.warn?.(`order sync: state not saved — ${error.message}`);
    }
  }

  let emailed = { delivered: false, reason: 'nothing new to report' };
  if (notify && apply && fresh.length) {
    emailed = await sendProblemEmail({ results: fresh, config, log });
    if (emailed.delivered && saved) {
      for (const result of fresh) if (state.orders[result.id]) state.orders[result.id].emailedAt = nowIso;
      try {
        await store.save(state, await store.load().then((latest) => latest.etag));
      } catch (error) {
        log.warn?.(`order sync: emailedAt not saved — ${error.message}`);
      }
    }
  }

  return { since, scanned: nodes.length, results, byOutcome: summarise(results), emailed };
}

function problemLines(result) {
  const lines = [
    `Website order ${result.name} (${result.orderNumber}) — ${result.outcome}`,
    `  ${result.reason ?? ''}`,
  ];
  if (result.email) lines.push(`  Shopify email: ${result.email}`);
  if (result.company) lines.push(`  Shopify company: ${result.company}`);
  if (result.customerCode) lines.push(`  Unleashed customer: ${result.customerCode}`);
  for (const warning of result.warnings ?? []) lines.push(`  ! ${warning}`);
  return lines;
}

/**
 * Tells the office which website orders are waiting and what unblocks each.
 * Delivery never throws.
 */
export async function sendProblemEmail({ results, config, log }) {
  const unmatched = results.filter((r) => r.outcome === ORDER_SYNC_OUTCOME.UNMATCHED || r.outcome === ORDER_SYNC_OUTCOME.AMBIGUOUS);
  const subject =
    results.length === 1
      ? `Website order ${results[0].name} is waiting: ${results[0].outcome}`
      : `${results.length} website orders are waiting to go into Unleashed`;

  const text = [
    'These website orders have NOT been created in Unleashed yet.',
    '',
    ...results.flatMap((result) => [...problemLines(result), '']),
    unmatched.length
      ? 'To release an order whose customer is not identified: open the customer in Shopify admin and put their ' +
        'Unleashed customer code in the "Unleashed customer code" field (or add the Shopify email to the ' +
        'Unleashed customer). The order is created automatically within 5 minutes.'
      : '',
    'A SKU that is not in Unleashed needs the product created or the Shopify SKU corrected first.',
  ].join('\n');

  const html =
    `<p>These website orders have <strong>not</strong> been created in Unleashed yet.</p><pre>` +
    escapeHtml(results.flatMap((result) => [...problemLines(result), '']).join('\n')) +
    `</pre>` +
    (unmatched.length
      ? '<p>To release an order whose customer is not identified: open the customer in Shopify admin and put their ' +
        'Unleashed customer code in the <strong>Unleashed customer code</strong> field (or add the Shopify email to the ' +
        'Unleashed customer). The order is created automatically within 5 minutes.</p>'
      : '') +
    '<p>A SKU that is not in Unleashed needs the product created or the Shopify SKU corrected first.</p>';

  return sendEmail({ config, subject, text, html, log });
}

/** One comparable string per Unleashed line. */
export function lineKey(line) {
  const code = line?.Product?.ProductCode ?? '';
  return `${code} x${Number(line.OrderQuantity)} @${Number(line.UnitPrice).toFixed(2)} -${Number(line.DiscountRate ?? 0)}`;
}

/**
 * Our plan against the hub's order for the same website order. Lines are
 * compared as multisets: the hub orders them as Shopify does, and so do we,
 * but order is not what matters.
 *
 * @param {{ result: object, hubOrder: object | null }} input
 */
/**
 * Whether the hub order has been touched by anyone other than the connector.
 * The connector signs as `Shopify` on creation and sometimes `shopify` on its
 * own immediate follow-up write, so the comparison ignores case.
 *
 * @param {string | null | undefined} lastModifiedBy
 */
export function hubOrderUntouched(lastModifiedBy) {
  return String(lastModifiedBy ?? '').toLowerCase() === SHOPIFY_ORDER_CREATOR.toLowerCase();
}

export function compareWithHub({ result, hubOrder }) {
  if (!hubOrder) return null;
  const hub = {
    customerCode: hubOrder.Customer?.CustomerCode ?? null,
    status: hubOrder.OrderStatus,
    createdBy: hubOrder.CreatedBy,
    lastModifiedBy: hubOrder.LastModifiedBy,
    lines: (hubOrder.SalesOrderLines ?? []).map(lineKey),
    total: hubOrder.Total,
  };
  if (!result.body) {
    return { verdict: SHADOW_VERDICT.NOT_PLANNED, hub, reason: result.reason ?? result.outcome, customerAgrees: null, diffs: [] };
  }
  const ours = result.body.SalesOrderLines.map(lineKey);
  const customerAgrees = result.customerCode === hub.customerCode;
  const edited = !hubOrderUntouched(hub.lastModifiedBy);

  const remaining = [...hub.lines];
  const onlyOurs = [];
  for (const key of ours) {
    const at = remaining.indexOf(key);
    if (at === -1) onlyOurs.push(key);
    else remaining.splice(at, 1);
  }
  const diffs = [
    ...onlyOurs.map((key) => `ours only: ${key}`),
    ...remaining.map((key) => `hub only: ${key}`),
  ];
  if (!customerAgrees) diffs.unshift(`customer: ours ${result.customerCode}, hub ${hub.customerCode}`);

  let verdict = SHADOW_VERDICT.SAME;
  if (diffs.length) verdict = edited ? SHADOW_VERDICT.EDITED : SHADOW_VERDICT.DIFFERENT;
  if (!customerAgrees) verdict = SHADOW_VERDICT.DIFFERENT;
  return { verdict, hub, ours, customerAgrees, edited, diffs };
}

/**
 * Shadow pass: for every website order in the window that has not been
 * compared yet and that the hub has already created, plan ours, compare, and
 * record the verdict. Nothing is written to Unleashed. An order the hub has
 * not created yet is left for the next run.
 */
/** A recorded shadow entry that a later pass should plan again. */
export function shadowRetryable(entry) {
  return entry?.outcome === ORDER_SYNC_OUTCOME.SHADOW && SHADOW_RETRY_VERDICTS.includes(entry.comparison?.verdict);
}

export async function shadowOrders({ shopify, unleashed, store, config, log, sinceIso }) {
  const since = sinceIso ?? lookbackIso(config.orderSync.lookbackHours);
  const { state, etag } = await store.load();
  const nodes = await shopify.listOrdersCreatedSince(since);
  const nowIso = new Date().toISOString();
  const results = [];

  for (const node of nodes) {
    const previous = state.orders[node.id];
    if (previous && ORDER_SYNC_DONE_OUTCOMES.includes(previous.outcome) && !shadowRetryable(previous)) continue;

    const orderNumber = `${config.orderSync.prefix}${node.name}`;
    const hubOrder = await unleashed.findSalesOrderByNumber(orderNumber);
    if (!hubOrder) {
      results.push({ id: node.id, name: node.name, orderNumber, outcome: ORDER_SYNC_OUTCOME.PLANNED, reason: 'hub has not created it yet; next run' });
      continue;
    }
    const planned = await importOrder({ orderNode: node, unleashed, config, log, apply: false, ignoreExisting: true });
    const comparison = compareWithHub({ result: planned, hubOrder });
    const result = { ...planned, outcome: ORDER_SYNC_OUTCOME.SHADOW, plannedOutcome: planned.outcome, comparison };
    results.push(result);
    state.orders[node.id] = toStateEntry(result, nowIso);
  }

  state.lastRunAt = nowIso;
  try {
    await store.save(state, etag);
  } catch (error) {
    log.warn?.(`shadow: state not saved — ${error.message}`);
  }
  const byVerdict = {};
  for (const r of results) if (r.comparison) byVerdict[r.comparison.verdict] = (byVerdict[r.comparison.verdict] ?? 0) + 1;
  return { since, scanned: nodes.length, results, byVerdict };
}

/** The shadow verdicts recorded so far, for the CLI. */
export function summariseShadow(state) {
  const entries = Object.values(state.orders ?? {}).filter((e) => e.outcome === ORDER_SYNC_OUTCOME.SHADOW);
  const byVerdict = {};
  for (const e of entries) byVerdict[e.comparison?.verdict ?? 'unknown'] = (byVerdict[e.comparison?.verdict ?? 'unknown'] ?? 0) + 1;
  return { count: entries.length, byVerdict, entries: entries.sort((a, b) => (a.name > b.name ? 1 : -1)) };
}

/** Multi-line description of one result for logs and the CLI. */
export function describeResult(result) {
  const head =
    `${result.name} → ${result.outcome}` +
    (result.customerCode ? ` customer ${result.customerCode}${result.customerName ? ` (${result.customerName})` : ''}${result.via ? ` via ${result.via}` : ''}` : '') +
    (result.totals ? ` total ${result.totals.total.toFixed(2)} over ${result.lineCount} lines` : '') +
    (result.unleashedGuid ? ` guid ${result.unleashedGuid}` : '') +
    (result.reason ? ` — ${result.reason}` : '');
  const lines = [head];
  for (const warning of result.warnings ?? []) lines.push(`  ! ${warning}`);
  if (result.comparison) {
    const c = result.comparison;
    lines.push(`  shadow: ${c.verdict}${c.customerAgrees === false ? ' (customer differs)' : ''}${c.edited ? ` (hub order edited by ${c.hub.lastModifiedBy})` : ''}`);
    for (const diff of c.diffs) lines.push(`    ${diff}`);
  } else if (result.body) {
    lines.push(...describeLines(result.body).map((line) => `  ${line}`));
  }
  return lines.join('\n');
}
