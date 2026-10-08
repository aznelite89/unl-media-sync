#!/usr/bin/env node
/**
 * Picks This Week Specials and moves the `weekly-special` tag onto them.
 * Read-only unless --apply.
 *
 *   node scripts/weekly-specials-cli.js                  # report only
 *   node scripts/weekly-specials-cli.js --apply
 *   node scripts/weekly-specials-cli.js --apply --email  # also send the office email
 *   node scripts/weekly-specials-cli.js --csv            # write the picks CSV to reports/
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
const { syncWeeklySpecials } = await import('../src/utils/weeklySpecials.js');
const { toAttachment } = await import('../src/utils/email.js');
const { sendReport } = await import('../src/utils/notify.js');
const { buildWeeklySpecialsCsv, buildWeeklySpecialsSummary } = await import(
  '../src/utils/report.js'
);
const { SPECIAL_CATEGORY_LABEL, WEEKLY_SPECIAL_OUTCOME } = await import('../src/constants/index.js');

const argv = process.argv.slice(2);
const known = new Set(['--apply', '--force', '--email', '--csv', '--help', '-h']);
const unknown = argv.filter((arg) => !known.has(arg));
if (unknown.length || argv.includes('--help') || argv.includes('-h')) {
  if (unknown.length) console.error(`Unknown argument: ${unknown.join(' ')}`);
  console.log('Usage: node scripts/weekly-specials-cli.js [--apply] [--force] [--email] [--csv]');
  process.exit(unknown.length ? 1 : 0);
}
const apply = argv.includes('--apply');

const config = loadConfig();
const log = {
  info: (...parts) => console.log(...parts),
  warn: (...parts) => console.warn(...parts),
  error: (...parts) => console.error(...parts),
};

console.log(`apply: ${apply}  dry run setting: ${config.dryRun}`);

const report = await syncWeeklySpecials({
  unleashed: createUnleashedClient(config, log),
  shopify: createShopifyClient(config, log),
  config,
  log,
  apply,
  force: argv.includes('--force'),
});

console.log('\nThis week:');
for (const row of report.specials) {
  console.log(
    `  ${SPECIAL_CATEGORY_LABEL[row.category].padEnd(19)} ${String(row.price ?? '').padStart(8)} ` +
      `${row.landed.padEnd(15)} ${row.lastSold.padEnd(17)} ` +
      `${row.code.padEnd(18)} ${row.supplier.padEnd(14)} ${row.title}`,
  );
}
console.log('\nTag changes:');
for (const result of report.results) {
  console.log(
    `  ${(result.action ?? result.outcome).padEnd(9)} ${result.outcome.padEnd(9)} ${result.code.padEnd(18)} ` +
      `${result.title || result.productId}${result.error ? `  — ${result.error}` : ''}`,
  );
}

const summary = buildWeeklySpecialsSummary({ report });
console.log(`\n${summary.subject}\n\n${summary.text}`);
console.log(`\noutcomes ${JSON.stringify(report.byOutcome)}  collection order: ${report.ordering.status}`);

const specialsCsv = buildWeeklySpecialsCsv(report);
if (argv.includes('--csv')) {
  const name = `this-week-specials-${new Date().toISOString().slice(0, 10)}.csv`;
  fs.mkdirSync(path.join(projectRoot, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'reports', name), `${specialsCsv}\n`);
  console.log(`wrote reports/${name}`);
}

if (argv.includes('--email')) {
  const attachments = [toAttachment('this-week-specials.csv', specialsCsv)];
  const delivery = await sendReport({ config, summary, attachments, log: { info() {}, warn() {}, error: log.error } });
  console.log(`email delivered=${delivery.delivered}${delivery.reason ? ` (${delivery.reason})` : ''}`);
}

if (!apply && report.results.length) console.log('Nothing was changed. Re-run with --apply.');
if (report.byOutcome[WEEKLY_SPECIAL_OUTCOME.FAILED]) process.exit(2);
