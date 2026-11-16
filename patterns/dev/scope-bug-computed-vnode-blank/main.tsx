// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
/**
 * Fixture: reactive composition shapes rendered side by side in one view.
 *
 *   W1. `style={computed(...)}` returning a style object.
 *   W2. `style={computed(...)}` returning an inline-style string.
 *   W3. Several `{computed(() => <div/>)}` blocks side by side.
 *   W4. A `$value` binding at a static position, switched with `ifElse()`.
 *
 * W4 is the form that replaces a `$value` binding inside a
 * `{computed(() => …)}` subtree. There the binding receives a plain value, and
 * `h()` refuses it with "Bidirectionally bound property $value is not
 * reactive"; `runtime/runner/test/h-binding-validation.test.ts` covers that
 * refusal. `main.test.tsx` checks every section renders and follows the
 * counter.
 */

import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

type CounterCell = Writable<number | Default<0>>;

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
  const isEven = computed(() => (counter ?? 0) % 2 === 0);

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

        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W1 — style=&#123;computed(…)&#125; → object
        </div>
        <div
          style={computed(() => ({
            padding: "8px",
            background: (counter ?? 0) % 2 === 0 ? "#dbeafe" : "#fde68a",
            borderRadius: "4px",
          }))}
        >
          W1 content; bg toggles every tick.
        </div>

        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W2 — style=&#123;computed(…)&#125; → string
        </div>
        <div
          style={computed(() =>
            `padding: 8px; background: ${
              (counter ?? 0) % 2 === 0 ? "#dbeafe" : "#fde68a"
            }; border-radius: 4px;`
          )}
        >
          W2 content; bg toggles every tick.
        </div>

        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W3 — multiple computed-VNode blocks
        </div>
        <div>
          {computed(() => (
            <div style={{ padding: "4px 0" }}>
              Block A — counter is{" "}
              <strong>{(counter ?? 0) > 0 ? "positive" : "zero"}</strong>
            </div>
          ))}
          {computed(() => (
            <div style={{ padding: "4px 0" }}>
              Block B — counter mod 2 is <strong>{(counter ?? 0) % 2}</strong>
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

        <hr style={{ margin: "16px 0" }} />
        <div style={{ fontWeight: 600 }}>
          W4 — cf-input $value= switched by ifElse
        </div>
        <div style={{ padding: "8px 0" }}>
          {ifElse(
            isEven,
            <cf-input
              $value={name}
              placeholder="Shown on even ticks"
              timingStrategy="immediate"
            />,
            <div>Input hidden on odd ticks</div>,
          )}
          <div>Name: {name}</div>
        </div>
      </div>
    ),
    counter: counter ?? 0,
    tick: boundTick,
  };
});
