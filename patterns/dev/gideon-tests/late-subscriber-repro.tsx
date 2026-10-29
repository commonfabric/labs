// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import { NAME, pattern, UI, Writable } from "commonfabric";

/**
 * Reproduction case for late subscriber initial value bug.
 *
 * Bug: When multiple CellHandle instances subscribe to the same cell with the
 * same schema key, late subscribers would miss the initial value. This happened
 * because the subscription was already established, so no new backend request
 * was made, and the late subscriber's CellHandle never received the cached value.
 *
 * Example: cf-input binds to a cell with stringSchema, creating a new CellHandle.
 * Text interpolation {value} also subscribes to the same cell with the same schema.
 * On initial page load, the text interpolation would show blank because it subscribed
 * after the initial value was already sent to the first subscriber.
 *
 * Fix: In connection.subscribe(), when adding a CellHandle to an existing
 * subscription, copy the cached value from an existing subscriber to the new one.
 *
 * To test:
 * 1. Deploy this pattern with `piece new`
 * 2. On initial page load, all "Interpolated" values should show their initial values
 * 3. Interacting with any component should update its interpolated value
 */

export interface Output {
  [NAME]: string;
  textValue: string;
  textareaValue: string;
  checkboxValue: boolean;
}

export default pattern<Record<string, never>, Output>(() => {
  const textValue = new Writable<string>("hello");
  const textareaValue = new Writable<string>("multi\nline");
  const checkboxValue = new Writable<boolean>(true);

  return {
    [NAME]: "Late Subscriber Repro",
    [UI]: (
      <cf-screen>
        <cf-vstack gap="4" style="padding: 1rem;">
          <cf-card>
            <cf-vstack gap="2">
              <cf-heading level={4}>cf-input</cf-heading>
              <cf-input $value={textValue} placeholder="Type here..." />
              <p>
                <strong>Interpolated:</strong> {textValue}
              </p>
            </cf-vstack>
          </cf-card>

          <cf-card>
            <cf-vstack gap="2">
              <cf-heading level={4}>cf-textarea</cf-heading>
              <cf-textarea $value={textareaValue} placeholder="Type here..." />
              <p>
                <strong>Interpolated:</strong> {textareaValue}
              </p>
            </cf-vstack>
          </cf-card>

          <cf-card>
            <cf-vstack gap="2">
              <cf-heading level={4}>cf-checkbox</cf-heading>
              <cf-checkbox $checked={checkboxValue}>Toggle me</cf-checkbox>
              <p>
                <strong>Interpolated:</strong> [{checkboxValue}]
              </p>
            </cf-vstack>
          </cf-card>

          <p style="color: gray; font-size: 0.875rem;">
            If any "Interpolated" value is blank on initial page load, the late
            subscriber bug is present. All values should appear immediately.
          </p>
        </cf-vstack>
      </cf-screen>
    ),
    textValue,
    textareaValue,
    checkboxValue,
  };
});
