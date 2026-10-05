/**
 * Pins the CT-2277 `$NAME` runaway: a pattern whose own output re-enters the
 * list it reads grows its name by one fixed segment on every pass, forever.
 *
 * Reduced from the pattern that grew ben-loom-dev-6 to 27.7 GB. The original
 * read every piece's $NAME out of the space registry, filtered that list for
 * names containing "trip", took the first match as `tripLabel`, and returned
 * its own $NAME as `Packing list · ${tripLabel}`. Two things closed the cycle:
 * the piece was in the registry it read, and the no-match fallback was the
 * literal "Your trip" — which itself contains "trip". So the first pass wrote
 * "Packing list · Your trip", and from the second pass on the piece matched
 * its own filter and read its own previous $NAME. 19,411 passes appended
 * "Packing list · " (15 characters) to one string, reaching 291,174 characters
 * and ~19.4 GB of durable history.
 *
 * A correct run settles after the first pass, leaving the name exactly
 * `SEGMENT + FALLBACK`. The assertion below states that, so the test fails on
 * a runtime that lets the cycle turn.
 *
 * STOP_ABOVE is what keeps this test honest rather than fatal: uncapped, the
 * cycle allocates until V8 aborts the process with a GC assertion, which
 * reports a panic instead of a failed assertion. The cap ends the writes; the
 * assertion reports how far past one pass the runtime got.
 *
 * Run: deno task cf test packages/patterns/test/non-idempotent/self-referential-name.test.tsx --verbose
 */
import { assert, computed, pattern, TESTS, Writable } from "commonfabric";

export default pattern(() => {
  const SEGMENT = "Packing list · ";
  const FALLBACK = "Your trip";
  const SETTLED = `${SEGMENT}${FALLBACK}`;
  const STOP_ABOVE = 400;

  const name = new Writable(FALLBACK);
  const candidates = new Writable<string[]>([]);

  // The registry hop: the space's piece names, which include this piece's own.
  computed(() => {
    candidates.set([name.get()]);
  });

  // The original filter: match a trip-ish name, fall back to a literal that
  // itself matches the filter.
  computed(() => {
    const current = name.get();
    if (current.length > STOP_ABOVE) return;
    const matches = candidates.get().filter((candidate) =>
      candidate.toLowerCase().includes("trip") ||
      candidate.toLowerCase().includes("travel")
    );
    const tripLabel = matches.length > 0 ? matches[0] : FALLBACK;
    name.set(`${SEGMENT}${tripLabel}`);
  });

  const settlesAfterOnePass = assert(() => name.get() === SETTLED);

  return {
    [TESTS]: [{ assertion: settlesAfterOnePass }],
  };
});
