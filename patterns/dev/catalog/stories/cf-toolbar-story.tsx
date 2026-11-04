import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ToolbarStoryInput {}
export interface ToolbarStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToolbarStoryInput, ToolbarStoryOutput>(() => {
  return {
    [NAME]: "cf-toolbar Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Standard Toolbar
          </div>
          <div style="border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">
            <cf-toolbar>
              <cf-button slot="start" color="neutral" variant="ghost" size="sm">
                Menu
              </cf-button>
              <span slot="center" style="font-size: 13px; font-weight: 600;">
                Page Title
              </span>
              <cf-hstack slot="end" gap="2">
                <cf-button color="neutral" variant="ghost" size="sm">
                  Help
                </cf-button>
                <cf-button color="primary" variant="solid" size="sm">
                  Save
                </cf-button>
              </cf-hstack>
            </cf-toolbar>
          </div>
        </div>

        <div>
          <div
            style={{
              fontSize: "14px",
              fontWeight: "600",
              marginBottom: "8px",
              color: "#2e3438",
            }}
          >
            Dense Toolbar
          </div>
          <div style="border: 1px solid #e2e8f0; border-radius: 4px; overflow: hidden;">
            <cf-toolbar dense>
              <cf-button slot="start" color="neutral" variant="ghost" size="sm">
                Back
              </cf-button>
              <span slot="center" style="font-size: 13px; font-weight: 600;">
                Compact
              </span>
              <cf-button slot="end" color="neutral" variant="ghost" size="sm">
                Done
              </cf-button>
            </cf-toolbar>
          </div>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Slots: start, center, end. Attributes: dense,
        elevated, sticky.
      </div>
    ),
  };
});
