// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
// WARNING: This pattern is INTENTIONALLY non-idempotent.
// It exists to pin the CT-2277 `$NAME` runaway. Do NOT use as a reference.
//
// Reduced from the pattern that grew ben-loom-dev-6 to 27.7 GB. The original
// read every piece's $NAME out of the space registry, filtered that list for
// names containing "trip", took the first match as `tripLabel`, and returned
// its own $NAME as `Packing list · ${tripLabel}`. Two things closed the cycle:
// the piece was in the registry it read, and the no-match fallback was the
// literal "Your trip" — which itself contains "trip". So the first pass wrote
// "Packing list · Your trip", and from the second pass on the piece matched
// its own filter and read its own previous $NAME.
//
// 19,411 passes appended "Packing list · " (15 characters) 19,411 times,
// growing one string to 291,174 characters. Because each pass rewrote the
// whole string across three documents in two tables, the durable cost was
// quadratic: ~19.4 GB.
//
// The registry hop is modelled here by a candidates list that includes the
// pattern's own previous output — the smallest shape that keeps the read and
// the write at different addresses, which is what makes the cycle survive.
import { computed, pattern, UI, Writable } from "commonfabric";

export default pattern(() => {
  const SEGMENT = "Packing list · ";
  const FALLBACK = "Your trip";
  // Uncapped, this cycle allocates until V8 aborts the process with a GC
  // assertion. The cap keeps the fixture inspectable in the shell.
  const STOP_ABOVE = 400;

  const name = new Writable(FALLBACK);
  const candidates = new Writable<string[]>([]);

  // The registry hop: the space's piece names, which include this piece's own.
  computed(() => {
    candidates.set([name.get()]);
  });

  // The original filter, verbatim in spirit: match a trip-ish name, fall back
  // to a literal that itself matches the filter.
  computed(() => {
    if (name.get().length > STOP_ABOVE) return;
    const matches = candidates.get().filter((candidate) =>
      candidate.toLowerCase().includes("trip") ||
      candidate.toLowerCase().includes("travel")
    );
    const tripLabel = matches.length > 0 ? matches[0] : FALLBACK;
    name.set(`${SEGMENT}${tripLabel}`);
  });

  return {
    $NAME: "Self-referential name",
    [UI]: (
      <div>
        <strong>Name length:</strong> {computed(() => `${name.get().length}`)}
      </div>
    ),
  };
});
