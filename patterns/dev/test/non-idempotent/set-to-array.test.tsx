/**
 * Test that exercises a non-idempotent Set-to-Array computation.
 * Insertion order into the Set depends on the previous output (a cell this
 * computation also writes), so the Set's first-occurrence iteration order —
 * and the array written from it — flips on every run. expectNonIdempotent
 * asserts the idempotency check detects this; the test FAILS if no
 * violation is reported.
 *
 * Deliberately NOT a random shuffle: with only two distinct tags a random
 * order repeats itself about half the time, letting the detector's
 * synchronous recheck see identical writes and miss. Deriving the order
 * from the previous output makes consecutive runs differ with certainty
 * (module-level mutable state would be the obvious alternative, but SES
 * mode rejects top-level `let`).
 *
 * Run: deno task cf test patterns/dev/test/non-idempotent/set-to-array.test.tsx --verbose
 */
import { assert, computed, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const items = new Writable([
    { title: "Apples", tag: "fruit" },
    { title: "Carrots", tag: "vegetable" },
    { title: "Bananas", tag: "fruit" },
    { title: "Broccoli", tag: "vegetable" },
  ]);
  const uniqueTags = new Writable<string[]>([]);

  // Non-idempotent: insertion order flips whenever the previous output
  // already starts with the natural first tag, so the Set's iteration
  // order alternates [fruit, vegetable] / [vegetable, fruit] between
  // consecutive runs.
  computed(() => {
    const tags = items.get().map((i) => i.tag);
    const previousFirst = uniqueTags.get()[0];
    const ordered = previousFirst === tags[0] ? [...tags].reverse() : tags;
    const set = new Set(ordered);
    uniqueTags.set([...set]);
  });

  const hasTags = assert(() => uniqueTags.get().length > 0);

  return {
    [TESTS]: [{ assertion: hasTags }],
    expectNonIdempotent: true,
  };
});
