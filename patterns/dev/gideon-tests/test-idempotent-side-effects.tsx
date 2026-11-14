// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Test Pattern: Idempotent Side Effects in computed()
 *
 * CLAIM TO VERIFY:
 * "computed, lift, and derive CAN have side effects - but they MUST be idempotent."
 *
 * Two computeds run off the same trigger:
 * 1. NON-IDEMPOTENT: appends the trigger to an array and bumps a run counter
 *    on every run
 * 2. IDEMPOTENT: writes a key derived from the trigger, only when it is missing
 *
 * The scheduler does not re-run a computation for its own writes, so neither
 * one loops: each runs once per change of its inputs. Both also read a re-run
 * count, so "Re-run With Same Trigger" runs them again with the trigger
 * unchanged. The non-idempotent one then appends a duplicate entry, and the
 * recheck `cf test` makes of every computation reports it; the idempotent one
 * leaves its map as it was. test-idempotent-side-effects.test.tsx asserts
 * both.
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  toIndentedDebugString,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface TestInput {
  // Trigger value that we can change to force re-computation
  triggerCount: number | Default<0>;
  // Changing this re-runs both computeds with the trigger unchanged
  rerunCount: number | Default<0>;
}

interface KeyedEntry {
  trigger: number;
}

export interface TestOutput {
  [NAME]: string;
  [UI]: VNode;
  triggerCount: number;
  rerunCount: number;
  nonIdempotentRunCount: number;
  nonIdempotentData: number[];
  idempotentData: Record<string, KeyedEntry>;
  /** How many distinct triggers the idempotent computed has recorded. */
  idempotentRunCount: number;
}

const increment = handler<unknown, { count: Writable<number> }>(
  (_args, { count }) => {
    count.set(count.get() + 1);
  },
);

export default pattern<TestInput, TestOutput>(
  ({ triggerCount, rerunCount }) => {
    const nonIdempotentArray = new Writable<number[]>([]);
    const nonIdempotentCounter = new Writable(0);

    const idempotentMap = new Writable<Record<string, KeyedEntry>>({});

    // More entries than triggers means some run appended for a trigger that an
    // earlier run had already handled.
    const hasDuplicates = computed(() =>
      nonIdempotentArray.get().length > triggerCount
    );

    // NON-IDEMPOTENT APPROACH: append to the array and bump the counter on
    // every run, so a re-run with the same trigger changes state again. It acts
    // only once the trigger is above zero, so loading the pattern writes
    // nothing.
    const nonIdempotentComputed = computed(() => {
      const trigger = triggerCount;
      const reruns = rerunCount;

      if (trigger > 0) {
        const current = nonIdempotentArray.get();
        nonIdempotentArray.set([...current, trigger]);
        nonIdempotentCounter.set(nonIdempotentCounter.get() + 1);
      }

      return nonIdempotentCounter.get() > 0
        ? `Non-idempotent computed ran ${nonIdempotentCounter.get()} times ` +
          `(re-run ${reruns})`
        : "Click trigger to start";
    });

    // IDEMPOTENT APPROACH: write a key derived from the trigger only when it is
    // missing, so a re-run with the same trigger writes nothing.
    const idempotentComputed = computed(() => {
      const trigger = triggerCount;
      const reruns = rerunCount;

      if (trigger > 0) {
        const current = idempotentMap.get();
        const key = `trigger-${trigger}`;
        if (!(key in current)) {
          idempotentMap.set({ ...current, [key]: { trigger } });
        }
        return `Idempotent computed holds key "${key}" (re-run ${reruns})`;
      }

      return "Click trigger to start";
    });

    return {
      [NAME]: "Test: Idempotent Side Effects",
      [UI]: (
        <div style={{ padding: "20px", fontFamily: "system-ui, sans-serif" }}>
          <h2>Idempotent Side Effects Test</h2>

          <div
            style={{
              marginBottom: "20px",
              padding: "10px",
              backgroundColor: "#f0f0f0",
              borderRadius: "5px",
            }}
          >
            <p>
              <strong>Trigger Count:</strong> {triggerCount}
            </p>
            <cf-button
              onClick={increment({ count: triggerCount })}
              style={{ padding: "10px 20px", fontSize: "16px" }}
            >
              Trigger Re-computation
            </cf-button>{" "}
            <cf-button
              onClick={increment({ count: rerunCount })}
              style={{ padding: "10px 20px", fontSize: "16px" }}
            >
              Re-run With Same Trigger
            </cf-button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "20px",
            }}
          >
            {/* Non-Idempotent Column */}
            <div
              style={{
                padding: "15px",
                backgroundColor: "#fee",
                borderRadius: "5px",
                border: "2px solid #f88",
              }}
            >
              <h3 style={{ color: "#c00" }}>❌ Non-Idempotent (Accumulates)</h3>
              <p>
                <strong>Status:</strong> {nonIdempotentComputed}
              </p>
              <p>
                <strong>Run Count:</strong> {nonIdempotentCounter}
              </p>
              <p>
                <strong>Array Length:</strong> {nonIdempotentArray.get().length}
              </p>

              <div
                style={{
                  marginTop: "10px",
                  padding: "10px",
                  backgroundColor: "white",
                  borderRadius: "3px",
                  maxHeight: "200px",
                  overflow: "auto",
                }}
              >
                <strong>Data (keeps growing):</strong>
                <pre style={{ fontSize: "11px", margin: "5px 0" }}>
                {toIndentedDebugString(nonIdempotentArray.get())}
                </pre>
              </div>

              {ifElse(
                hasDuplicates,
                <div
                  style={{
                    marginTop: "10px",
                    padding: "10px",
                    backgroundColor: "#fdd",
                    borderRadius: "3px",
                  }}
                >
                  ⚠️ DUPLICATES: {nonIdempotentArray.get().length} entries for
                  {" "}
                  {triggerCount} triggers
                </div>,
                null,
              )}
            </div>

            {/* Idempotent Column */}
            <div
              style={{
                padding: "15px",
                backgroundColor: "#efe",
                borderRadius: "5px",
                border: "2px solid #8f8",
              }}
            >
              <h3 style={{ color: "#080" }}>✅ Idempotent (Stable)</h3>
              <p>
                <strong>Status:</strong> {idempotentComputed}
              </p>
              <p>
                <strong>Unique Keys:</strong>{" "}
                {Object.keys(idempotentMap.get()).length}
              </p>

              <div
                style={{
                  marginTop: "10px",
                  padding: "10px",
                  backgroundColor: "white",
                  borderRadius: "3px",
                  maxHeight: "200px",
                  overflow: "auto",
                }}
              >
                <strong>Data (stable):</strong>
                <pre style={{ fontSize: "11px", margin: "5px 0" }}>
                {toIndentedDebugString(idempotentMap.get())}
                </pre>
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: "20px",
              padding: "15px",
              backgroundColor: "#e8f4f8",
              borderRadius: "5px",
            }}
          >
            <h3>📚 Explanation</h3>
            <p>
              <strong>Non-Idempotent:</strong>{" "}
              Always appends to array → every re-run with the same trigger adds
              another entry
            </p>
            <p>
              <strong>Idempotent:</strong>{" "}
              Checks if key exists before writing → a re-run with the same
              trigger changes nothing
            </p>
            <p>
              <strong>Key Insight:</strong>{" "}
              Side effects in computed() must be idempotent (same inputs = same
              state), since a computation can run more than once for the same
              inputs
            </p>
          </div>
        </div>
      ),
      triggerCount,
      rerunCount,
      nonIdempotentRunCount: nonIdempotentCounter,
      nonIdempotentData: nonIdempotentArray,
      idempotentData: idempotentMap,
      idempotentRunCount: computed(() =>
        Object.keys(idempotentMap.get()).length
      ),
    };
  },
);
