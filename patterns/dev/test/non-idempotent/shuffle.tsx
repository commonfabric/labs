// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
// WARNING: This pattern is INTENTIONALLY non-idempotent.
// It exists to test detectNonIdempotent() diagnosis tooling.
// Do NOT use as a reference for correct pattern development.
import { computed, Default, pattern, UI, Writable } from "commonfabric";

export default pattern<{
  items: Writable<
    string[] | Default<["alpha", "bravo", "charlie", "delta", "echo"]>
  >;
}>(({ items }) => {
  // Anti-pattern: Math.random() inside computed() produces different output each run
  const shuffled = new Writable<string[]>([]);
  computed(() => {
    const arr = [...items.get()];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    shuffled.set(arr);
  });

  return {
    $NAME: "Non-Idempotent Shuffle",
    [UI]: (
      <div style="padding: 20px; font-family: monospace;">
        <h3>Non-Idempotent Shuffle</h3>
        <div>
          <strong>Input items:</strong>
          <ul>
            {items.map((item) => <li>{item}</li>)}
          </ul>
        </div>
        <div>
          <strong>Shuffled (keeps changing):</strong>
          <ul>
            {shuffled.map((item) => <li>{item}</li>)}
          </ul>
        </div>
        <div style="margin-top: 16px; padding: 12px; background: #fff3cd; border-radius: 4px;">
          <strong>Anti-pattern:</strong>{" "}
          Math.random() in computed() — each run produces a different
          permutation.
          <br />
          <strong>Fix:</strong>{" "}
          Sort deterministically or move randomization to a handler.
        </div>
      </div>
    ),
  };
});
