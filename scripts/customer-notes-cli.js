#!/usr/bin/env node
/**
 * The customer notes guard by hand. Read-only unless --apply is given.
 *
 *   node scripts/customer-notes-cli.js --report                   # what the next timer run would do
 *   node scripts/customer-notes-cli.js --run --apply              # one whole pass, exactly as the timer (first one is the baseline)
 *   node scripts/customer-notes-cli.js --code MB712 [--apply]     # one customer
 *   node scripts/customer-notes-cli.js --restore MB712 [--apply]  # put the snapshot text back regardless of web orders
 *   node scripts/customer-notes-cli.js --export reports/notes.json
 *   node scripts/customer-notes-cli.js --report --csv reports/notes.csv
 *
 * The snapshot lives in the Function App's storage account. Point at it with
 *   export NOTES_STORAGE_CONNECTION="$(az storage account show-connection-string \
 *     -g searay-func-rg -n searayunleashedsync -o tsv)"
 *
 * Unleashed credentials come from the environment, or local.settings.json.
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
const { createBlobNotesStore } = await import('../src/utils/customerNotesStore.js');
const { buildNotesCsv, forceRestore, guardNotes } = await import('../src/utils/customerNotes.js');
const { NOTES_OUTCOME } = await import('../src/constants/index.js');

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--report') args.report = true;
    else if (arg === '--run') args.run = true;
    else if (arg === '--code') args.code = argv[++i];
    else if (arg === '--restore') args.restore = argv[++i];
    else if (arg === '--export') args.export = argv[++i];
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
const modes = ['report', 'run', 'code', 'restore', 'export'].filter((mode) => args[mode]);
if (args.help || modes.length !== 1) {
  console.log(
    [
      'Usage (exactly one of):',
      '  node scripts/customer-notes-cli.js --report [--csv FILE]',
      '  node scripts/customer-notes-cli.js --run [--apply] [--csv FILE]',
      '  node scripts/customer-notes-cli.js --code <CUSTOMER_CODE> [--apply]',
      '  node scripts/customer-notes-cli.js --restore <CUSTOMER_CODE> [--apply]',
      '  node scripts/customer-notes-cli.js --export FILE',
      '',
      'Without --apply nothing is written, to Unleashed or to the snapshot. DRY_RUN=true also blocks Unleashed writes.',
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
const store = createBlobNotesStore(config.notesStorageConnection);

if (args.export) {
  const { snapshot } = await store.load();
  if (!snapshot) {
    console.error('There is no notes snapshot yet.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(args.export)), { recursive: true });
  fs.writeFileSync(path.resolve(args.export), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(snapshot.customers).length} customers' notes, taken ${snapshot.takenAt}, to ${args.export}`);
  process.exit(0);
}

if (args.restore) {
  const result = await forceRestore({ customerCode: args.restore, unleashed, store, config, log, apply: args.apply });
  console.log(`${result.customerCode}  ${result.outcome}${result.error ? `  — ${result.error}` : ''}`);
  console.log(`snapshot text: ${JSON.stringify(result.entry?.notes ?? '')}`);
  if (result.outcome === NOTES_OUTCOME.DRY_RUN) {
    console.log(`currently:     ${JSON.stringify(result.current ?? '')}\nNothing was changed. Re-run with --apply.`);
  }
  process.exit(result.outcome === NOTES_OUTCOME.FAILED ? 2 : 0);
}

console.log(`apply: ${args.apply}  dry run setting: ${config.dryRun}`);
const report = await guardNotes({
  unleashed,
  store,
  config,
  log,
  apply: args.apply,
  persist: args.apply,
  customerCode: args.code,
});

if (!report.baseline) {
  for (const result of report.results) {
    const orders = result.orders?.length ? `  web orders ${result.orders.join(', ')}` : '';
    console.log(
      `${result.customerCode.padEnd(16)} ${result.outcome.padEnd(24)}${orders}${result.error ? `  — ${result.error}` : ''}`,
    );
  }
}
console.log(
  `\n${report.baseline ? 'BASELINE. ' : ''}scanned ${report.scanned} customer(s) since ${report.windowStart ?? 'the beginning'}; ` +
    `outcomes ${JSON.stringify(report.byOutcome)}; snapshot tracks ${report.tracked}, pending ${report.pending}`,
);
if (!args.apply) console.log('Nothing was written: not to Unleashed, not to the snapshot.');

if (args.csv) {
  fs.mkdirSync(path.dirname(path.resolve(args.csv)), { recursive: true });
  fs.writeFileSync(path.resolve(args.csv), `${buildNotesCsv(report)}\n`);
  console.log(`Wrote ${args.csv}`);
}
if (report.byOutcome[NOTES_OUTCOME.FAILED]) process.exit(2);
