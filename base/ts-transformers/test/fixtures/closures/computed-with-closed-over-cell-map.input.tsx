import { Writable, computed, pattern } from "commonfabric";

// FIXTURE: computed-with-closed-over-cell-map
// Verifies: .map() on a closed-over Cell inside computed() IS transformed to .mapWithPattern()
//   computed(() => numbers.map(n => n * multiplier.get())) → lift(({ numbers, multiplier }) => numbers.mapWithPattern(pattern(fn, ...), { multiplier }))({ numbers, multiplier })
// Context: Unlike Reactive arrays, Cell arrays still need reactive mapping even
//   inside a lift-applied callback. The .map() callback's closed-over `multiplier` cell
//   is passed as a params object to mapWithPattern.
export default pattern(() => {
  const numbers = new Writable([1, 2, 3]);
  const multiplier = new Writable(2);

  // Inside computed, we close over numbers (a Cell)
  // The computed gets transformed to the lift-applied form lift(() => numbers.map(...))({})
  // Inside a lift-applied computation, .map on a closed-over Cell should STILL be transformed to mapWithPattern
  // because Cells need the pattern-based mapping even when unwrapped
  const doubled = computed(() => numbers.map(n => n * multiplier.get()));

  return doubled;
});
