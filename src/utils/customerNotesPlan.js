/**
 * The decisions behind the customer notes guard, with no network access.
 *
 * The snapshot holds, per customer Guid, the last text seen in that customer's
 * Unleashed Notes. It never forgets text: an edit keeps the text it replaced,
 * and a blanking keeps the text that was blanked. That makes it the customer
 * notes backup as well as the guard's memory.
 */

import {
  NOTES_OUTCOME,
  NOTES_SNAPSHOT_VERSION,
  NOTES_WINDOW_SLACK_MINUTES,
} from '../constants/index.js';

export const NOTES_ACTION = {
  /** Nothing new. */
  NONE: 'none',
  /** Text appeared, or came back to what the snapshot holds after a clear: record it. */
  RECORD: 'record',
  /** Text changed to different text: record it, and say if a web order came with it. */
  REPLACE: 'replace',
  /** Text went blank: a web order in the window means the connector did it. */
  WIPED: 'wiped',
};

export function hasText(notes) {
  return String(notes ?? '').trim().length > 0;
}

/** Equal text, ignoring line-ending style and surrounding whitespace. */
export function sameNotes(a, b) {
  const normal = (value) => String(value ?? '').replace(/\r\n/g, '\n').trim();
  return normal(a) === normal(b);
}

/** Unleashed dates come as `/Date(1790058009129)/`; ISO strings are accepted too. */
export function parseUnleashedDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = /\/Date\((-?\d+)/.exec(String(value));
  if (match) return Number(match[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Unleashed's `modifiedSince` takes UTC without milliseconds or zone. */
export function toUnleashedSince(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
}

export function emptySnapshot() {
  return { version: NOTES_SNAPSHOT_VERSION, takenAt: null, customers: {}, pending: {} };
}

/**
 * A snapshot that cannot be read is an error, never "no snapshot": treating it
 * as missing would start a fresh baseline and overwrite the only copy of every
 * customer's notes.
 *
 * @param {string} text
 */
export function parseSnapshot(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.customers !== 'object') {
    throw new Error('customer notes snapshot is not in the expected shape');
  }
  return {
    version: parsed.version ?? NOTES_SNAPSHOT_VERSION,
    takenAt: parsed.takenAt ?? null,
    customers: parsed.customers ?? {},
    pending: parsed.pending ?? {},
  };
}

/**
 * Start of the window a run looks at: the previous whole run, less the slack.
 * Null when there has been no whole run yet.
 */
export function windowStartMs(snapshot) {
  const takenMs = parseUnleashedDate(snapshot?.takenAt);
  if (takenMs === null) return null;
  return takenMs - NOTES_WINDOW_SLACK_MINUTES * 60_000;
}

/**
 * @param {{ Notes?: string }} customer
 * @param {{ notes: string, clearedAt?: string } | undefined} entry
 */
export function planNotes(customer, entry) {
  const current = customer?.Notes ?? '';
  if (!entry) return hasText(current) ? NOTES_ACTION.RECORD : NOTES_ACTION.NONE;

  if (hasText(current)) {
    if (!sameNotes(current, entry.notes)) return NOTES_ACTION.REPLACE;
    return entry.clearedAt ? NOTES_ACTION.RECORD : NOTES_ACTION.NONE;
  }
  return entry.clearedAt ? NOTES_ACTION.NONE : NOTES_ACTION.WIPED;
}

/** The entry after this run has seen `customer.Notes` as the customer's own text. */
export function recordedEntry(customer, previousEntry, nowIso) {
  const notes = customer.Notes;
  const replaced =
    previousEntry && !sameNotes(previousEntry.notes, notes) ? previousEntry.notes : previousEntry?.previous;
  const entry = { code: customer.CustomerCode, notes, seenAt: nowIso };
  if (replaced !== undefined) entry.previous = replaced;
  return entry;
}

/** A person blanked the notes: keep the text, stop guarding until new text appears. */
export function clearedEntry(entry, customer, nowIso) {
  return { ...entry, code: customer.CustomerCode, clearedAt: nowIso };
}

/** Web orders created at or after `sinceMs`. */
export function ordersCreatedSince(orders, sinceMs) {
  return (orders ?? []).filter((order) => {
    const created = parseUnleashedDate(order?.CreatedOn);
    return created !== null && created >= sinceMs;
  });
}

/** Outcomes that leave a customer to be looked at again on the next run. */
export const NOTES_RETRY_OUTCOMES = new Set([NOTES_OUTCOME.FAILED, NOTES_OUTCOME.DRY_RUN]);

/** Rows for a CSV of what was, or would be, done. */
export function buildNotesCsv(report) {
  const lines = ['customer_code,outcome,web_orders,snapshot_notes,error'];
  for (const result of report.results) {
    const cells = [
      result.customerCode,
      result.outcome,
      (result.orders ?? []).join(' '),
      result.entry?.notes ?? '',
      result.error ?? '',
    ];
    lines.push(cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','));
  }
  return lines.join('\n');
}
