import { SYNC_HEALTH } from '../constants/index.js';
import { fetchWithRetry } from './http.js';

/**
 * Delivers the daily summary.
 *
 * Slack is optional on purpose: without a webhook URL the summary still reaches
 * Application Insights via the log, so the report is never the reason a
 * deployment fails. A delivery failure is logged and swallowed for the same
 * reason — the sync itself must not break because a notification did.
 *
 * @param {{ config: object, summary: { health: string, text: string }, extra?: string|null, log?: object }} input
 * @returns {Promise<{ delivered: boolean, reason?: string }>}
 */
export async function sendDailySummary({ config, summary, extra = null, log = console }) {
  const body = extra ? `${summary.text}\n\n${extra}` : summary.text;

  // Always emit to the platform log, whatever else happens.
  const emit = summary.health === SYNC_HEALTH.OK ? log.info : log.warn;
  emit?.(`daily report [${summary.health}]\n${body}`);

  const url = config.slackWebhookUrl;
  if (!url) {
    return { delivered: false, reason: 'SLACK_WEBHOOK_URL not set; logged only' };
  }

  try {
    const response = await fetchWithRetry(
      () =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: body, mrkdwn: true }),
        }),
      { label: 'slack webhook', log },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log.error?.(`daily report: Slack returned HTTP ${response.status} ${detail.slice(0, 200)}`);
      return { delivered: false, reason: `slack HTTP ${response.status}` };
    }
    return { delivered: true };
  } catch (error) {
    log.error?.(`daily report: could not reach Slack — ${error.message}`);
    return { delivered: false, reason: error.message };
  }
}
