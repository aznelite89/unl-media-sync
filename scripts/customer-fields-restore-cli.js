#!/usr/bin/env node
/**
 * Puts blank Unleashed customer fields back from a Customers export (the
 * sandbox copy of production taken before the 2026-10-07 wipe). Read-only
 * unless --apply is given; a field is only ever written where production
 * holds nothing.
 *
 *   node scripts/customer-fields-restore-cli.js --export FILE.csv --codes codes.txt            # report only
 *   node scripts/customer-fields-restore-cli.js --export FILE.csv --code AJ027 --apply          # one customer, verified
 *   node scripts/customer-fields-restore-cli.js --export FILE.csv --codes codes.txt --limit 5 --apply
 *   node scripts/customer-fields-restore-cli.js --export FILE.csv --codes codes.txt --apply --csv reports/restore.csv
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
const { restoreCustomers, buildRestoreCsv } = await import('../src/utils/customerFieldsRestore.js');
const { indexExport, parseCsv } = await import('../src/utils/customerFieldsRestorePlan.js');
const { RESTORE_OUTCOME } = await import('../src/constants/index.js');

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--export') args.export = argv[++i];
    else if (arg === '--codes') args.codes = argv[++i];
    else if (arg === '--code') args.code = argv[++i];
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
if (args.help || !args.export || (!args.codes && !args.code)) {
  console.log(
    [
      'Usage:',
      '  node scripts/customer-fields-restore-cli.js --export FILE.csv (--codes FILE | --code CODE) [--limit N] [--apply] [--csv FILE]',
      '',
      'Without --apply nothing is written. DRY_RUN=true also blocks Unleashed writes.',
    ].join('\n'),
  );
  process.exit(args.help ? 0 : 1);
}

const exportByCode = indexExport(parseCsv(fs.readFileSync(path.resolve(args.export), 'utf8')));
const codes = args.code
  ? [args.code]
  : fs.readFileSync(path.resolve(args.codes), 'utf8').split(/\s+/).filter(Boolean);

const config = loadConfig();
const log = {
  info: (...parts) => console.log(...parts),
  warn: (...parts) => console.warn(...parts),
  error: (...parts) => console.error(...parts),
};
const unleashed = createUnleashedClient(config, log);

console.log(`export rows: ${exportByCode.size}  customers to restore: ${codes.length}  apply: ${args.apply}  dry run setting: ${config.dryRun}`);
const report = await restoreCustomers({ exportByCode, codes, limit: args.limit, apply: args.apply, unleashed, config, log });

for (const result of report.results) {
  const fields = Object.keys(result.changes ?? {});
  const kept = (result.kept ?? []).map((k) => k.field);
  console.log(
    `${result.customerCode.padEnd(10)} ${result.outcome.padEnd(14)}` +
      `${fields.length ? ` write ${fields.join(',')}` : ''}` +
      `${kept.length ? `  kept ${kept.join(',')}` : ''}` +
      `${(result.problems ?? []).length ? `  problems ${result.problems.join('; ')}` : ''}` +
      `${result.error ? `  — ${result.error}` : ''}`,
  );
}
console.log(`\n${report.scanned} customer(s); outcomes ${JSON.stringify(report.byOutcome)}${report.truncated ? ' (stopped at --limit)' : ''}`);
if (!args.apply) console.log('Nothing was written.');

const csvPath = args.csv ?? path.join(projectRoot, 'reports', `customer-fields-restore-${args.apply ? 'applied' : 'preview'}-${new Date().toISOString().slice(0, 10)}.csv`);
fs.mkdirSync(path.dirname(path.resolve(csvPath)), { recursive: true });
fs.writeFileSync(path.resolve(csvPath), `${buildRestoreCsv(report)}\n`);
console.log(`Wrote ${csvPath}`);
if (report.byOutcome[RESTORE_OUTCOME.FAILED]) process.exit(2);
