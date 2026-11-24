/**
 * A non-idempotent accumulator WITHOUT expectNonIdempotent. The detected
 * violation must FAIL the test (the long-standing default behavior).
 */

import { assert, computed, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const value = new Writable("hello");
  const log = new Writable<string[]>([]);

  // Non-idempotent: appends to log on every re-execution
  computed(() => {
    const current = log.get();
    log.set([...current, `${value.get()} at run #${current.length + 1}`]);
  });

  const hasEntries = assert(() => log.get().length > 0);

  return {
    [TESTS]: [{ assertion: hasEntries }],
  };
});
