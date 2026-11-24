/**
 * Multi-user: alice sets expectNonIdempotent: true but both participants are
 * trivially idempotent. No flagged participant sees a violation, so the run
 * must FAIL with the synthetic "expectNonIdempotent" result.
 */

import { assert, multiUserTest, pattern, TESTS, Writable } from "commonfabric";

export const alice = pattern(() => {
  const value = new Writable("alice");
  const ok = assert(() => value.get() === "alice");
  return {
    [TESTS]: [{ assertion: ok }],
    expectNonIdempotent: true,
  };
});

export const bob = pattern(() => {
  const value = new Writable("bob");
  const ok = assert(() => value.get() === "bob");
  return {
    [TESTS]: [{ assertion: ok }],
  };
});

export default multiUserTest({ participants: { alice, bob } });
