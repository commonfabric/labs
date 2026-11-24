/**
 * Test that exercises a non-idempotent computation.
 * expectNonIdempotent asserts the idempotency check detects it; the test
 * FAILS if no violation is reported.
 *
 * The non-idempotency comes from a counter cell that the computation reads
 * and increments on every run, so the detector's recheck always observes a
 * different stamp than the run it verifies. Detection is deterministic and
 * does not depend on how slow the re-run happens to be.
 *
 * Run: deno task cf test patterns/dev/test/non-idempotent/timestamp.test.tsx --verbose
 */
import { assert, computed, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const items = new Writable([{ title: "Task A" }, { title: "Task B" }]);
  const processed = new Writable<{ title: string; processedAt: number }[]>([]);
  const runCounter = new Writable(0);

  // Non-idempotent: the counter cell is read and incremented on every run,
  // so consecutive runs stamp the items with different values.
  computed(() => {
    const stamp = runCounter.get() + 1;
    runCounter.set(stamp);
    processed.set(
      items.get().map((i) => ({
        title: i.title,
        processedAt: stamp,
      })),
    );
  });

  const hasItems = assert(() => processed.get().length > 0);

  return {
    [TESTS]: [{ assertion: hasItems }],
    expectNonIdempotent: true,
  };
});
