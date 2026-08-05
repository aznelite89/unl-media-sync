import {
  AUDIT_INLINE_LIMIT,
  DAILY_INLINE_LIMIT,
  DAILY_REPORTED_OUTCOMES,
  DUPLICATE_KIND,
  EMAIL_SUBJECT_TAG,
  OUTCOME_LABEL,
  REPORT_NOTE_MAX_CHARS,
  SYNC_HEALTH,
  SYNC_OUTCOME,
} from '../constants/index.js';
import { csvCell, escapeHtml } from './email.js';

/**
 * Turns a dry-run reconcile report into a health verdict and an email.
 *
 * The daily pass re-checks recent Unleashed changes WITHOUT writing. The live
 * webhook and timer should already have handled them, so:
 *
 *   pending  — products the live sync should have done and did not. This is the
 *              silent-failure signal the whole report exists to catch.
 *   failed   — errors during the check itself; always an alert.
 *   no activity — nothing changed in Unleashed at all. Ordinary on a quiet day,
 *              so it only alerts once a wider window is also empty (see
 *              `activity` below).
 *   unmatched/capped — data and policy facts, reported but never alerts, or the
 *              alert would fire every day and be ignored within a week.
 *
 * Pure and synchronous so the alert decision is unit-testable.
 *
 * @param {{
 *   report: object,
 *   pendingWarnThreshold: number,
 *   lookbackHours: number,
 *   activity?: { probeDays: number, probeCount: number } | null,
 * }} input
 */
export function buildDailySummary({ report, pendingWarnThreshold, lookbackHours, activity = null }) {
  const byOutcome = report?.byOutcome ?? {};
  const scanned = report?.scanned ?? 0;
  const pending = byOutcome[SYNC_OUTCOME.DRY_RUN] ?? 0;
  const failed = byOutcome[SYNC_OUTCOME.FAILED] ?? 0;
  const unmatched = byOutcome[SYNC_OUTCOME.UNMATCHED] ?? 0;
  const ambiguous = byOutcome[SYNC_OUTCOME.AMBIGUOUS] ?? 0;
  const capped = byOutcome[SYNC_OUTCOME.CAPPED] ?? 0;
  const settled = byOutcome[SYNC_OUTCOME.UNCHANGED] ?? 0;

  let health = SYNC_HEALTH.OK;
  let headline = 'nothing outstanding';
  const reasons = [];

  if (failed > 0) {
    health = SYNC_HEALTH.ALERT;
    headline = `${failed} product(s) errored`;
    reasons.push(`${failed} product(s) errored during the check.`);
  }

  if (pending > pendingWarnThreshold) {
    // Escalate rather than downgrade an existing alert.
    health = failed > 0 ? SYNC_HEALTH.ALERT : SYNC_HEALTH.WARN;
    if (failed === 0) headline = `${pending} product(s) still pending`;
    reasons.push(
      `${pending} product(s) still need syncing — the live sync may be failing or behind.`,
    );
  } else if (pending > 0) {
    reasons.push(
      `${pending} product(s) pending, within the tolerance of ${pendingWarnThreshold}.`,
    );
  }

  // Nothing changed in Unleashed at all. Only a fault if a much wider window is
  // empty too — see ZERO_ACTIVITY_PROBE_DAYS for why a quiet day is not news.
  if (scanned === 0) {
    if (activity && activity.probeCount === 0) {
      health = SYNC_HEALTH.ALERT;
      headline = `no Unleashed activity in ${activity.probeDays} days`;
      reasons.push(
        `No Unleashed product has changed in ${activity.probeDays} days. A catalogue this ` +
          'size does not go that long untouched, so the sync has most likely stopped ' +
          'seeing Unleashed — check the API credentials and that the product feed is live.',
      );
    } else if (activity) {
      reasons.push(
        `No Unleashed changes in the last ${lookbackHours}h. Normal for a quiet day: ` +
          `${activity.probeCount} product(s) changed in the last ${activity.probeDays} days, ` +
          'so Unleashed is reachable and the sync is watching it.',
      );
    } else {
      reasons.push(`No Unleashed changes in the last ${lookbackHours}h.`);
    }
  }

  const rows = [
    ['Checked', `${scanned} product(s), ${report?.withImages ?? 0} with images`],
    ['Already correct', settled],
    ['Pending', pending],
    ['Failed', failed],
    ['Unmatched SKUs', ambiguous ? `${unmatched} (+${ambiguous} ambiguous)` : unmatched],
    ['Declined by the image cap', capped],
  ];

  if (report?.truncated) {
    reasons.push('The check stopped early at its page cap, so these counts are a lower bound.');
  }

  const title = `Image sync — last ${lookbackHours}h`;
  const problems = collectProblems(report);

  return {
    health,
    reasons,
    counts: { scanned, settled, pending, failed, unmatched, ambiguous, capped },
    subject: `[${EMAIL_SUBJECT_TAG[health]}] Image sync — ${headline}`,
    text: buildText({ title, rows, reasons, problems, problemHeading: DAILY_PROBLEM_HEADING }),
    html: buildHtml({
      title,
      health,
      rows,
      reasons,
      problems,
      problemHeading: DAILY_PROBLEM_HEADING,
    }),
  };
}

/**
 * Every product behind the summary counts, worst outcome first.
 *
 * @param {object} report
 * @returns {object[]} raw sync results, not display rows
 */
export function orderedProblemDetails(report) {
  const details = report?.details ?? [];
  return DAILY_REPORTED_OUTCOMES.flatMap((outcome) =>
    details.filter((detail) => detail.outcome === outcome),
  );
}

/**
 * Names the products behind the counts, so the report answers "which SKUs?"
 * without anyone opening Application Insights.
 *
 * Listed on a healthy report too. An OK verdict routinely carries a handful of
 * pending, unmatched and capped products — those are exactly the rows people ask
 * about, and suppressing them was why the question kept coming back.
 *
 * @param {object} report
 * @param {number} [max]
 */
export function collectProblems(report, max = DAILY_INLINE_LIMIT) {
  const interesting = orderedProblemDetails(report);

  const rows = interesting.slice(0, max).map((detail) => ({
    productCode: detail.productCode || '(unknown)',
    outcome: OUTCOME_LABEL[detail.outcome] ?? detail.outcome,
    note: describeDetail(detail),
  }));

  if (interesting.length > max) {
    rows.push({
      productCode: `…and ${interesting.length - max} more in the attached CSV`,
      outcome: '',
      note: '',
    });
  }
  return rows;
}

/**
 * What a row says about a product: how many images are at stake, what it is, and
 * what the sync concluded. All the notes, not just the first — a capped product
 * carries its "Unleashed holds 7 images" note ahead of the cap note itself.
 *
 * @param {object} detail
 */
function describeDetail(detail) {
  const parts = [];
  if (detail.imageCount) parts.push(`${detail.imageCount} image(s)`);
  if (detail.description) parts.push(detail.description);
  if (detail.notes?.length) parts.push(detail.notes.join('; '));
  return truncate(parts.join(' — '));
}

/**
 * Cuts at a word boundary and says so. The email is the summary; the attached
 * CSV carries the same text untruncated, so nothing is lost by stopping here.
 *
 * @param {string} text
 * @param {number} [max]
 */
function truncate(text, max = REPORT_NOTE_MAX_CHARS) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The same list as a CSV, so a long day is worked through in a spreadsheet
 * rather than read off a truncated table.
 *
 * @param {object} report
 */
export function buildDailyCsv(report) {
  const lines = ['product_code,outcome,images,shopify_product_id,detail'];
  for (const detail of orderedProblemDetails(report)) {
    lines.push(
      [
        csvCell(detail.productCode),
        csvCell(OUTCOME_LABEL[detail.outcome] ?? detail.outcome),
        csvCell(detail.imageCount ?? ''),
        csvCell(detail.shopifyProductId ?? ''),
        csvCell([detail.description, ...(detail.notes ?? [])].filter(Boolean).join(' — ')),
      ].join(','),
    );
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Weekly catalogue audit                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turns a whole-catalogue audit into the weekly email.
 *
 * Unlike the daily report this is a worklist, not an incident: the count only
 * falls when someone fixes data in Unleashed or Shopify. It is deliberately
 * weekly and deliberately carries the count in the subject line, so progress
 * (or the lack of it) is visible without opening anything.
 *
 * @param {{ audit: object }} input
 */
export function buildAuditSummary({ audit }) {
  const unmatched = audit?.unmatched ?? [];
  const duplicates = audit?.duplicates ?? [];

  const health = unmatched.length > 0 || duplicates.length > 0 ? SYNC_HEALTH.WARN : SYNC_HEALTH.OK;
  const headline =
    unmatched.length > 0
      ? `${unmatched.length} product(s) with photos that cannot reach the site`
      : 'every product with photos is matched';

  const withSuggestion = unmatched.filter((row) => row.suggestion).length;

  const rows = [
    ['Unleashed products scanned', audit?.scanned ?? 0],
    ['…of those, holding images', audit?.withImages ?? 0],
    ['Matched to a Shopify SKU', audit?.matched ?? 0],
    ['Unmatched (images stranded)', unmatched.length],
    ['…with a likely SKU typo', withSuggestion],
    ['Shopify SKUs on 2+ products', duplicates.length],
    ['Shopify variant SKUs read', audit?.skuCount ?? 0],
  ];

  const reasons = [];
  if (unmatched.length > 0) {
    reasons.push(
      `${unmatched.length} Unleashed product(s) hold images but no Shopify variant carries ` +
        'their product code as a SKU, so those photos can never appear on the website.',
    );
  }
  if (withSuggestion > 0) {
    reasons.push(
      `${withSuggestion} of them look like SKU mismatches rather than missing products — a ` +
        'near-identical Shopify SKU exists. Those are the quickest wins; see the Suggestion column.',
    );
  }
  if (duplicates.length > 0) {
    reasons.push(
      `${duplicates.length} SKU(s) appear on more than one Shopify product. The sync refuses ` +
        'to guess which one owns the images and skips them entirely.',
    );
  }
  if (audit?.truncated) {
    reasons.push('The scan stopped at its page cap, so these counts are a lower bound.');
  }
  if (unmatched.length === 0 && duplicates.length === 0) {
    reasons.push('Nothing to action — every Unleashed product with images resolves to a Shopify product.');
  }

  const inline = unmatched.slice(0, AUDIT_INLINE_LIMIT).map((row) => ({
    productCode: row.productCode,
    outcome: row.suggestion ? `did you mean ${row.suggestion}?` : 'not in Shopify',
    note: truncate(`${row.imageCount} image(s) — ${row.description}`),
  }));
  if (unmatched.length > inline.length) {
    inline.push({
      productCode: `…and ${unmatched.length - inline.length} more in the attached CSV`,
      outcome: '',
      note: '',
    });
  }

  const title = 'Image sync — weekly catalogue audit';

  return {
    health,
    reasons,
    counts: {
      scanned: audit?.scanned ?? 0,
      withImages: audit?.withImages ?? 0,
      matched: audit?.matched ?? 0,
      unmatched: unmatched.length,
      withSuggestion,
      duplicates: duplicates.length,
    },
    subject: `[${EMAIL_SUBJECT_TAG[health]}] Image sync weekly audit — ${headline}`,
    text: buildText({ title, rows, reasons, problems: inline }),
    html: buildHtml({ title, health, rows, reasons, problems: inline }),
  };
}

/**
 * The full unmatched list as CSV, so it can be worked through in a spreadsheet
 * rather than retyped out of an email.
 *
 * @param {object} audit
 */
export function buildAuditCsv(audit) {
  const lines = ['product_code,images,likely_shopify_sku,description'];
  for (const row of audit?.unmatched ?? []) {
    lines.push(
      [
        csvCell(row.productCode),
        csvCell(row.imageCount),
        csvCell(row.suggestion),
        csvCell(row.description),
      ].join(','),
    );
  }
  return lines.join('\n');
}

/**
 * One row per duplicated copy, so the whole picture is reviewable in a
 * spreadsheet before anything is detached.
 *
 * @param {object} audit Result of `auditDuplicates`.
 */
export function buildDuplicateCsv(audit) {
  const lines = [
    'kind,shopify_product_id,title,media_id,file_name,dimensions,bytes,owner_product_code,origin,action',
  ];
  for (const product of audit?.products ?? []) {
    const removing = new Set((product.removals ?? []).map((removal) => removal.mediaId));
    for (const group of product.groups ?? []) {
      for (const copy of group.copies) {
        lines.push(
          [
            csvCell(group.kind),
            csvCell(product.productId),
            csvCell(product.title),
            csvCell(copy.mediaId),
            csvCell(copy.filename),
            csvCell(copy.dimensions),
            csvCell(copy.bytes),
            csvCell(copy.productCode ?? ''),
            csvCell(copy.origin ?? 'added by hand in Shopify'),
            csvCell(removing.has(copy.mediaId) ? 'detach' : 'keep'),
          ].join(','),
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Plain-text summary of a duplicate scan for the CLI.
 *
 * @param {{ audit: object, applied?: boolean }} input
 */
export function buildDuplicateSummary({ audit, applied = false }) {
  const byKind = audit?.byKind ?? {};
  const title = 'Image sync — duplicate media scan';
  const rows = [
    ['Products scanned', String(audit?.scanned ?? 0)],
    ['Products with duplicates', String((audit?.products ?? []).length)],
    ['Duplicated pictures', String(Object.values(byKind).reduce((sum, n) => sum + n, 0))],
    ['Wasted image slots', String(audit?.wastedSlots ?? 0)],
    ['Safe to repair', String(audit?.repairable ?? 0)],
  ];
  if (applied) rows.push(['Detached', String(audit?.detached ?? 0)]);

  const reasons = [];
  if (byKind[DUPLICATE_KIND.MIXED] > 0) {
    reasons.push(
      `${byKind[DUPLICATE_KIND.MIXED]} picture(s) exist as one hand-uploaded copy plus one this ` +
        'sync added — the copy the sync added can be detached, and the next run re-adopts the other.',
    );
  }
  if (byKind[DUPLICATE_KIND.ALL_UNMANAGED] > 0) {
    reasons.push(
      `${byKind[DUPLICATE_KIND.ALL_UNMANAGED]} picture(s) were uploaded by hand more than once. ` +
        'This sync did not create them and will not remove them — tidy these in Shopify.',
    );
  }
  if (byKind[DUPLICATE_KIND.ALL_MANAGED] > 0) {
    reasons.push(
      `${byKind[DUPLICATE_KIND.ALL_MANAGED]} picture(s) are held more than once by sibling ` +
        'Unleashed product codes sharing one Shopify product — variants photographed once. One ' +
        'copy is kept and the rest detached; those codes re-adopt the survivor on their next run.',
    );
  }
  if (audit?.blocked) reasons.push(audit.blocked);
  if (audit?.failures?.length) {
    reasons.push(`${audit.failures.length} product(s) failed to update; see the log.`);
  }
  if (reasons.length === 0) reasons.push('No duplicated media found.');

  const problems = (audit?.products ?? []).slice(0, AUDIT_INLINE_LIMIT).map((product) => ({
    productCode: product.productId.split('/').pop(),
    outcome: `${product.groups.length} duplicate picture(s)`,
    note: truncate(`${product.title} — ${product.removals.length} detachable`),
  }));

  return {
    counts: {
      scanned: audit?.scanned ?? 0,
      affected: (audit?.products ?? []).length,
      wastedSlots: audit?.wastedSlots ?? 0,
      repairable: audit?.repairable ?? 0,
      detached: audit?.detached ?? 0,
    },
    text: buildText({ title, rows, reasons, problems, problemHeading: 'Affected products' }),
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function buildText({ title, rows, reasons, problems, problemHeading = DEFAULT_PROBLEM_HEADING }) {
  const lines = [title, '='.repeat(title.length), ''];
  for (const [label, value] of rows) lines.push(`  ${label.padEnd(28)} ${value}`);

  if (reasons.length) {
    lines.push('', 'Notes', '-----');
    for (const reason of reasons) lines.push(`  * ${reason}`);
  }

  if (problems.length) {
    lines.push('', problemHeading, '-'.repeat(problemHeading.length));
    for (const row of problems) {
      lines.push(`  ${row.productCode}  ${row.outcome}${row.note ? `  — ${row.note}` : ''}`);
    }
  }

  lines.push('', 'Sent by unleashed-media-sync (Azure: searay-unleashed-sync).');
  return lines.join('\n');
}

const HEALTH_COLOUR = { ok: '#1a7f37', warn: '#9a6700', alert: '#b42318' };

const DEFAULT_PROBLEM_HEADING = 'Products needing attention';

/** Not "needing attention": a healthy daily report lists capped and unmatched rows too. */
const DAILY_PROBLEM_HEADING = 'Products behind these counts';

/**
 * Deliberately plain, table-based HTML with inline styles — that is what
 * survives Outlook, which is where these land.
 */
function buildHtml({
  title,
  health,
  rows,
  reasons,
  problems,
  problemHeading = DEFAULT_PROBLEM_HEADING,
}) {
  const colour = HEALTH_COLOUR[health] ?? HEALTH_COLOUR.ok;

  const summaryRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#555;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;font-weight:600;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const reasonList = reasons.length
    ? `<ul style="margin:18px 0;padding-left:20px;color:#333;line-height:1.55;">${reasons
        .map((reason) => `<li style="margin-bottom:6px;">${escapeHtml(reason)}</li>`)
        .join('')}</ul>`
    : '';

  const problemTable = problems.length
    ? `<h3 style="margin:24px 0 8px;font-size:15px;">${escapeHtml(problemHeading)}</h3>
       <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;">
         <tr style="text-align:left;border-bottom:1px solid #ddd;">
           <th style="padding:6px 12px 6px 0;">Product code</th>
           <th style="padding:6px 12px 6px 0;">Outcome</th>
           <th style="padding:6px 0;">Detail</th>
         </tr>
         ${problems
           .map(
             (row) =>
               `<tr style="border-bottom:1px solid #f0f0f0;">
                  <td style="padding:6px 12px 6px 0;font-family:monospace;">${escapeHtml(row.productCode)}</td>
                  <td style="padding:6px 12px 6px 0;">${escapeHtml(row.outcome)}</td>
                  <td style="padding:6px 0;color:#555;">${escapeHtml(row.note)}</td>
                </tr>`,
           )
           .join('')}
       </table>`
    : '';

  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#111;max-width:720px;">
  <h2 style="margin:0 0 4px;font-size:18px;">${escapeHtml(title)}</h2>
  <p style="margin:0 0 18px;color:${colour};font-weight:700;text-transform:uppercase;letter-spacing:.04em;font-size:12px;">${escapeHtml(health)}</p>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">${summaryRows}</table>
  ${reasonList}
  ${problemTable}
  <p style="margin-top:28px;color:#888;font-size:12px;">Sent by unleashed-media-sync (Azure: searay-unleashed-sync).</p>
</div>`;
}

export { buildText, buildHtml };
