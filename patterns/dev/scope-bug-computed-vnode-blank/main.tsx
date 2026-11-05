// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Repro: investigate rendering failures with reactive composition
 *
 * Three suspected runtime warts surfaced while rewriting cozy-poll's UI
 * (see branch `scoped-cells-cozy-poll`, commit 93d545ad6):
 *
 *   W1. `style={computed(...)}` returning a style object — pattern renders blank
 *   W2. `style={computed(...)}` returning an inline-style string — same
 *   W3. Multiple top-level `{computed(() => <div/>)}` blocks combined — same
 *   W4. `<cf-input $value=>` inside `{computed(() => <div/>)}` — produces a
 *       runtime error "Bidirectionally bound property $value is not reactive"
 *
 * This file is a side-by-side harness: each section is gated by a top-level
 * boolean flag so we can flip it on, redeploy, and see which one crashes the
 * whole pattern render.
 *
 * Default state below has ONLY safe variants enabled. Toggle the flags one at
 * a time, redeploy via `cf piece setsrc`, and screenshot the result.
 */

import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ============================================================================
// Toggle these flags one at a time and redeploy with `cf piece setsrc`
// ============================================================================
const ENABLE_W1_STYLE_COMPUTED_OBJECT = true;
const ENABLE_W2_STYLE_COMPUTED_STRING = true;
const ENABLE_W3_MULTIPLE_COMPUTED_VNODES = true;
const ENABLE_W4_CF_INPUT_INSIDE_COMPUTED = true;

type CounterCell = Writable<number | Default<0>>;
type NameCell = Writable<string | Default<"">>;

const tick = handler<Record<PropertyKey, never>, { counter: CounterCell }>(
  (_, { counter }) => {
    counter.set((counter.get() ?? 0) + 1);
  },
);

export interface ReproInput {
  counter?: PerSpace<number | Default<0>>;
  name?: PerSpace<string | Default<"">>;
}

export interface ReproOutput {
  [NAME]: string;
  [UI]: VNode;
  counter: number;
  tick: Stream<Record<PropertyKey, never>>;
}

export default pattern<ReproInput, ReproOutput>(({ counter, name }) => {
  const boundTick = tick({ counter });

  return {
    [NAME]: "Computed-VNode blank-render repro",
    [UI]: (
      <div
        style={{
          padding: "20px",
          fontFamily: "system-ui, sans-serif",
          maxWidth: "640px",
          margin: "0 auto",
        }}
      >
        <h2>Reactive composition repro</h2>
        <div style={{ marginBottom: "12px", color: "#444" }}>
          Counter: <strong>{counter}</strong>
        </div>
        <cf-button onClick={boundTick}>Tick</cf-button>

        {
          /* Baseline reference: this ALWAYS renders. If we see this and the
            page is otherwise blank, the variants are the cause. */
        }
        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>Baseline (always rendered)</div>
        <div style={{ color: "#666", fontSize: "13px" }}>
          If you see this line, JSX is rendering. If not, the pattern crashed.
        </div>

        {/* W1: style={computed(...)} returning an object */}
        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W1 — style=&#123;computed(…)&#125; → object
        </div>
        {ENABLE_W1_STYLE_COMPUTED_OBJECT
          ? (
            <div
              style={computed(() => ({
                padding: "8px",
                background: (counter ?? 0) % 2 === 0 ? "#dbeafe" : "#fde68a",
                borderRadius: "4px",
              }))}
            >
              W1 content; bg toggles every tick.
            </div>
          )
          : (
            <div style={{ color: "#666", fontSize: "13px" }}>
              W1 disabled (ENABLE_W1_STYLE_COMPUTED_OBJECT = false)
            </div>
          )}

        {/* W2: style={computed(...)} returning a string */}
        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W2 — style=&#123;computed(…)&#125; → string
        </div>
        {ENABLE_W2_STYLE_COMPUTED_STRING
          ? (
            <div
              style={computed(() =>
                `padding: 8px; background: ${
                  (counter ?? 0) % 2 === 0 ? "#dbeafe" : "#fde68a"
                }; border-radius: 4px;`
              )}
            >
              W2 content; bg toggles every tick.
            </div>
          )
          : (
            <div style={{ color: "#666", fontSize: "13px" }}>
              W2 disabled (ENABLE_W2_STYLE_COMPUTED_STRING = false)
            </div>
          )}

        {/* W3: many top-level computed-VNode blocks */}
        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W3 — multiple computed-VNode blocks
        </div>
        {ENABLE_W3_MULTIPLE_COMPUTED_VNODES
          ? (
            <div>
              {computed(() => (
                <div style={{ padding: "4px 0" }}>
                  Block A — counter is{" "}
                  <strong>{(counter ?? 0) > 0 ? "positive" : "zero"}</strong>
                </div>
              ))}
              {computed(() => (
                <div style={{ padding: "4px 0" }}>
                  Block B — counter mod 2 is{" "}
                  <strong>{(counter ?? 0) % 2}</strong>
                </div>
              ))}
              {computed(() => (
                <div style={{ padding: "4px 0" }}>
                  Block C — counter squared is{" "}
                  <strong>{(counter ?? 0) * (counter ?? 0)}</strong>
                </div>
              ))}
              {computed(() => (
                <div style={{ padding: "4px 0" }}>
                  Block D — counter == 5? {(counter ?? 0) === 5 ? "yes" : "no"}
                </div>
              ))}
            </div>
          )
          : (
            <div style={{ color: "#666", fontSize: "13px" }}>
              W3 disabled (ENABLE_W3_MULTIPLE_COMPUTED_VNODES = false)
            </div>
          )}

        {/* W4: cf-input $value= inside a computed block */}
        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W4 — cf-input $value= inside computed
        </div>
        {ENABLE_W4_CF_INPUT_INSIDE_COMPUTED
          ? (
            <div>
              {computed(() => (
                <div style={{ padding: "8px 0" }}>
                  Expect "$value not reactive" runtime error:
                  <cf-input
                    $value={name}
                    placeholder="Try typing"
                    timing-strategy="immediate"
                  />
                </div>
              ))}
            </div>
          )
          : (
            <div style={{ color: "#666", fontSize: "13px" }}>
              W4 disabled (ENABLE_W4_CF_INPUT_INSIDE_COMPUTED = false)
            </div>
          )}
      </div>
    ),
    counter: counter ?? 0,
    tick: boundTick,
  };
});
