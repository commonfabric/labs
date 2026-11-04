// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import { NAME, pattern, UI, Writable } from "commonfabric";

/**
 * Reproduction case for cf-select not displaying initial values from backend.
 *
 * Bug: When a cf-select is bound to a cell via $value, the dropdown would show
 * the placeholder "-" instead of the actual cell value on initial page load.
 * The value was present in the cell, but the component's onChange callback
 * wasn't being called when the subscription received backend updates.
 *
 * Root cause: CellController._setupCellSubscription() only called
 * host.requestUpdate() when cell values changed, but didn't call the onChange
 * callback. Components like cf-select rely on onChange to sync their DOM state.
 *
 * Fix: In cell-controller.ts, the subscription callback now calls onChange
 * when the cell value changes from the backend.
 *
 * To test:
 * 1. Deploy this pattern with `cf piece new`
 * 2. Use CLI to set values: echo '"video"' | cf cell set --piece ID type ...
 * 3. Refresh the page - the dropdown should show "🎬 Video", not "-"
 * 4. The "Current value" text should also display "video"
 */

export interface Output {
  [NAME]: string;
  type: string;
  status: string;
}

export default pattern<Record<string, never>, Output>(() => {
  const type = new Writable<string>("article");
  const status = new Writable<string>("want");

  return {
    [NAME]: "Select Initial Value Repro",
    [UI]: (
      <cf-screen>
        <cf-vstack gap="4" style="padding: 1rem;">
          <cf-card>
            <cf-vstack gap="2">
              <cf-heading level={4}>Type Select</cf-heading>
              <cf-select
                $value={type}
                items={[
                  { label: "📄 Article", value: "article" },
                  { label: "📚 Book", value: "book" },
                  { label: "📑 Paper", value: "paper" },
                  { label: "🎬 Video", value: "video" },
                ]}
              />
              <p>
                <strong>Current value:</strong> {type}
              </p>
            </cf-vstack>
          </cf-card>

          <cf-card>
            <cf-vstack gap="2">
              <cf-heading level={4}>Status Select</cf-heading>
              <cf-select
                $value={status}
                items={[
                  { label: "Want to read", value: "want" },
                  { label: "Reading", value: "reading" },
                  { label: "Finished", value: "finished" },
                  { label: "Abandoned", value: "abandoned" },
                ]}
              />
              <p>
                <strong>Current value:</strong> {status}
              </p>
            </cf-vstack>
          </cf-card>

          <p style="color: gray; font-size: 0.875rem;">
            If either dropdown shows "-" instead of its value on page load, the
            bug is present. Both dropdowns should show their selected values
            immediately.
          </p>
        </cf-vstack>
      </cf-screen>
    ),
    type,
    status,
  };
});
