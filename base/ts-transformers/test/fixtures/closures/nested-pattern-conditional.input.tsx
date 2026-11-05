import { pattern, UI } from "commonfabric";

// FIXTURE: nested-pattern-conditional
// Verifies: nested factories in JSX conditional branches carry only authored
// captures through each branch-local bound factory.
export default pattern<{ enabled: boolean; label: string }>(
  ({ enabled, label }) => ({
    [UI]: (
      <div>
        {enabled
          ? pattern(() => ({ label }))
          : pattern(() => ({ fallback: label }))}
      </div>
    ),
  }),
);
