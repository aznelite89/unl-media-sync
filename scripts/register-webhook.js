#!/usr/bin/env node
/**
 * Registers the Unleashed webhook subscription that drives near-real-time sync.
 *
 *   node scripts/register-webhook.js https://<function-app>.azurewebsites.net/api/unleashed/product-webhook
 *
 * Unleashed returns `signatureKey` ONCE. It is written straight into
 * local.settings.json and never printed — the endpoint rejects every delivery
 * without it, so losing it means deleting the subscription and starting over.
 *
 * Afterwards, push it to Azure with:
 *   python3 scripts/push-settings.py <resource-group> <function-app>
 *
 * Existing subscriptions are checked first so re-running does not create
 * duplicates (which would double every delivery).
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

const { SUBSCRIBED_EVENTS } = await import('../src/constants/index.js');
const { createUnleashedClient } = await import('../src/utils/unleashed.js');

const notificationUrl = process.argv[2];
if (!notificationUrl || !notificationUrl.startsWith('https://')) {
  console.error(
    'Usage: node scripts/register-webhook.js https://<host>/api/unleashed/product-webhook',
  );
  process.exit(1);
}

const apiId = process.env.UNLEASHED_API_ID;
const apiKey = process.env.UNLEASHED_API_KEY;
if (!apiId || !apiKey) {
  console.error('UNLEASHED_API_ID and UNLEASHED_API_KEY must be set.');
  process.exit(1);
}

const quietLog = { info: () => {}, warn: console.warn, error: console.error };
const unleashed = createUnleashedClient({ unleashed: { apiId, apiKey } }, quietLog);

// Re-running must not create a second subscription for the same endpoint.
try {
  const existing = await unleashed.get('/webhooks/subscriptions');
  const list = existing?.Items ?? existing?.items ?? existing?.subscriptions ?? [];
  const clash = (Array.isArray(list) ? list : []).find(
    (item) => (item?.notificationUrl ?? item?.NotificationUrl) === notificationUrl,
  );
  if (clash) {
    console.log('A subscription for this URL already exists:');
    console.log(`  subscriptionId : ${clash.subscriptionId ?? clash.SubscriptionId}`);
    console.log(`  eventTypes     : ${JSON.stringify(clash.eventTypes ?? clash.EventTypes)}`);
    console.log('\nNothing created. Delete it in Unleashed first if you need a fresh signatureKey.');
    process.exit(0);
  }
  console.log(`Existing subscriptions: ${Array.isArray(list) ? list.length : 0}`);
} catch (error) {
  console.warn(`Could not list existing subscriptions (${error.message}); continuing.`);
}

const subscription = await unleashed.createWebhookSubscription({
  description: 'Searay: sync product images to Shopify media',
  notificationUrl,
  eventTypes: SUBSCRIBED_EVENTS,
});

const signatureKey = subscription?.signatureKey ?? subscription?.SignatureKey;
const subscriptionId = subscription?.subscriptionId ?? subscription?.SubscriptionId;

console.log('\nSubscription created.');
console.log(`  subscriptionId : ${subscriptionId}`);
console.log(`  notificationUrl: ${notificationUrl}`);
console.log(`  eventTypes     : ${JSON.stringify(SUBSCRIBED_EVENTS)}`);

if (!signatureKey) {
  console.error(
    '\nNo signatureKey in the response. Without it the endpoint rejects every delivery — ' +
      'delete this subscription in Unleashed and retry.',
  );
  process.exit(1);
}

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
settings.Values = settings.Values ?? {};
settings.Values.UNLEASHED_WEBHOOK_SIGNATURE_KEY = signatureKey;
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

console.log(
  `  signatureKey   : stored in local.settings.json (${signatureKey.length} chars, not shown)`,
);
console.log('\nNow push it to Azure:');
console.log('  python3 scripts/push-settings.py searay-func-rg searay-unleashed-sync');
