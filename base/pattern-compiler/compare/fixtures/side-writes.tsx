/// <cts-enable />
import { computed, handler, lift, pattern, Writable } from "commonfabric";

const setValue = handler<{ to: string }, { value: Writable<string> }>(
  (event, { value }) => {
    value.set(event.to);
  },
);

// One write whose target is reached through data, the key: the body is a
// materializer (`footprint-analysis.md` §6.3).
const tally = lift(
  (x: { counts: Writable<Record<string, number>>; flavor: string }) => {
    x.counts.key(x.flavor).set(x.flavor.length);
    return x.flavor;
  },
);

interface Input {
  flavor: string;
}

// Ruling Z7. `upper` and `marked` each write one cell the compiler names:
// they are ordinary nodes, demanded through their write targets. The
// result passes `last` on by reference, and `shown` reads `seen`. `tallied`
// is a materializer: it is evaluated after the rest of a wave, and what it
// writes makes `total` stale.
export default pattern<Input>(({ flavor }) => {
  const value = Writable.of("a");
  const last = Writable.of("");
  const seen = Writable.of("");
  const counts = Writable.of<Record<string, number>>({});
  const _upper = computed(() => {
    last.set(value.get().toUpperCase());
  });
  const _marked = computed(() => {
    seen.set(value.get() + "!");
  });
  const shown = computed(() => "seen " + seen.get());
  const tallied = tally({ counts, flavor });
  const total = computed(() => Object.keys(counts.get()).length);
  return {
    last,
    shown,
    tallied,
    counts,
    total,
    setValue: setValue({ value }),
  };
});
