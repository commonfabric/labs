import { pattern, UI } from "commonfabric";

type SelectedScopes = {
  gmail: boolean;
  calendar: boolean;
};

const SCOPE_DESCRIPTIONS = {
  gmail: "Gmail",
  calendar: "Calendar",
} as const;

interface Input {
  selectedScopes: SelectedScopes;
}

// FIXTURE: map-plain-array-dynamic-checkbox
// Verifies: plain-array callback roots stay plain while dynamic JSX bindings still lower to a lift-applied computation
//   Object.entries(...).map(fn)                     -> plain .map() remains plain
//   selectedScopes[key as keyof SelectedScopes]     -> lift-applied binding with selectedScopes and key captures
// Context: Dynamic property access in a plain array callback used as a cf-checkbox binding
export default pattern<Input>(({ selectedScopes }) => {
  return {
    [UI]: (
      <div>
        {Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (
          <label>
            <cf-checkbox $checked={selectedScopes[key as keyof SelectedScopes]}>
              {description}
            </cf-checkbox>
          </label>
        ))}
      </div>
    ),
  };
});
