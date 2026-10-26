#!/usr/bin/env node
/**
 * Pins the order line rules to real website orders, with no network access.
 * The expected values are what the hub created for the same orders on
 * 20 and 26 Oct 2026 (web#3225, web#3234), before the office edited them.
 * Run with: node scripts/order-sync-self-test.js
 */
import assert from 'node:assert/strict';

import { CUSTOMER_MATCH, ORDER_SYNC_WARNING, UNLEASHED_UOM } from '../src/constants/index.js';
import {
  buildSalesOrder,
  chooseCustomer,
  deliveryName,
  localDate,
  namesDisagree,
  normaliseOrder,
  planLineItem,
  round2,
} from '../src/utils/orderSyncPlan.js';
import { parseOrderState } from '../src/utils/orderSyncStore.js';

const settings = {
  prefix: 'web',
  status: 'Placed',
  warehouseCode: 'WH',
  freightCode: 'FREIGHT',
  taxCode: 'G.S.T.',
  taxRate: 0.1,
  currencyCode: 'AUD',
  timeZone: 'Australia/Melbourne',
};

const money = (amount) => ({ shopMoney: { amount: String(amount) } });
const product = (code, uom, weight, perGram) => ({ Guid: `guid-${code}`, ProductCode: code, UnitOfMeasure: { Name: uom }, Weight: weight, DefaultSellPrice: perGram ?? null });
const lineItem = ({ sku, quantity, unit, discount, weight }) => ({
  id: `gid://shopify/LineItem/${sku}`,
  sku,
  title: sku,
  quantity,
  originalUnitPriceSet: money(unit),
  originalTotalSet: money(round2(unit * quantity)),
  discountAllocations: discount ? [{ allocatedAmountSet: money(discount) }] : [],
  variant: { inventoryItem: { measurement: { weight: { value: weight, unit: 'KILOGRAMS' } } } },
});

const customer = {
  Guid: 'cust-guid',
  CustomerCode: 'PP852',
  CustomerName: "Paton's Place",
  Email: 'office@patonsplace.com.au',
  Obsolete: false,
  SalesOrderGroup: 'Independent',
  SalesPerson: { Guid: 'sp-guid', FullName: 'Lucy Loccisano' },
  Contacts: [],
};

// ---- web#3234: three pieces sold each, 10% AIOD discount, freight ----------
const order3234 = normaliseOrder({
  id: 'gid://shopify/Order/18963785056409',
  name: '#3234',
  createdAt: '2026-10-26T01:21:52Z',
  cancelledAt: null,
  test: false,
  note: 'please post',
  taxesIncluded: false,
  currencyCode: 'AUD',
  email: 'craigieburn@patonsplace.com.au',
  customer: { id: 'gid://shopify/Customer/5141779349657', email: 'craigieburn@patonsplace.com.au', defaultAddress: { company: 'Patons Place Jewellers' }, metafield: null },
  shippingAddress: { company: 'Patons Place Jewellers', name: 'Glenn Travaglini', address1: 'Shop B00-20 Craigieburn Central Shopping Centre', address2: null, city: 'Craigieburn', provinceCode: 'VIC', zip: '3064', country: 'Australia' },
  shippingLines: { nodes: [{ title: 'Next Day Courier Delivery', discountedPriceSet: money('20.9') }] },
  lineItems: { nodes: [
    lineItem({ sku: '9KDP663', quantity: 1, unit: 321.11, discount: 32.11, weight: 0.53 }),
    lineItem({ sku: '9KCR632', quantity: 1, unit: 127.13, discount: 12.71, weight: 0.71 }),
    lineItem({ sku: '9KC589', quantity: 1, unit: 277.08, discount: 27.7, weight: 2 }),
  ] },
  subtotalPriceSet: money('652.8'),
  totalTaxSet: money('67.37'),
  totalPriceSet: money('741.07'),
});

{
  const products = {
    '9KDP663': product('9KDP663', UNLEASHED_UOM.EACH, 0.53),
    '9KCR632': product('9KCR632', UNLEASHED_UOM.EACH, 0.71),
    '9KC589': product('9KC589', UNLEASHED_UOM.EACH, 2),
  };
  const { body, warnings, totals } = buildSalesOrder({ order: order3234, customer, products, settings, freightProduct: product('FREIGHT', UNLEASHED_UOM.EACH, null) });
  assert.equal(body.OrderNumber, 'web#3234');
  assert.equal(body.OrderDate, '2026-10-26'); // 12:21 Melbourne
  assert.equal(body.CustomerRef, 'Website Order #3234');
  assert.equal(body.Comments, 'please post');
  assert.deepEqual(body.Customer, { Guid: 'cust-guid', CustomerCode: 'PP852' });
  assert.equal(body.SalesOrderGroup, 'Independent');
  assert.deepEqual(body.SalesPerson, { Guid: 'sp-guid' });
  assert.equal(body.DeliveryName, 'Patons Place Jewellers - Glenn Travaglini');
  assert.equal(body.DeliverySuburb, 'Craigieburn');
  assert.equal(body.DeliveryCity, null);
  assert.equal(body.DeliveryRegion, 'VIC');
  assert.equal(body.SourceId, 'gid://shopify/Order/18963785056409');
  assert.equal(body.SalesOrderLines.length, 4);
  // The hub's lines for web#3234, before the office touched it.
  assert.deepEqual(
    body.SalesOrderLines.map((l) => [l.LineNumber, l.Product.ProductCode, l.OrderQuantity, l.UnitPrice, l.DiscountRate, l.LineTotal, l.LineTax]),
    [
      [1, '9KDP663', 1, 321.11, 0.1, 289, 28.9],
      [2, '9KCR632', 1, 127.13, 0.1, 114.42, 11.44],
      [3, '9KC589', 1, 277.08, 0.1, 249.37, 24.94],
      [4, 'FREIGHT', 1, 20.9, 0, 20.9, 2.09],
    ],
  );
  assert.deepEqual(totals, { subTotal: 673.69, taxTotal: 67.37, total: 741.06 }); // 1c of rounding, the hub had the same
  assert.deepEqual(warnings, []);
  assert.equal(body.SubTotal, 673.69);
  assert.equal(body.Total, 741.06);
}

// ---- chain: one line per piece, grams as quantity, per-gram price ---------
{
  // web#3225 line: 9KTFY02945CM × 2 at $184.74, 1.57 g, 10% off → two lines of 1.57 @ 117.67 = 166.27
  const item = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: '9KTFY02945CM', quantity: 2, unit: 184.74, discount: 36.94, weight: 1.57 })] } }).lineItems[0];
  const { lines, warnings } = planLineItem(item, product('9KTFY02945CM', UNLEASHED_UOM.WEIGHT, 1.57), 0.1);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.OrderQuantity, 1.57);
    assert.equal(line.UnitPrice, 117.67);
    assert.equal(line.DiscountRate, 0.1);
    assert.equal(line.LineTotal, 166.27);
    assert.equal(line.LineTax, 16.63);
  }
  assert.deepEqual(warnings, []);

  // web#3195: 9KPCY03045CM × 3 at $393.17, 3.23 g → three lines of 3.23 @ 121.72
  // (Unleashed now lists 122.11/g, which no longer explains 393.17, so the website price is divided by the weight)
  const three = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: '9KPCY03045CM', quantity: 3, unit: 393.17, discount: 117.93, weight: 3.23 })] } }).lineItems[0];
  const planned = planLineItem(three, product('9KPCY03045CM', UNLEASHED_UOM.WEIGHT, 3.23, 122.11), 0.1);
  assert.equal(planned.lines.length, 3);
  assert.equal(planned.lines[0].OrderQuantity, 3.23);
  assert.equal(planned.lines[0].UnitPrice, 121.72);

  // web#3225: 9KGZP080555CM at $428.92, 3.68 g, Unleashed lists 116.56/g (× 3.68 = 428.94) → 116.56, as the hub had
  const listed = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: '9KGZP080555CM', quantity: 1, unit: 428.92, discount: 42.89, weight: 3.68 })] } }).lineItems[0];
  assert.equal(planLineItem(listed, product('9KGZP080555CM', UNLEASHED_UOM.WEIGHT, 3.68, 116.56), 0.1).lines[0].UnitPrice, 116.56);

  // web#3225: 9KBLW02750CM $131.89 with $13.18 off is 10%, not 9.99%
  const tenPercent = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: '9KBLW02750CM', quantity: 1, unit: 131.89, discount: 13.18, weight: 1.09 })] } }).lineItems[0];
  assert.equal(planLineItem(tenPercent, product('9KBLW02750CM', UNLEASHED_UOM.EACH, 1.09), 0.1).lines[0].DiscountRate, 0.1);
  // …but a genuine odd rate is kept exactly
  const odd = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: 'Z', quantity: 1, unit: 100, discount: 12.34, weight: 1 })] } }).lineItems[0];
  assert.equal(planLineItem(odd, product('Z', UNLEASHED_UOM.EACH, 1), 0.1).lines[0].DiscountRate, 0.1234);

  // Sold each, quantity 2 → one line, quantity 2 (web#3233: 9KER595 × 2)
  const each = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: '9KER595', quantity: 2, unit: 272.22, discount: 0, weight: 2.04 })] } }).lineItems[0];
  const eachPlan = planLineItem(each, product('9KER595', UNLEASHED_UOM.EACH, 2.04), 0.1);
  assert.equal(eachPlan.lines.length, 1);
  assert.deepEqual([eachPlan.lines[0].OrderQuantity, eachPlan.lines[0].UnitPrice, eachPlan.lines[0].DiscountRate, eachPlan.lines[0].LineTotal], [2, 272.22, 0, 544.44]);

  // Sold by weight but Shopify has no weight → one line each, with a warning
  const noWeight = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: 'X', quantity: 2, unit: 100, discount: 0, weight: 0 })] } }).lineItems[0];
  const fallback = planLineItem(noWeight, product('X', UNLEASHED_UOM.WEIGHT, 0), 0.1);
  assert.equal(fallback.lines.length, 1);
  assert.equal(fallback.lines[0].OrderQuantity, 2);
  assert.match(fallback.warnings[0], new RegExp(ORDER_SYNC_WARNING.NO_WEIGHT));

  // An order-level code ($20.90 off one line) is a line discount rate too
  const coded = normaliseOrder({ lineItems: { nodes: [lineItem({ sku: 'Y', quantity: 1, unit: 209, discount: 20.9, weight: 1 })] } }).lineItems[0];
  assert.equal(planLineItem(coded, product('Y', UNLEASHED_UOM.EACH, 1), 0.1).lines[0].DiscountRate, 0.1);
}

// ---- choosing the customer ------------------------------------------------
{
  const order = { ...order3234 };
  const other = { ...customer, CustomerCode: 'PP853', Email: 'craigieburn@patonsplace.com.au' };

  // No mapping, no email match → unmatched, reason names the email.
  let choice = chooseCustomer({ order, mapped: null, byEmail: [] });
  assert.equal(choice.customer, null);
  assert.match(choice.reason, /craigieburn@patonsplace.com.au/);

  // Exactly one active customer with the email → that one.
  choice = chooseCustomer({ order, mapped: null, byEmail: [other, { ...other, CustomerCode: 'OLD', Obsolete: true }] });
  assert.equal(choice.customer.CustomerCode, 'PP853');
  assert.equal(choice.via, CUSTOMER_MATCH.EMAIL);

  // Two active customers with the email → ambiguous, never a guess.
  choice = chooseCustomer({ order, mapped: null, byEmail: [other, { ...other, CustomerCode: 'PP854' }] });
  assert.equal(choice.customer, null);
  assert.match(choice.reason, /2 Unleashed customers share/);

  // The contact's email counts only when no record email matches.
  const viaContact = { ...customer, CustomerCode: 'CT1', Email: 'other@x', Contacts: [{ EmailAddress: 'Craigieburn@PatonsPlace.com.au' }] };
  choice = chooseCustomer({ order, mapped: null, byEmail: [viaContact] });
  assert.equal(choice.customer.CustomerCode, 'CT1');
  assert.equal(choice.via, CUSTOMER_MATCH.CONTACT_EMAIL);

  // The office's mapping wins over the email.
  const mappedOrder = { ...order, customer: { ...order.customer, mappedCode: 'PP852' } };
  choice = chooseCustomer({ order: mappedOrder, mapped: customer, byEmail: [other] });
  assert.equal(choice.customer.CustomerCode, 'PP852');
  assert.equal(choice.via, CUSTOMER_MATCH.METAFIELD);

  // A mapping to a code that no longer exists falls back to the email, with a warning.
  choice = chooseCustomer({ order: mappedOrder, mapped: null, byEmail: [other] });
  assert.equal(choice.customer.CustomerCode, 'PP853');
  assert.match(choice.warnings[0], new RegExp(ORDER_SYNC_WARNING.MAPPED_CODE_MISSING));
}

// ---- small helpers --------------------------------------------------------
assert.equal(deliveryName({ company: 'Kalamunda Jewellers', name: 'Poppy Cook' }), 'Kalamunda Jewellers - Poppy Cook');
assert.equal(deliveryName({ company: '', name: 'Poppy Cook' }), 'Poppy Cook');
assert.equal(namesDisagree('Patons Place Jewellers', "Paton's Place"), false);
assert.equal(namesDisagree('Class A Manufacturing Jewellers', 'Class A Manufacturing Jewellers'), false);
assert.equal(namesDisagree('Kalamunda Jewellers', 'Gold City Jewellers'), true);
assert.equal(localDate('2026-10-25T13:30:00Z', 'Australia/Melbourne'), '2026-10-26'); // 00:30 AEDT
assert.equal(localDate('2026-10-25T12:30:00Z', 'Australia/Melbourne'), '2026-10-25');
assert.deepEqual(parseOrderState('not json').orders, {});
assert.equal(parseOrderState('{"orders":{"a":{"outcome":"created"}}}').orders.a.outcome, 'created');

console.log('order sync self-test: all assertions passed');
