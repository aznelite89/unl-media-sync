import { RESEND_API_BASE } from '../constants/index.js';
import { fetchWithRetry } from './http.js';

/**
 * Sends a report by email through Resend.
 *
 * Resend is already the store's transactional sender (searay-email-func uses it
 * for backorder notifications), so this reuses proven, domain-verified delivery
 * instead of standing up a second mail path.
 *
 * Delivery never throws. A reporting job that crashes because the mail server
 * was briefly unreachable would turn a cosmetic problem into a missing report,
 * and the summary has already reached Application Insights by this point.
 *
 * @param {{
 *   config: object,
 *   subject: string,
 *   text: string,
 *   html?: string,
 *   attachments?: Array<{ filename: string, content: string }>,
 *   log?: object,
 * }} input
 * @returns {Promise<{ delivered: boolean, reason?: string }>}
 */
export async function sendEmail({ config, subject, text, html, attachments = [], log = console }) {
  const { apiKey, from, to } = config.email ?? {};

  if (!apiKey) {
    return { delivered: false, reason: 'RESEND_API_KEY not set; logged only' };
  }
  if (!to?.length) {
    return { delivered: false, reason: 'EMAIL_TO is empty; logged only' };
  }

  const payload = { from, to, subject, text };
  if (html) payload.html = html;
  if (attachments.length) payload.attachments = attachments;

  try {
    const response = await fetchWithRetry(
      () =>
        fetch(`${RESEND_API_BASE}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        }),
      { label: 'resend send', log },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // Most likely causes: the from-address domain is not verified in Resend,
      // or the key was rotated. Both need a human, so name the status plainly.
      log.error?.(`email: Resend returned HTTP ${response.status} ${detail.slice(0, 300)}`);
      return { delivered: false, reason: `resend HTTP ${response.status}` };
    }

    return { delivered: true };
  } catch (error) {
    log.error?.(`email: could not reach Resend — ${error.message}`);
    return { delivered: false, reason: error.message };
  }
}

/**
 * Base64 for a Resend attachment.
 *
 * @param {string} contents
 */
export function toAttachment(filename, contents) {
  return { filename, content: Buffer.from(contents, 'utf8').toString('base64') };
}

/**
 * Escapes text for interpolation into the HTML bodies built in report.js.
 * Product descriptions are free text entered in Unleashed and land in the email
 * verbatim, so they get escaped rather than trusted.
 *
 * @param {unknown} value
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A CSV cell that survives commas, quotes and newlines in free-text fields.
 *
 * @param {unknown} value
 */
export function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
