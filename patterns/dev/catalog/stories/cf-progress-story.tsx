import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ProgressStoryInput {}
export interface ProgressStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ProgressStoryInput, ProgressStoryOutput>(() => {
  const indeterminate = new Writable(false);

  return {
    [NAME]: "cf-progress Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        <cf-vstack gap="1">
          <span style="font-weight: 600;">Interactive</span>
          <cf-progress value={65} max={100} indeterminate={indeterminate} />
        </cf-vstack>

        <cf-vstack gap="1">
          <span style="font-weight: 600;">Various Values</span>
          <cf-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500); width: 30px;">
              0%
            </span>
            <div style={{ flex: "1" }}>
              <cf-progress value={0} max={100} />
            </div>
          </cf-hstack>
          <cf-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500); width: 30px;">
              25%
            </span>
            <div style={{ flex: "1" }}>
              <cf-progress value={25} max={100} />
            </div>
          </cf-hstack>
          <cf-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500); width: 30px;">
              50%
            </span>
            <div style={{ flex: "1" }}>
              <cf-progress value={50} max={100} />
            </div>
          </cf-hstack>
          <cf-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500); width: 30px;">
              75%
            </span>
            <div style={{ flex: "1" }}>
              <cf-progress value={75} max={100} />
            </div>
          </cf-hstack>
          <cf-hstack gap="2" align="center">
            <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500); width: 30px;">
              100%
            </span>
            <div style={{ flex: "1" }}>
              <cf-progress value={100} max={100} />
            </div>
          </cf-hstack>
        </cf-vstack>

        <cf-vstack gap="1">
          <span style="font-weight: 600;">Indeterminate</span>
          <cf-progress indeterminate />
        </cf-vstack>
      </div>
    ),
    controls: (
      <Controls>
        <SwitchControl
          label="indeterminate"
          description="Show indeterminate animation (interactive bar)"
          defaultValue="false"
          checked={indeterminate}
        />
      </Controls>
    ),
  };
});
