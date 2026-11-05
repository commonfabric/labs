/**
 * Polls `predicate` every `pollMs` until it holds, and throws naming `label`
 * once `timeoutMs` has elapsed. A thunk `label` is rendered only on failure,
 * and an asynchronous `predicate` is awaited once per poll.
 *
 * The deadline is a stuck-condition backstop, not a bound on how long the
 * awaited work may legitimately take, and a caller sizes it for that: crossing
 * it proves only that the predicate did not come true within the window — a
 * fixed bound cannot tell a stuck wait from one delayed past it; the width
 * just makes the stuck reading the likely one. Which suites wait this way
 * rather than on an event, and why, is recorded under "Where the polling
 * `waitFor` stays" in `docs/development/waiting-in-tests.md`.
 */
export const waitUntil = async (
  predicate: () => boolean | Promise<boolean>,
  label: string | (() => string),
  timeoutMs = 20_000,
  pollMs = 20,
): Promise<void> => {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let polls = 0;
  for (;;) {
    polls += 1;
    if (await predicate()) return;
    if (Date.now() > deadline) {
      const rendered = typeof label === "function" ? label() : label;
      // The poll count separates two failures that read alike. A predicate
      // polled at the full rate that never came true names a defect in what
      // it watches; one polled a handful of times over the same span says the
      // event loop was starved and the test barely looked.
      throw new Error(
        `timed out waiting for ${rendered} after ${Date.now() - started} ms ` +
          `and ${polls} polls`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
};
