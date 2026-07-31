#!/usr/bin/env node
/**
 * Runs the sync from your machine, with no Azure involved. This is the fastest
 * way to prove the pipeline works and to do the first catalogue pass.
 *
 *   node scripts/sync-cli.js --sku 9KCH37145CM --dry-run
 *   node scripts/sync-cli.js --since 2026-07-01 --limit 25
 *   node scripts/sync-cli.js --all
 *
 * Credentials are read from the environment, or from local.settings.json when
 * present, so it shares configuration with the Functions host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirror local.settings.json into the environment, matching `func start`.
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
const { reconcile, syncByProductCode, lookbackSince } = await import('../src/utils/reconcile.js');

function parseArgs(argv) {
  const args = { dryRun: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--sku') args.sku = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--start-page') args.startPage = Number.parseInt(argv[++i], 10);
    else if (arg === '--max-pages') args.maxPages = Number.parseInt(argv[++i], 10);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      args.help = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.sku && !args.since && !args.all)) {
  console.log(
    [
      'Usage:',
      '  node scripts/sync-cli.js --sku <PRODUCT_CODE> [--dry-run]',
      '  node scripts/sync-cli.js --since YYYY-MM-DD [--limit N] [--dry-run]',
      '  node scripts/sync-cli.js --all [--limit N] [--dry-run]',
      '',
      'Chunked catalogue pass (resumable — the report gives nextStartPage):',
      '  node scripts/sync-cli.js --all --start-page 1 --max-pages 8',
    ].join('\n'),
  );
  process.exit(args.help ? 0 : 1);
}

const config = loadConfig();
if (args.dryRun) config.dryRun = true;

const log = {
  info: (...parts) => console.log(...parts),
  warn: (...parts) => console.warn(...parts),
  error: (...parts) => console.error(...parts),
};

const unleashed = createUnleashedClient(config, log);
const shopify = createShopifyClient(config, log);

console.log(
  `store: ${config.shopify.storeDomain}  max images: ${config.maxSyncedImages}  ` +
    `delete removed: ${config.deleteRemovedMedia}  dry run: ${config.dryRun}`,
);

if (args.sku) {
  const result = await syncByProductCode({
    productCode: args.sku,
    unleashed,
    shopify,
    config,
    log,
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  const sinceIso = args.all ? undefined : (args.since ?? lookbackSince(config.reconcileLookbackMinutes));
  const report = await reconcile({
    sinceIso,
    limit: args.limit,
    startPage: args.startPage,
    maxPages: args.maxPages,
    unleashed,
    shopify,
    config,
    log,
  });
  console.log(JSON.stringify(report, null, 2));
}
