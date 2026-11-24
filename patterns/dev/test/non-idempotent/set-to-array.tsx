// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
// WARNING: This pattern is INTENTIONALLY non-idempotent.
// It exists to test detectNonIdempotent() diagnosis tooling.
// Do NOT use as a reference for correct pattern development.
import { computed, Default, pattern, UI, Writable } from "commonfabric";

interface Item {
  title: string;
  tag: string;
}

const preset: Item[] = [
  { title: "Apples", tag: "fruit" },
  { title: "Carrots", tag: "vegetable" },
  { title: "Bananas", tag: "fruit" },
  { title: "Broccoli", tag: "vegetable" },
  { title: "Cherries", tag: "fruit" },
  { title: "Spinach", tag: "vegetable" },
  { title: "Grapes", tag: "fruit" },
  { title: "Peppers", tag: "vegetable" },
];

export default pattern<{
  items: Writable<Item[] | Default<typeof preset>>;
}>(({ items }) => {
  // Anti-pattern: the insertion order into the Set varies between runs, so the
  // Set's first-occurrence iteration order — and the array written from it —
  // changes on every run.
  //
  // The order is derived from the previous output (a cell this computation also
  // writes) rather than from entropy. A `Math.random()` shuffle cannot express
  // this any more: the capability gate throws on ambient entropy inside a
  // computed(), so that spelling would abort the run instead of demonstrating
  // the churn. Deriving from the previous output is also the more reliable
  // demonstration, because consecutive runs then differ with certainty — see
  // set-to-array.test.tsx, which makes the same choice for the same reason.
  const uniqueTags = new Writable<string[]>([]);
  computed(() => {
    const tags = items.get().map((i) => i.tag);
    const previousFirst = uniqueTags.get()[0];
    const ordered = previousFirst === tags[0] ? [...tags].reverse() : tags;
    const set = new Set(ordered);
    uniqueTags.set([...set]);
  });

  return {
    $NAME: "Non-Idempotent Set-to-Array",
    [UI]: (
      <div style="padding: 20px; font-family: monospace;">
        <h3>Non-Idempotent Set-to-Array</h3>
        <div>
          <strong>Items:</strong>
          <ul>
            {items.map((item) => (
              <li>
                {item.title} [{item.tag}]
              </li>
            ))}
          </ul>
        </div>
        <div>
          <strong>Unique tags (keeps reordering):</strong>
          <ul>
            {uniqueTags.map((tag) => <li>{tag}</li>)}
          </ul>
        </div>
        <div style="margin-top: 16px; padding: 12px; background: #fff3cd; border-radius: 4px;">
          <strong>Anti-pattern:</strong>{" "}
          Letting the insertion order into a Set vary between runs before
          converting it to an array, so each run writes a different order.
          <br />
          <strong>Fix:</strong>{" "}
          Derive the order from the input only, and sort after Set conversion:
          [...set].sort().
        </div>
      </div>
    ),
  };
});
