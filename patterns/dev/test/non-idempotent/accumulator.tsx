// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
// WARNING: This pattern is INTENTIONALLY non-idempotent.
// It exists to test detectNonIdempotent() diagnosis tooling.
// Do NOT use as a reference for correct pattern development.
import { computed, Default, pattern, UI, Writable } from "commonfabric";

export default pattern<{
  value: Writable<string | Default<"hello">>;
}>(({ value }) => {
  // Anti-pattern: Appending to an array instead of replacing — grows infinitely
  const log = new Writable<string[]>([]);
  computed(() => {
    const current = log.get();
    log.set([...current, `${value.get()} at run #${current.length + 1}`]);
  });

  return {
    $NAME: "Non-Idempotent Accumulator",
    [UI]: (
      <div style="padding: 20px; font-family: monospace;">
        <h3>Non-Idempotent Accumulator</h3>
        <div>
          <strong>Input value:</strong> {value}
        </div>
        <div>
          <strong>Log (growing rapidly):</strong>
          <ul>
            {log.map((entry) => <li>{entry}</li>)}
          </ul>
        </div>
        <div>
          <strong>Entry count:</strong> {computed(() => `${log.get().length}`)}
        </div>
        <div style="margin-top: 16px; padding: 12px; background: #fff3cd; border-radius: 4px;">
          <strong>Anti-pattern:</strong>{" "}
          Reading and appending to the same Writable in computed() — each run
          reads a longer array and writes an even longer one.
          <br />
          <strong>Fix:</strong>{" "}
          Derive the full value from inputs instead of appending incrementally.
        </div>
      </div>
    ),
  };
});
