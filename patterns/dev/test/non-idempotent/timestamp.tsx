// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
// WARNING: This pattern is INTENTIONALLY non-idempotent.
// It exists to test detectNonIdempotent() diagnosis tooling.
// Do NOT use as a reference for correct pattern development.
import { computed, Default, pattern, UI, Writable } from "commonfabric";

interface Item {
  title: string;
}

interface ProcessedItem {
  title: string;
  processedAt: number;
}

const preset: Item[] = [
  { title: "Task A" },
  { title: "Task B" },
  { title: "Task C" },
];

export default pattern<{
  items: Writable<Item[] | Default<typeof preset>>;
}>(({ items }) => {
  // Anti-pattern: Date.now() in computed() — every run produces different timestamps
  const processed = new Writable<ProcessedItem[]>([]);
  computed(() => {
    processed.set(
      items.get().map((i) => ({
        title: i.title,
        processedAt: Date.now(),
      })),
    );
  });

  return {
    $NAME: "Non-Idempotent Timestamp",
    [UI]: (
      <div style="padding: 20px; font-family: monospace;">
        <h3>Non-Idempotent Timestamp</h3>
        <div>
          <strong>Input items:</strong>
          <ul>
            {items.map((item) => <li>{item.title}</li>)}
          </ul>
        </div>
        <div>
          <strong>Processed (timestamps keep changing):</strong>
          <ul>
            {processed.map((p) => (
              <li>
                {p.title} — {p.processedAt}
              </li>
            ))}
          </ul>
        </div>
        <div style="margin-top: 16px; padding: 12px; background: #fff3cd; border-radius: 4px;">
          <strong>Anti-pattern:</strong>{" "}
          Date.now() inside computed() — each run produces different values.
          <br />
          <strong>Fix:</strong>{" "}
          Use timestamps only in handlers, not in computed().
        </div>
      </div>
    ),
  };
});
