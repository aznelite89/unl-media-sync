/**
 * Turns a Shopify order into the Unleashed sales order the office wants, with
 * no network access: everything here is a pure function of its inputs, so the
 * CLI can print exactly what the timer would send and the self-test can pin
 * the line rules to real orders.
 *
 * The line rules, agreed with the office (26 Oct 2026):
 *  - a product sold by weight (Unleashed unit of measure "Weight", i.e. chain)
 *    goes on ONE LINE PER PIECE, quantity = grams, unit price = price per gram,
 *    so each piece can be weighed and corrected on its own line;
 *  - a product sold each goes on one line with the quantity;
 *  - freight is a FREIGHT line at the shipping price;
 *  - the website discount (AIOD tier, a code) becomes the line DiscountRate;
 *  - the customer is never created or edited: it is chosen, and only chosen.
 */

import {
  CUSTOMER_MATCH,
  ORDER_SYNC_TOTAL_TOLERANCE_PER_LINE,
  ORDER_SYNC_WARNING,
  UNLEASHED_UOM,
} from '../constants/index.js';

const CENTS = 100;
const RATE_PLACES = 10_000;
/** Dollars the listed per-gram price × weight may differ from the website price and still be used. */
const PER_GRAM_TOLERANCE = 0.02;

export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * CENTS) / CENTS;
}

export function round4(value) {
  return Math.round((Number(value) + Number.EPSILON) * RATE_PLACES) / RATE_PLACES;
}

function money(set) {
  return Number(set?.shopMoney?.amount ?? 0);
}

/**
 * The calendar date of an instant in the office's time zone, as `YYYY-MM-DD`.
 * Unleashed wants a date; the office works in Melbourne, so an order placed at
 * 23:30 on Friday is Friday's order, not Saturday's (UTC) one.
 */
export function localDate(iso, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/**
 * Flattens the GraphQL order into plain fields. Everything downstream reads
 * this shape, so the GraphQL selection can change in one place.
 *
 * @param {object} node The `order` node from `ORDER_FIELDS`.
 */
export function normaliseOrder(node) {
  const customer = node.customer
    ? {
        id: node.customer.id,
        email: (node.customer.email ?? '').trim().toLowerCase() || null,
        firstName: node.customer.firstName ?? '',
        lastName: node.customer.lastName ?? '',
        company: node.customer.defaultAddress?.company ?? null,
        mappedCode: node.customer.metafield?.value?.trim() || null,
      }
    : null;

  return {
    id: node.id,
    name: node.name,
    createdAt: node.createdAt,
    cancelledAt: node.cancelledAt ?? null,
    test: Boolean(node.test),
    note: node.note ?? null,
    taxesIncluded: Boolean(node.taxesIncluded),
    currencyCode: node.currencyCode,
    email: (node.email ?? '').trim().toLowerCase() || null,
    customer,
    shippingAddress: node.shippingAddress ?? null,
    shippingLines: (node.shippingLines?.nodes ?? []).map((line) => ({
      title: line.title,
      price: money(line.discountedPriceSet),
    })),
    lineItems: (node.lineItems?.nodes ?? []).map((item) => ({
      id: item.id,
      sku: (item.sku ?? '').trim(),
      title: item.title,
      quantity: Number(item.quantity),
      originalUnitPrice: money(item.originalUnitPriceSet),
      originalTotal: money(item.originalTotalSet),
      discount: (item.discountAllocations ?? []).reduce(
        (sum, allocation) => sum + money(allocation.allocatedAmountSet),
        0,
      ),
      // Shopify labels the unit "KILOGRAMS" but the catalogue stores grams in it.
      weightGrams: Number(item.variant?.inventoryItem?.measurement?.weight?.value ?? 0),
    })),
    subtotalPrice: money(node.subtotalPriceSet),
    totalTax: money(node.totalTaxSet),
    totalPrice: money(node.totalPriceSet),
  };
}

/**
 * The website discount as a rate. AIOD takes a whole percentage off each
 * line, so when the two-decimal rate reproduces the discount to the cent it
 * is the rate (13.18 off 131.89 is 10%, not 9.99%); otherwise the exact one.
 */
export function discountRateFor(item) {
  if (!(item.originalTotal > 0) || !(item.discount > 0)) return 0;
  const exact = Math.min(item.discount / item.originalTotal, 1);
  const whole = Math.round(exact * CENTS) / CENTS;
  if (Math.abs(round2(item.originalTotal * whole) - round2(item.discount)) <= 0.01 * Math.max(item.quantity, 1)) return whole;
  return round4(exact);
}

/**
 * Price per gram for a weight product. Unleashed's own per-gram sell price is
 * used when it explains the website price (the website price is that price ×
 * the weight, rounded), so the line carries the same figure the office sees
 * on the product; otherwise the website price is divided by the weight.
 */
export function perGramPrice(item, product) {
  const listed = Number(product?.DefaultSellPrice);
  if (listed > 0 && Math.abs(round2(listed * item.weightGrams) - item.originalUnitPrice) <= PER_GRAM_TOLERANCE) {
    return round2(listed);
  }
  return round2(item.originalUnitPrice / item.weightGrams);
}

export function isWeightProduct(product) {
  return String(product?.UnitOfMeasure?.Name ?? '').trim().toLowerCase() === UNLEASHED_UOM.WEIGHT.toLowerCase();
}

/**
 * Unleashed lines for one Shopify line item. Weight products fan out to one
 * line per piece; everything else is one line.
 *
 * @param {object} item A normalised line item.
 * @param {object} product The Unleashed product for its SKU.
 * @param {number} taxRate
 * @returns {{ lines: object[], warnings: string[] }}
 */
export function planLineItem(item, product, taxRate) {
  const warnings = [];
  const discountRate = discountRateFor(item);
  const byWeight = isWeightProduct(product);
  const hasWeight = item.weightGrams > 0;

  if (byWeight && !hasWeight) {
    warnings.push(`${ORDER_SYNC_WARNING.NO_WEIGHT}: ${item.sku} is sold by weight but Shopify has no weight; sent as one line each`);
  }

  const reference = { Guid: product.Guid, ProductCode: product.ProductCode };
  const line = (orderQuantity, unitPrice) => {
    const lineTotal = round2(orderQuantity * unitPrice * (1 - discountRate));
    return {
      Product: reference,
      OrderQuantity: orderQuantity,
      UnitPrice: unitPrice,
      DiscountRate: discountRate,
      LineTotal: lineTotal,
      LineTax: round2(lineTotal * taxRate),
      Comments: null,
    };
  };

  if (byWeight && hasWeight) {
    const perGram = perGramPrice(item, product);
    return {
      lines: Array.from({ length: item.quantity }, () => line(item.weightGrams, perGram)),
      warnings,
    };
  }
  return { lines: [line(item.quantity, round2(item.originalUnitPrice))], warnings };
}

/** `Company - Person` the way the hub and the office write delivery names. */
export function deliveryName(address) {
  if (!address) return null;
  const company = (address.company ?? '').trim();
  const person = (address.name ?? '').trim();
  if (company && person) return `${company} - ${person}`;
  return company || person || null;
}

const NOISE_WORDS = new Set(['pty', 'ltd', 'the', 'and', 'jewellers', 'jewellery', 'jeweller', 'jewelers', 'co']);

/** Letters-only tokens with company boilerplate removed, for a loose name check. */
export function nameTokens(value) {
  return new Set(
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token && !NOISE_WORDS.has(token)),
  );
}

/** True when the two names share no meaningful word at all. */
export function namesDisagree(shopifyName, unleashedName) {
  const a = nameTokens(shopifyName);
  const b = nameTokens(unleashedName);
  if (!a.size || !b.size) return false;
  for (const token of a) if (b.has(token)) return false;
  return true;
}

/**
 * Builds the POST /SalesOrders body.
 *
 * @param {{
 *   order: object, customer: object, products: Record<string, object>,
 *   settings: { prefix: string, status: string, warehouseCode: string, freightCode: string,
 *               taxCode: string, taxRate: number, currencyCode: string, timeZone: string },
 *   freightProduct: object | null,
 * }} input
 * @returns {{ body: object, warnings: string[], totals: { subTotal: number, taxTotal: number, total: number } }}
 */
export function buildSalesOrder({ order, customer, products, settings, freightProduct }) {
  const warnings = [];
  const lines = [];

  if (order.taxesIncluded) {
    warnings.push(`${ORDER_SYNC_WARNING.TAX_INCLUSIVE}: Shopify prices are tax inclusive; Unleashed lines are sent ex-GST as given`);
  }

  for (const item of order.lineItems) {
    const product = products[item.sku];
    if (!product) throw new Error(`no Unleashed product for SKU ${item.sku || '(blank)'}`);
    const planned = planLineItem(item, product, settings.taxRate);
    lines.push(...planned.lines);
    warnings.push(...planned.warnings);
  }

  for (const shipping of order.shippingLines) {
    if (shipping.price <= 0) continue;
    if (!freightProduct) throw new Error(`no Unleashed product for freight code ${settings.freightCode}`);
    const lineTotal = round2(shipping.price);
    lines.push({
      Product: { Guid: freightProduct.Guid, ProductCode: freightProduct.ProductCode },
      OrderQuantity: 1,
      UnitPrice: lineTotal,
      DiscountRate: 0,
      LineTotal: lineTotal,
      LineTax: round2(lineTotal * settings.taxRate),
      Comments: shipping.title ?? null,
    });
  }

  if (!lines.length) throw new Error('order has no lines');

  const subTotal = round2(lines.reduce((sum, line) => sum + line.LineTotal, 0));
  const taxTotal = round2(lines.reduce((sum, line) => sum + line.LineTax, 0));
  const total = round2(subTotal + taxTotal);

  const tolerance = ORDER_SYNC_TOTAL_TOLERANCE_PER_LINE * lines.length + 0.01;
  if (Math.abs(total - order.totalPrice) > tolerance) {
    warnings.push(
      `${ORDER_SYNC_WARNING.TOTAL_MISMATCH}: Unleashed total ${total.toFixed(2)} vs Shopify ${order.totalPrice.toFixed(2)}`,
    );
  }

  const shopifyName = order.shippingAddress?.company || order.customer?.company || deliveryName(order.shippingAddress);
  if (namesDisagree(shopifyName, customer.CustomerName)) {
    warnings.push(
      `${ORDER_SYNC_WARNING.NAME_MISMATCH}: Shopify "${shopifyName}" vs Unleashed ${customer.CustomerCode} "${customer.CustomerName}"`,
    );
  }

  const date = localDate(order.createdAt, settings.timeZone);
  const address = order.shippingAddress;

  const body = {
    OrderNumber: `${settings.prefix}${order.name}`,
    OrderDate: date,
    RequiredDate: date,
    OrderStatus: settings.status,
    Customer: { Guid: customer.Guid, CustomerCode: customer.CustomerCode },
    CustomerRef: `Website Order ${order.name}`,
    Comments: order.note || null,
    Warehouse: { WarehouseCode: settings.warehouseCode },
    Currency: { CurrencyCode: settings.currencyCode },
    ExchangeRate: 1,
    DiscountRate: 0,
    Tax: { TaxCode: settings.taxCode },
    TaxRate: settings.taxRate,
    SourceId: order.id,
    DeliveryName: deliveryName(address),
    DeliveryStreetAddress: address?.address1 ?? null,
    DeliveryStreetAddress2: address?.address2 || null,
    // The hub put the suburb in City and the full state name in Region; the
    // office writes Suburb + the abbreviation on every hand-entered address.
    DeliverySuburb: address?.city ?? null,
    DeliveryCity: null,
    DeliveryRegion: address?.provinceCode ?? null,
    DeliveryCountry: address?.country ?? null,
    DeliveryPostCode: address?.zip ?? null,
    DeliveryInstruction: null,
    SubTotal: subTotal,
    TaxTotal: taxTotal,
    Total: total,
    SalesOrderLines: lines.map((line, index) => ({ LineNumber: index + 1, ...line })),
  };
  if (customer.SalesOrderGroup) body.SalesOrderGroup = customer.SalesOrderGroup;
  if (customer.SalesPerson?.Guid) body.SalesPerson = { Guid: customer.SalesPerson.Guid };

  return { body, warnings, totals: { subTotal, taxTotal, total } };
}

/**
 * Picks the Unleashed customer for an order from what was found, without any
 * network access: the caller passes the mapped customer (if the Shopify
 * customer carries a code) and every active customer whose email matches.
 *
 * @param {{ order: object, mapped: object | null, byEmail: object[] }} input
 * @returns {{ customer: object | null, via: string | null, reason: string | null, warnings: string[] }}
 */
export function chooseCustomer({ order, mapped, byEmail }) {
  const warnings = [];
  const mappedCode = order.customer?.mappedCode;

  if (mappedCode) {
    if (mapped && !mapped.Obsolete) {
      return { customer: mapped, via: CUSTOMER_MATCH.METAFIELD, reason: null, warnings };
    }
    warnings.push(
      `${ORDER_SYNC_WARNING.MAPPED_CODE_MISSING}: Shopify customer is mapped to ${mappedCode} but no active Unleashed customer has that code`,
    );
  }

  const email = order.customer?.email || order.email;
  if (!email) return { customer: null, via: null, reason: 'no email on the order', warnings };

  const active = byEmail.filter((candidate) => !candidate.Obsolete);
  const direct = active.filter((candidate) => (candidate.Email ?? '').trim().toLowerCase() === email);
  const viaContact = active.filter(
    (candidate) =>
      !direct.includes(candidate) &&
      (candidate.Contacts ?? []).some(
        (contact) => (contact.EmailAddress ?? '').trim().toLowerCase() === email,
      ),
  );

  const pool = direct.length ? direct : viaContact;
  const via = direct.length ? CUSTOMER_MATCH.EMAIL : CUSTOMER_MATCH.CONTACT_EMAIL;
  if (pool.length === 1) return { customer: pool[0], via, reason: null, warnings };
  if (pool.length > 1) {
    return {
      customer: null,
      via: null,
      reason: `${pool.length} Unleashed customers share ${email}: ${pool.map((c) => c.CustomerCode).join(', ')}`,
      warnings,
    };
  }
  return { customer: null, via: null, reason: `no Unleashed customer has the email ${email}`, warnings };
}

/** One line per Unleashed line, for logs, emails and the CLI. */
export function describeLines(body) {
  return body.SalesOrderLines.map(
    (line) =>
      `${String(line.LineNumber).padStart(2)}  ${line.Product.ProductCode.padEnd(18)} ` +
      `qty ${String(line.OrderQuantity).padStart(6)} @ ${line.UnitPrice.toFixed(2).padStart(8)}` +
      `${line.DiscountRate ? ` -${(line.DiscountRate * 100).toFixed(1)}%` : ''}` +
      ` = ${line.LineTotal.toFixed(2).padStart(9)}${line.Comments ? `  (${line.Comments})` : ''}`,
  );
}
