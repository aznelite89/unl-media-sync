#!/usr/bin/env node
/**
 * Tags products created in Unleashed in the last six months `new-arrival` and
 * orders the New Arrivals collection newest first. Read-only unless --apply.
 *
 *   node scripts/new-arrivals-cli.js                 # report only
 *   node scripts/new-arrivals-cli.js --apply
 *   node scripts/new-arrivals-cli.js --apply --force # also make removals the guard held back
 *
 * Credentials come from the environment, or local.settings.json when present.
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
const { syncNewArrivals } = await import('../src/utils/newArrivals.js');
const { NEW_ARRIVAL_OUTCOME } = await import('../src/constants/index.js');

const argv = process.argv.slice(2);
const known = new Set(['--apply', '--force', '--help', '-h']);
const unknown = argv.filter((arg) => !known.has(arg));
if (unknown.length || argv.includes('--help') || argv.includes('-h')) {
  if (unknown.length) console.error(`Unknown argument: ${unknown.join(' ')}`);
  console.log('Usage: node scripts/new-arrivals-cli.js [--apply] [--force]');
  process.exit(unknown.length ? 1 : 0);
}
const apply = argv.includes('--apply');
const force = argv.includes('--force');

const config = loadConfig();
const log = {
  info: (...parts) => console.log(...parts),
  warn: (...parts) => console.warn(...parts),
  error: (...parts) => console.error(...parts),
};

console.log(`apply: ${apply}  force: ${force}  dry run setting: ${config.dryRun}`);

const report = await syncNewArrivals({
  unleashed: createUnleashedClient(config, log),
  shopify: createShopifyClient(config, log),
  config,
  log,
  apply,
  force,
});

for (const result of report.results) {
  const what = result.action ?? result.outcome;
  console.log(
    `${what.padEnd(9)} ${result.outcome.padEnd(9)} ${result.created.padEnd(10)} ${result.code.padEnd(20)} ` +
      `${result.title || result.productId}${result.error ? `  — ${result.error}` : ''}`,
  );
}
console.log(
  `\ncreated since ${report.cutoff} (Unleashed modified since ${report.sinceIso}, ${report.scanned} read): ` +
    `${report.recent} codes -> ${report.wanted} Shopify products, ${report.taggedBefore} tagged before`,
);
console.log(`outcomes ${JSON.stringify(report.byOutcome)}`);
console.log(`not on Shopify: ${report.unmatched.length}  on two products: ${report.ambiguous.join(', ') || 'none'}`);
if (report.heldRemovals.length) console.log(`held back ${report.heldRemovals.length} removals (re-run with --force)`);
console.log(`collection order: ${report.ordering.status}`);

if (!apply && report.results.length) console.log('Nothing was changed. Re-run with --apply.');
if (report.byOutcome[NEW_ARRIVAL_OUTCOME.FAILED]) process.exit(2);
