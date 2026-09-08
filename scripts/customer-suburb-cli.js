#!/usr/bin/env node
/**
 * Fills empty Unleashed customer Suburb fields from City — the field the
 * Shopify connector writes the suburb into. Read-only unless --apply is given.
 *
 *   node scripts/customer-suburb-cli.js --all                     # report only
 *   node scripts/customer-suburb-cli.js --all --csv reports/suburb.csv
 *   node scripts/customer-suburb-cli.js --code DAR001 --apply      # one customer, verified
 *   node scripts/customer-suburb-cli.js --all --apply
 *   node scripts/customer-suburb-cli.js --since 2026-09-01 --apply
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
const { fillSuburbs, buildSuburbCsv } = await import('../src/utils/customerSuburb.js');
const { SUBURB_OUTCOME } = await import('../src/constants/index.js');

function parseArgs(argv) {
  const args = { apply: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--code') args.code = argv[++i];
    else if (arg === '--since') args.since = argv[++i];
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--csv') args.csv = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      args.help = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.all && !args.code && !args.since)) {
  console.log(
    [
      'Usage:',
      '  node scripts/customer-suburb-cli.js --all [--limit N] [--csv FILE] [--apply]',
      '  node scripts/customer-suburb-cli.js --code <CUSTOMER_CODE> [--apply]',
      '  node scripts/customer-suburb-cli.js --since YYYY-MM-DD [--apply]',
      '',
      'Without --apply nothing is written. DRY_RUN=true in settings also blocks writes.',
    ].join('\n'),
  );
  process.exit(args.help ? 0 : 1);
}

const config = loadConfig();
const log = {
  info: (...parts) => console.log(...parts),
  warn: (...parts) => console.warn(...parts),
  error: (...parts) => console.error(...parts),
};
const unleashed = createUnleashedClient(config, log);

console.log(`apply: ${args.apply}  dry run setting: ${config.dryRun}`);

const report = await fillSuburbs({
  sinceIso: args.all ? undefined : args.since,
  customerCode: args.code,
  limit: args.limit,
  apply: args.apply,
  unleashed,
  config,
  log,
});

for (const result of report.results) {
  const what = result.changes.map((change) => `${change.addressType}: "${change.city}"`).join('; ');
  const drift = result.drifted?.length ? `  !! other fields changed: ${result.drifted.join(', ')}` : '';
  console.log(
    `${result.customerCode.padEnd(16)} ${result.outcome.padEnd(10)} ${what}` +
      `${result.error ? `  — ${result.error}` : ''}${drift}`,
  );
}
console.log(
  `\nscanned ${report.scanned} customer(s); outcomes ${JSON.stringify(report.byOutcome)}` +
    `${report.truncated ? ' (stopped at --limit)' : ''}`,
);

if (args.csv) {
  fs.mkdirSync(path.dirname(path.resolve(args.csv)), { recursive: true });
  fs.writeFileSync(path.resolve(args.csv), `${buildSuburbCsv(report)}\n`);
  console.log(`Wrote ${args.csv}`);
}

const pending = report.byOutcome[SUBURB_OUTCOME.DRY_RUN] ?? 0;
if (!args.apply && pending) {
  console.log(`Nothing was changed. Re-run with --apply to fill ${pending} customer(s).`);
}
if (report.byOutcome[SUBURB_OUTCOME.FAILED]) process.exit(2);
