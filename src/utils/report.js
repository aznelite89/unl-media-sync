import { SYNC_HEALTH, SYNC_OUTCOME } from '../constants/index.js';

/**
 * Turns a dry-run reconcile report into a health verdict and a human summary.
 *
 * The daily pass re-checks recent Unleashed changes WITHOUT writing. The live
 * webhook and timer should already have handled them, so:
 *
 *   pending  — products the live sync should have done and did not. This is the
 *              silent-failure signal the whole report exists to catch.
 *   failed   — errors during the check itself; always an alert.
 *   unmatched/capped — data and policy facts, reported but never alerts, or the
 *              alert would fire every day and be ignored within a week.
 *
 * Pure and synchronous so the alert decision is unit-testable.
 *
 * @param {{ report: object, pendingWarnThreshold: number, lookbackHours: number }} input
 */
export function buildDailySummary({ report, pendingWarnThreshold, lookbackHours }) {
  const byOutcome = report?.byOutcome ?? {};
  const pending = byOutcome[SYNC_OUTCOME.DRY_RUN] ?? 0;
  const failed = byOutcome[SYNC_OUTCOME.FAILED] ?? 0;
  const unmatched = byOutcome[SYNC_OUTCOME.UNMATCHED] ?? 0;
  const ambiguous = byOutcome[SYNC_OUTCOME.AMBIGUOUS] ?? 0;
  const capped = byOutcome[SYNC_OUTCOME.CAPPED] ?? 0;
  const settled = byOutcome[SYNC_OUTCOME.UNCHANGED] ?? 0;

  let health = SYNC_HEALTH.OK;
  const reasons = [];

  if (failed > 0) {
    health = SYNC_HEALTH.ALERT;
    reasons.push(`${failed} product(s) errored during the check`);
  }
  if (pending > pendingWarnThreshold) {
    // Escalate rather than downgrade an existing alert.
    health = failed > 0 ? SYNC_HEALTH.ALERT : SYNC_HEALTH.WARN;
    reasons.push(
      `${pending} product(s) still need syncing — the live sync may be failing or behind`,
    );
  } else if (pending > 0) {
    reasons.push(`${pending} product(s) pending, within the tolerance of ${pendingWarnThreshold}`);
  }

  const icon = { ok: ':white_check_mark:', warn: ':warning:', alert: ':rotating_light:' }[health];
  const headline = {
    ok: 'Image sync healthy',
    warn: 'Image sync falling behind',
    alert: 'Image sync needs attention',
  }[health];

  const lines = [
    `${icon} *${headline}* — last ${lookbackHours}h`,
    '',
    `• checked: *${report?.scanned ?? 0}* products (*${report?.withImages ?? 0}* with images)`,
    `• already correct: *${settled}*`,
    `• pending: *${pending}*`,
    `• failed: *${failed}*`,
    `• unmatched SKUs: *${unmatched}*${ambiguous ? ` (+${ambiguous} ambiguous)` : ''}`,
    `• declined by the ${''}image cap: *${capped}*`,
  ];

  if (reasons.length) {
    lines.push('', ...reasons.map((reason) => `> ${reason}`));
  }
  if (report?.truncated) {
    lines.push('', '> the check stopped early at its page cap; counts are a lower bound');
  }

  return {
    health,
    reasons,
    counts: { scanned: report?.scanned ?? 0, settled, pending, failed, unmatched, ambiguous, capped },
    text: lines.join('\n'),
  };
}

/**
 * The worst offenders, so a WARN or ALERT names actual products instead of
 * making someone go digging through logs.
 *
 * @param {object} report
 * @param {number} [max]
 */
export function summariseProblems(report, max = 8) {
  const interesting = (report?.details ?? []).filter((detail) =>
    [SYNC_OUTCOME.FAILED, SYNC_OUTCOME.DRY_RUN, SYNC_OUTCOME.AMBIGUOUS].includes(detail.outcome),
  );
  if (interesting.length === 0) return null;

  const lines = interesting
    .slice(0, max)
    .map((detail) => `• \`${detail.productCode}\` — ${detail.outcome}${
      detail.notes?.length ? `: ${detail.notes[0].slice(0, 90)}` : ''
    }`);

  if (interesting.length > max) {
    lines.push(`• …and ${interesting.length - max} more`);
  }
  return lines.join('\n');
}
