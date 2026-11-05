/**
 * Multi-user: both participants set expectNonIdempotent: true, but only
 * alice's pattern is actually non-idempotent. Which runtime re-runs the
 * offending computation depends on scheduling, so ONE flagged participant
 * seeing a violation satisfies the expectation — the run must PASS even
 * though bob (also flagged) saw none.
 */

import {
  assert,
  computed,
  multiUserTest,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";

export const alice = pattern(() => {
  const value = new Writable("alice");
  const log = new Writable<string[]>([]);

  // Non-idempotent: appends to log on every re-execution
  computed(() => {
    const current = log.get();
    log.set([...current, `${value.get()} at run #${current.length + 1}`]);
  });

  const hasEntries = assert(() => log.get().length > 0);
  return {
    [TESTS]: [{ assertion: hasEntries }],
    expectNonIdempotent: true,
  };
});

export const bob = pattern(() => {
  const value = new Writable("bob");
  const ok = assert(() => value.get() === "bob");
  return {
    [TESTS]: [{ assertion: ok }],
    expectNonIdempotent: true,
  };
});

export default multiUserTest({ participants: { alice, bob } });
