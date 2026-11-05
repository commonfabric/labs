/**
 * expectNonIdempotent: true on a trivially idempotent pattern.
 *
 * The flag asserts that the idempotency detector fires, so this test must
 * FAIL with "expected non-idempotent computation(s), none detected" — a
 * silent pass here is exactly the detection regression the flag guards.
 */

import { assert, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const value = new Writable("hello");

  const ok = assert(() => value.get() === "hello");

  return {
    [TESTS]: [{ assertion: ok }],
    expectNonIdempotent: true,
  };
});
