import { SYNC_HEALTH } from '../constants/index.js';
import { sendEmail } from './email.js';

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
 *   log?: object,
 * }} input
 * @returns {Promise<{ delivered: boolean, reason?: string }>}
 */
export async function sendReport({ config, summary, attachments = [], log = console }) {
  const emit = summary.health === SYNC_HEALTH.OK ? log.info : log.warn;
  emit?.(`report [${summary.health}] ${summary.subject}\n${summary.text}`);

  return sendEmail({
    config,
    subject: summary.subject,
    text: summary.text,
    html: summary.html,
    attachments,
    log,
  });
}
