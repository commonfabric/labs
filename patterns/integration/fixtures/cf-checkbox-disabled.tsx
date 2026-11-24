import {
  type Default,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// Fixture for the `waitForDisabled` browser helper. A cf-checkbox renders an
// <input type="checkbox"> in its shadow root and no <button>, so it exercises
// the helper's fallback to the host's `disabled` / `aria-disabled` state. Its
// disabled state is driven by a cell that a button toggles, letting a test
// observe the helper resolve both the enabled and the disabled reading.
interface Input {
  controlDisabled: Writable<boolean | Default<false>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  controlDisabled: boolean;
}

const toggleDisabled = handler<unknown, { controlDisabled: Writable<boolean> }>(
  (_event, { controlDisabled }) => controlDisabled.set(!controlDisabled.get()),
);

const CfCheckboxDisabled = pattern<Input, Output>(({ controlDisabled }) => {
  return {
    [NAME]: "cf-checkbox-disabled",
    [UI]: (
      <cf-vstack gap="2" style="padding: 2rem;">
        <cf-checkbox id="probe-checkbox" disabled={controlDisabled}>
          Probe checkbox
        </cf-checkbox>
        <p id="checkbox-disabled-status">
          {ifElse(controlDisabled, "Checkbox disabled", "Checkbox enabled")}
        </p>
        <cf-button
          id="toggle-disabled"
          onClick={toggleDisabled({ controlDisabled })}
        >
          Toggle disabled
        </cf-button>
      </cf-vstack>
    ),
    controlDisabled,
  };
});

export default CfCheckboxDisabled;
