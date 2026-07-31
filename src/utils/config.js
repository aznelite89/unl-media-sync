import {
  DEFAULT_MAX_MEDIA_PER_PRODUCT,
  DEFAULT_MAX_SYNCED_IMAGES,
  DEFAULT_RECONCILE_LOOKBACK_MINUTES,
  RECONCILE_MAX_PAGES,
} from '../constants/index.js';

function readBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads configuration from the environment (Azure app settings locally mirrored
 * by local.settings.json). Throws on anything the sync cannot run without, so a
 * misconfigured deployment fails loudly on first invocation instead of silently
 * no-oping.
 *
 * @param {{ requireWebhookKey?: boolean }} [options]
 */
export function loadConfig(options = {}) {
  const config = {
    unleashed: {
      apiId: process.env.UNLEASHED_API_ID,
      apiKey: process.env.UNLEASHED_API_KEY,
      webhookSignatureKey: process.env.UNLEASHED_WEBHOOK_SIGNATURE_KEY,
    },
    shopify: {
      storeDomain: process.env.SHOPIFY_STORE_DOMAIN,
      adminToken: process.env.SHOPIFY_ADMIN_TOKEN,
    },
    maxSyncedImages: readInt(process.env.MAX_SYNCED_IMAGES, DEFAULT_MAX_SYNCED_IMAGES),
    /** Total images allowed on one Shopify product page, counting existing media. */
    maxMediaPerProduct: readInt(
      process.env.MAX_MEDIA_PER_PRODUCT,
      DEFAULT_MAX_MEDIA_PER_PRODUCT,
    ),
    reconcileLookbackMinutes: readInt(
      process.env.RECONCILE_LOOKBACK_MINUTES,
      DEFAULT_RECONCILE_LOOKBACK_MINUTES,
    ),
    /** Raise for a whole-catalogue pass; the catalogue is larger than the default cap. */
    maxPages: readInt(process.env.RECONCILE_MAX_PAGES, RECONCILE_MAX_PAGES),
    /**
     * Off by default. When off, media this service added but Unleashed no longer
     * lists is left in place. Media it never added is never touched either way.
     */
    deleteRemovedMedia: readBool(process.env.DELETE_REMOVED_MEDIA, false),
    reorderMedia: readBool(process.env.REORDER_MEDIA, true),
    dryRun: readBool(process.env.DRY_RUN, false),
  };

  const missing = [];
  if (!config.unleashed.apiId) missing.push('UNLEASHED_API_ID');
  if (!config.unleashed.apiKey) missing.push('UNLEASHED_API_KEY');
  if (!config.shopify.storeDomain) missing.push('SHOPIFY_STORE_DOMAIN');
  if (!config.shopify.adminToken) missing.push('SHOPIFY_ADMIN_TOKEN');
  if (options.requireWebhookKey && !config.unleashed.webhookSignatureKey) {
    missing.push('UNLEASHED_WEBHOOK_SIGNATURE_KEY');
  }
  if (missing.length) {
    throw new Error(`Missing required app settings: ${missing.join(', ')}`);
  }

  return config;
}
