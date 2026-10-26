#!/usr/bin/env node
/**
 * Subscribes the Function App to Shopify `orders/create`. Run once after deploying.
 *
 *   node scripts/register-shopify-order-webhook.js https://searay-unleashed-sync.azurewebsites.net/api/shopify/order-webhook
 *
 * Deliveries are signed with the custom app's API secret key (Shopify admin →
 * Apps → Develop apps → UnlShopSync → API credentials); set it as
 * SHOPIFY_WEBHOOK_SECRET on the Function App.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settingsPath = path.join(projectRoot, 'local.settings.json');
if (fs.existsSync(settingsPath)) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const [key, value] of Object.entries(settings?.Values ?? {})) {
    if (process.env[key] === undefined) process.env[key] = String(value);
  }
}

const { loadConfig } = await import('../src/utils/config.js');
const { createShopifyClient } = await import('../src/utils/shopify.js');
const { SHOPIFY_ORDER_WEBHOOK_TOPIC } = await import('../src/constants/index.js');

const callbackUrl = process.argv[2];
if (!callbackUrl) {
  console.error('Usage: node scripts/register-shopify-order-webhook.js <callback url>');
  process.exit(1);
}

const shopify = createShopifyClient(loadConfig());
const existing = await shopify.listWebhooks();
const already = existing.find((w) => w.topic === SHOPIFY_ORDER_WEBHOOK_TOPIC && w.endpoint?.callbackUrl === callbackUrl);
if (already) {
  console.log(`already subscribed: ${already.id}`);
  process.exit(0);
}
const created = await shopify.createOrderWebhook(callbackUrl);
console.log(`subscribed ${SHOPIFY_ORDER_WEBHOOK_TOPIC} → ${callbackUrl}: ${created?.id}`);
