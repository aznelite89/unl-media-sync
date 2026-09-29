/**
 * Runs async tasks with at most `concurrency` in flight.
 *
 * `ready()` before each `run()` is what applies the cap. At a concurrency of 1
 * that waits for the previous task to finish, so a caller written against the
 * pool behaves exactly like the sequential loop it replaced.
 *
 * @param {number} concurrency
 */
export function createPool(concurrency) {
  const limit = Math.max(1, concurrency);
  const inFlight = new Set();

  return {
    get size() {
      return inFlight.size;
    },
    /** Resolves once a slot is free. */
    async ready() {
      while (inFlight.size >= limit) await Promise.race(inFlight);
    },
    /** @param {() => Promise<unknown>} task */
    run(task) {
      const running = Promise.resolve()
        .then(task)
        .finally(() => inFlight.delete(running));
      inFlight.add(running);
    },
    /** Resolves once every task started so far has finished. */
    async drain() {
      await Promise.all(inFlight);
    },
  };
}
