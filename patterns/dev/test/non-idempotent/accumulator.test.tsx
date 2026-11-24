/**
 * Test that exercises a non-idempotent accumulator computation.
 * expectNonIdempotent asserts the idempotency check detects it; the test
 * FAILS if no violation is reported. Detection is deterministic here: the
 * computation reads the log it appends to, so the recheck always writes one
 * more entry than the run it verifies.
 *
 * Run: deno task cf test patterns/dev/test/non-idempotent/accumulator.test.tsx --verbose
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

  // Trivial assertion: log should have at least one entry after initial run
  const hasEntries = assert(() => log.get().length > 0);

  return {
    [TESTS]: [{ assertion: hasEntries }],
    expectNonIdempotent: true,
  };
});
