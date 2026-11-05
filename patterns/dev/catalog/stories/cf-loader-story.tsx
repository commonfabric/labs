import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";
import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface LoaderStoryInput {}
export interface LoaderStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<LoaderStoryInput, LoaderStoryOutput>(() => {
  const showElapsed = new Writable(false);

  return {
    [NAME]: "cf-loader Story",
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
              marginBottom: "12px",
              color: "#2e3438",
            }}
          >
            Sizes
          </div>
          <div style={{ display: "flex", gap: "24px", alignItems: "center" }}>
            <cf-vstack gap="1" align="center">
              <cf-loader size="sm" show-elapsed={showElapsed} />
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                sm
              </span>
            </cf-vstack>
            <cf-vstack gap="1" align="center">
              <cf-loader size="md" show-elapsed={showElapsed} />
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                md
              </span>
            </cf-vstack>
            <cf-vstack gap="1" align="center">
              <cf-loader size="lg" show-elapsed={showElapsed} />
              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                lg
              </span>
            </cf-vstack>
          </div>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="show-elapsed"
          description="Show elapsed time"
          defaultValue="false"
          checked={showElapsed}
        />
      </Controls>
    ),
  };
});
