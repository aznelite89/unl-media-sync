import {
  MS_PER_HOUR,
  OK_REPORT_WEEKDAY,
  REPORT_SKIP_REASON,
  REPORT_UTC_OFFSET_HOURS,
  SYNC_HEALTH,
} from '../constants/index.js';
import { sendEmail } from './email.js';

/**
 * Whether today is the weekly report day, judged in AEST rather than UTC — the
 * timer fires at 22:00 UTC, which is still Sunday in UTC when it is Monday
 * morning for the people reading it.
 *
 * @param {number} [nowMs]
 */
export function isWeeklyReportDay(nowMs = Date.now()) {
  const local = new Date(nowMs + REPORT_UTC_OFFSET_HOURS * MS_PER_HOUR);
  return local.getUTCDay() === OK_REPORT_WEEKDAY;
}

/**
 * Whether a daily verdict should be emailed today. WARN and ALERT always are;
 * OK only on the weekly report day.
 *
 * @param {string} health
 * @param {number} [nowMs]
 */
export function isDailyEmailDue(health, nowMs = Date.now()) {
  return health !== SYNC_HEALTH.OK || isWeeklyReportDay(nowMs);
}

/**
 * Delivers a report: always to the platform log, then by email.
 *
 * The log write comes first and unconditionally, so the summary survives even
 * when mail delivery is misconfigured or Resend is down. Without a
 * RESEND_API_KEY the report still reaches Application Insights — email is how
 * the report finds people, not the only place it exists.
 *
 * @param {{
 *   config: object,
 *   summary: { health: string, subject: string, text: string, html?: string },
 *   attachments?: Array<{ filename: string, content: string }>,
 *   emailDue?: boolean,
 *   log?: object,
 * }} input
 * @returns {Promise<{ delivered: boolean, reason?: string }>}
 */
export async function sendReport({
  config,
  summary,
  attachments = [],
  emailDue = true,
  log = console,
}) {
  const emit = summary.health === SYNC_HEALTH.OK ? log.info : log.warn;
  emit?.(`report [${summary.health}] ${summary.subject}\n${summary.text}`);

  if (!emailDue) return { delivered: false, reason: REPORT_SKIP_REASON.OK_NOT_DUE };

  return sendEmail({
    config,
    subject: summary.subject,
    text: summary.text,
    html: summary.html,
    attachments,
    log,
  });
}
