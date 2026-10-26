#!/usr/bin/env node
/**
 * The Shopify → Unleashed order sync by hand. Read-only unless --apply is given.
 *
 *   node scripts/order-sync-cli.js --order 3234                      # what would be created for website order #3234
 *   node scripts/order-sync-cli.js --order 3234 --apply              # create it
 *   node scripts/order-sync-cli.js --order 3234 --customer KJ599 [--apply]   # name the Unleashed customer yourself
 *   node scripts/order-sync-cli.js --compare 3234                    # planned lines vs the web#3234 the hub created
 *   node scripts/order-sync-cli.js --since 48h [--apply]             # one timer pass over the last 48 hours
 *   node scripts/order-sync-cli.js --from-file order.json [--customer X] [--compare 3234]   # a saved GraphQL order node
 *   node scripts/order-sync-cli.js --map 5141779349657 PP852 [--apply]       # record a Shopify customer → Unleashed code
 *   node scripts/order-sync-cli.js --seed-mapping [--apply] [--csv reports/mapping.csv]
 *                                                                    # map every Shopify customer from past web orders
 *   node scripts/order-sync-cli.js --ensure-definition [--apply]     # show the code field on Shopify customer pages
 *   node scripts/order-sync-cli.js --state                           # what the timer has recorded
 *
 * The state lives in the Function App's storage account. Point at it with
 *   export ORDER_SYNC_STORAGE_CONNECTION="$(az storage account show-connection-string \
 *     -g searay-func-rg -n searayunleashedsync -o tsv)"
 * Without it, --since runs against an in-memory state (fine for a dry run).
 *
 * Credentials come from the environment, or local.settings.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const settingsPath = path.join(projectRoot, 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const [key, value] of Object.entries(settings?.Values ?? {})) {
      if (process.env[key] === undefined) process.env[key] = String(value);
    }
  } catch (error) {
    console.error(`Could not read local.settings.json: ${error.message}`);
    process.exit(1);
  }
}

const { loadConfig } = await import('../src/utils/config.js');
const { createUnleashedClient } = await import('../src/utils/unleashed.js');
const { createShopifyClient } = await import('../src/utils/shopify.js');
const { createBlobOrderStore, createMemoryOrderStore } = await import('../src/utils/orderSyncStore.js');
const { describeResult, importOrder, lookbackIso, syncOrders } = await import('../src/utils/orderSync.js');
const { ORDER_SYNC_OUTCOME, SHOPIFY_ORDER_CREATOR } = await import('../src/constants/index.js');

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--order') args.order = argv[++i];
    else if (arg === '--customer') args.customer = argv[++i];
    else if (arg === '--compare') args.compare = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--from-file') args.fromFile = argv[++i];
    else if (arg === '--map') { args.map = [argv[++i], argv[++i]]; }
    else if (arg === '--seed-mapping') args.seedMapping = true;
    else if (arg === '--ensure-definition') args.ensureDefinition = true;
    else if (arg === '--state') args.state = true;
    else if (arg === '--csv') args.csv = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      args.help = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.order && !args.since && !args.fromFile && !args.map && !args.seedMapping && !args.ensureDefinition && !args.state && !args.compare)) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n'));
  process.exit(args.help ? 0 : 1);
}

const config = loadConfig();
if (config.dryRun && args.apply) {
  console.error('DRY_RUN is set; --apply ignored.');
  args.apply = false;
}
const log = { info: () => {}, warn: (m) => console.error(m), error: (m) => console.error(m) };
const unleashed = createUnleashedClient(config, log);
const shopify = createShopifyClient(config, log);

/** `3234` or `#3234` → `#3234`. */
function orderName(value) {
  const digits = String(value).replace(/^#/, '');
  return `#${digits}`;
}

function parseSince(value) {
  const match = /^(\d+)([hd])$/.exec(String(value ?? '').trim());
  if (!match) return value; // an ISO timestamp
  const hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
  return lookbackIso(hours);
}

async function fetchOrderNode(name) {
  const data = await shopify.graphql(
    `query ($query: String!) { orders(first: 2, query: $query) { nodes { id name } } }`,
    { query: `name:${name}` },
    { label: 'findOrder' },
  );
  const hit = (data?.orders?.nodes ?? []).find((node) => node.name === name);
  if (!hit) throw new Error(`no Shopify order named ${name}`);
  return shopify.getOrder(hit.id);
}

function printResult(result) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(describeResult(result));
  if (result.body && !args.json) {
    const { SalesOrderLines, ...head } = result.body;
    console.log('  order fields:', JSON.stringify(head));
  }
}

/** The hub's order for the same website order, line by line, next to ours. */
async function compareWithHub(result, name) {
  const orderNumber = `${config.orderSync.prefix}${name}`;
  const hubOrder = await unleashed.findSalesOrderByNumber(orderNumber);
  if (!hubOrder) {
    console.log(`\n(no ${orderNumber} in Unleashed to compare with)`);
    return;
  }
  console.log(
    `\nUnleashed ${orderNumber}: created by ${hubOrder.CreatedBy}, status ${hubOrder.OrderStatus}, ` +
      `customer ${hubOrder.Customer?.CustomerCode} (${hubOrder.Customer?.CustomerName}), ` +
      `sub ${hubOrder.SubTotal} tax ${hubOrder.TaxTotal} total ${hubOrder.Total}, group ${hubOrder.SalesOrderGroup}, ` +
      `delivery ${[hubOrder.DeliveryName, hubOrder.DeliveryStreetAddress, hubOrder.DeliverySuburb, hubOrder.DeliveryCity, hubOrder.DeliveryRegion, hubOrder.DeliveryPostCode].join(' | ')}`,
  );
  if (hubOrder.CreatedBy !== SHOPIFY_ORDER_CREATOR) console.log('  (not created by the hub)');
  const theirs = hubOrder.SalesOrderLines.map((l) => `${l.Product?.ProductCode} x${l.OrderQuantity} @${l.UnitPrice} -${l.DiscountRate} =${l.LineTotal}`);
  const ours = (result.body?.SalesOrderLines ?? []).map((l) => `${l.Product.ProductCode} x${l.OrderQuantity} @${l.UnitPrice} -${l.DiscountRate} =${l.LineTotal}`);
  const width = Math.max(...ours.map((s) => s.length), 10);
  console.log(`\n  ${'ours (planned)'.padEnd(width)}  |  hub (${hubOrder.LastModifiedBy === SHOPIFY_ORDER_CREATOR ? 'untouched' : `edited by ${hubOrder.LastModifiedBy}`})`);
  for (let i = 0; i < Math.max(ours.length, theirs.length); i += 1) {
    const same = ours[i] === theirs[i];
    console.log(`  ${(ours[i] ?? '').padEnd(width)}  ${same ? '==' : '!='}  ${theirs[i] ?? ''}`);
  }
  if (result.customerCode && result.customerCode !== hubOrder.Customer?.CustomerCode) {
    console.log(`\n  !! customer differs: ours ${result.customerCode}, hub ${hubOrder.Customer?.CustomerCode}`);
  } else if (result.customerCode) {
    console.log(`\n  customer agrees: ${result.customerCode}`);
  }
}

async function runOne(orderNode, name) {
  // --compare shows the plan even when the hub already created the order.
  const ignoreExisting = Boolean(args.compare) && !args.apply;
  const result = await importOrder({ orderNode, unleashed, config, log, apply: args.apply, explicitCode: args.customer, ignoreExisting });
  printResult(result);
  if (args.compare || args.order) await compareWithHub(result, name ?? orderNode.name);
  return result;
}

async function seedMapping() {
  // Every web order the hub created ties a Shopify order number to an
  // Unleashed customer; the Shopify order ties the number to a customer id.
  console.error('reading Unleashed web orders…');
  const unleashedOrders = await unleashed.listAll?.('SalesOrders', { startDate: '2024-01-01' }) ?? [];
  const byName = new Map();
  for (const order of unleashedOrders) {
    if (order.CreatedBy !== SHOPIFY_ORDER_CREATOR) continue;
    const match = /#(\d+)$/.exec(order.OrderNumber ?? '');
    if (!match) continue;
    byName.set(`#${match[1]}`, { code: order.Customer?.CustomerCode, name: order.Customer?.CustomerName, at: order.CreatedOn });
  }
  console.error(`${byName.size} web orders in Unleashed; reading Shopify orders…`);
  const shopifyOrders = await shopify.listOrdersCreatedSince('2024-01-01T00:00:00Z', { maxPages: 100 });
  const proposals = new Map();
  for (const node of shopifyOrders) {
    const hub = byName.get(node.name);
    if (!hub?.code || !node.customer?.id) continue;
    const current = proposals.get(node.customer.id) ?? { email: node.customer.email, codes: new Map(), existing: node.customer.metafield?.value ?? null, latest: null };
    current.codes.set(hub.code, (current.codes.get(hub.code) ?? 0) + 1);
    if (!current.latest || node.createdAt > current.latest.createdAt) current.latest = { createdAt: node.createdAt, code: hub.code, name: node.name };
    proposals.set(node.customer.id, current);
  }
  const rows = [];
  for (const [customerId, p] of proposals) {
    const codes = [...p.codes.entries()].sort((a, b) => b[1] - a[1]);
    const chosen = p.latest.code; // the most recent order's customer is the office's current choice
    const conflict = codes.length > 1 ? codes.map(([c, n]) => `${c}×${n}`).join(' ') : '';
    const action = p.existing ? (p.existing === chosen ? 'already' : 'differs') : 'set';
    rows.push({ customerId, email: p.email, chosen, existing: p.existing, action, conflict, lastOrder: p.latest.name });
  }
  rows.sort((a, b) => (a.action > b.action ? 1 : a.action < b.action ? -1 : 0));
  for (const row of rows) {
    console.log(`${row.action.padEnd(8)} ${row.customerId.padEnd(40)} ${(row.email ?? '').padEnd(40)} → ${row.chosen}${row.existing ? ` (shopify has ${row.existing})` : ''}${row.conflict ? `  past orders: ${row.conflict}` : ''}  last ${row.lastOrder}`);
  }
  if (args.csv) {
    fs.writeFileSync(args.csv, ['customerId,email,chosen,existing,action,conflict,lastOrder', ...rows.map((r) => [r.customerId, r.email, r.chosen, r.existing, r.action, r.conflict, r.lastOrder].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n'));
    console.error(`wrote ${args.csv}`);
  }
  const toSet = rows.filter((r) => r.action === 'set');
  console.error(`\n${rows.length} Shopify customers seen on web orders; ${toSet.length} to set, ${rows.filter((r) => r.action === 'already').length} already set, ${rows.filter((r) => r.action === 'differs').length} differ (left alone).`);
  if (!args.apply) {
    console.error('Dry run; pass --apply to write the metafields.');
    return;
  }
  let done = 0;
  for (const row of toSet) {
    await shopify.setCustomerUnleashedCode(row.customerId, row.chosen);
    done += 1;
  }
  console.error(`set ${done} metafields`);
}

try {
  if (args.ensureDefinition) {
    if (!args.apply) console.log('Would create the "Unleashed customer code" field on Shopify customers (pass --apply).');
    else console.log(JSON.stringify(await shopify.ensureCustomerCodeDefinition()));
  } else if (args.map) {
    const [customerId, code] = args.map;
    const gid = customerId.startsWith('gid://') ? customerId : `gid://shopify/Customer/${customerId}`;
    const customer = await unleashed.getCustomerByCode(code);
    if (!customer) throw new Error(`no Unleashed customer with code ${code}`);
    console.log(`${gid} → ${customer.CustomerCode} (${customer.CustomerName})${customer.Obsolete ? ' OBSOLETE' : ''}`);
    if (args.apply) console.log(JSON.stringify(await shopify.setCustomerUnleashedCode(gid, customer.CustomerCode)));
    else console.log('Dry run; pass --apply to write it.');
  } else if (args.seedMapping) {
    await seedMapping();
  } else if (args.state) {
    const store = createBlobOrderStore(config.orderSyncStorageConnection);
    const { state } = await store.load();
    console.log(JSON.stringify(state, null, 2));
  } else if (args.fromFile) {
    const node = JSON.parse(fs.readFileSync(args.fromFile, 'utf8'));
    const orderNode = node?.data?.order ?? node?.order ?? node;
    await runOne(orderNode, args.compare ? orderName(args.compare) : orderNode.name);
  } else if (args.order) {
    const name = orderName(args.order);
    await runOne(await fetchOrderNode(name), name);
  } else if (args.compare) {
    const name = orderName(args.compare);
    await runOne(await fetchOrderNode(name), name);
  } else if (args.since) {
    const store = config.orderSyncStorageConnection && !config.orderSyncStorageConnection.includes('UseDevelopmentStorage')
      ? createBlobOrderStore(config.orderSyncStorageConnection)
      : createMemoryOrderStore();
    const report = await syncOrders({ shopify, unleashed, store, config, log, apply: args.apply, sinceIso: parseSince(args.since), notify: args.apply });
    for (const result of report.results) {
      console.log(describeResult(result));
      console.log('');
    }
    console.log(`${report.scanned} orders since ${report.since}; outcomes ${JSON.stringify(report.byOutcome)}${args.apply ? '' : ' (dry run)'}`);
    const held = report.results.filter((r) => ![ORDER_SYNC_OUTCOME.CREATED, ORDER_SYNC_OUTCOME.EXISTS, ORDER_SYNC_OUTCOME.PLANNED, ORDER_SYNC_OUTCOME.SKIPPED].includes(r.outcome));
    if (held.length) console.log(`${held.length} order(s) need attention: ${held.map((r) => `${r.name} ${r.outcome}`).join(', ')}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
