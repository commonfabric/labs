import {
  Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface CheckboxDemoInput {
  simpleEnabled: Writable<boolean | Default<false>>;
  trackedEnabled: Writable<boolean | Default<false>>;
}

export interface CheckboxDemoOutput extends CheckboxDemoInput {
  [NAME]: string;
  [UI]: VNode;
}

// Handler for checkbox changes - only needed when you want additional logic
// Defined at module scope as required by the pattern system
const toggleWithLogging = handler<
  { detail: { checked: boolean } },
  { enabled: Writable<boolean> }
>(
  ({ detail }, { enabled }) => {
    const newValue = detail?.checked ?? false;
    enabled.set(newValue);
    // Additional side effects
    console.log("Checkbox toggled to:", newValue);
  },
);

export default pattern<CheckboxDemoInput, CheckboxDemoOutput>(
  ({ simpleEnabled, trackedEnabled }) => {
    return {
      [NAME]: "Checkbox Demo",
      [UI]: (
        <cf-vstack gap="2" style="padding: 2rem; max-width: 600px;">
          <h3>cf-checkbox Bidirectional Binding Demo</h3>

          <cf-card>
            <h4>Simple Bidirectional Binding (Preferred)</h4>
            <p>
              Using $checked alone - no handler needed! The cell automatically
              updates.
            </p>
            <cf-checkbox $checked={simpleEnabled}>
              Enable Simple Feature
            </cf-checkbox>

            <p id="feature-status">
              {ifElse(
                simpleEnabled,
                "✓ Feature is enabled!",
                "⚠ Feature is disabled",
              )}
            </p>
          </cf-card>

          <cf-card>
            <h4>With Handler for Additional Logic</h4>
            <p>
              Use a handler when you need to run additional code (logging,
              validation, side effects)
            </p>
            <cf-checkbox
              $checked={trackedEnabled}
              oncf-change={toggleWithLogging({ enabled: trackedEnabled })}
            >
              Enable Tracked Feature
            </cf-checkbox>

            <p>
              Value: {ifElse(trackedEnabled, "✓ Enabled", "⚠ Disabled")}
            </p>
            <p>
              <small>(Check console for logging)</small>
            </p>
          </cf-card>

          <cf-card>
            <h4>Key Takeaway</h4>
            <p>
              <strong>$checked automatically updates the Writable</strong>{" "}
              - you don't need a handler unless you want to add extra logic
              beyond just updating the value.
            </p>
          </cf-card>
        </cf-vstack>
      ),
      simpleEnabled,
      trackedEnabled,
    };
  },
);
