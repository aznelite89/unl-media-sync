/**
 * Adapts an Azure Functions `InvocationContext` to the `{ info, warn, error }`
 * shape the sync modules log through, so those modules stay usable from plain
 * Node scripts too.
 *
 * @param {object} context
 */
export function toLog(context) {
  if (!context) return console;
  const info = (...args) => context.log?.(...args);
  return {
    info,
    log: info,
    warn: (...args) => (context.warn ? context.warn(...args) : info(...args)),
    error: (...args) => (context.error ? context.error(...args) : info(...args)),
  };
}

/**
 * Counts sync results by outcome for a one-line run summary.
 *
 * @param {Array<{ outcome: string }>} results
 */
export function summarise(results) {
  const byOutcome = {};
  for (const result of results) {
    byOutcome[result.outcome] = (byOutcome[result.outcome] ?? 0) + 1;
  }
  return byOutcome;
}
