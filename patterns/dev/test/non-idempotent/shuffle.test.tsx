/**
 * Test that exercises a non-idempotent shuffle computation.
 * expectNonIdempotent asserts the idempotency check detects it; the test
 * FAILS if no violation is reported.
 *
 * The permutation alone is not a reliable detection signal: a 5-element
 * shuffle repeats the previous order 1 in 120 times, which is a real flake
 * rate once a missed detection fails the test. A counter cell that the
 * computation reads and increments on every run makes consecutive runs
 * differ with certainty while keeping the shuffle as the demonstrated
 * anti-pattern.
 *
 * Run: deno task cf test patterns/dev/test/non-idempotent/shuffle.test.tsx --verbose
 */
import { assert, computed, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const items = new Writable(["alpha", "bravo", "charlie", "delta", "echo"]);
  const shuffled = new Writable<string[]>([]);
  const runCounter = new Writable(0);
  const lastDraw = new Writable(0);

  // Non-idempotent: the counter cell is read and incremented on every run, so
  // consecutive runs produce a different permutation (and a different recorded
  // draw). The counter drives the anti-pattern without reading a gated
  // clock/entropy source.
  computed(() => {
    const stamp = runCounter.get() + 1;
    runCounter.set(stamp);
    const arr = [...items.get()];
    let seed = stamp;
    for (let i = arr.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    shuffled.set(arr);
    lastDraw.set(stamp);
  });

  const hasItems = assert(() => shuffled.get().length > 0);

  return {
    [TESTS]: [{ assertion: hasItems }],
    expectNonIdempotent: true,
  };
});
