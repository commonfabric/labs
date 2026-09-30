import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, SwitchControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface HoverRevealStoryInput {}
interface HoverRevealStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const rowStyle = {
  padding: "0.5rem 0.75rem",
  borderRadius: "6px",
  border: "1px solid #e5e7eb",
};

export default pattern<HoverRevealStoryInput, HoverRevealStoryOutput>(() => {
  const revealed = new Writable(false);

  return {
    [NAME]: "cf-hover-reveal Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "480px",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <cf-hover-reveal revealed={revealed} style={rowStyle}>
          <cf-text>
            Point at this row, or tab into it, to see its actions.
          </cf-text>
          <cf-button slot="actions" size="sm" variant="ghost">
            React
          </cf-button>
          <cf-button slot="actions" size="sm" variant="ghost">
            Reply
          </cf-button>
        </cf-hover-reveal>
        <cf-hover-reveal style={rowStyle}>
          <cf-text>Each row reveals only its own actions.</cf-text>
          <cf-button slot="actions" size="sm" variant="ghost">
            React
          </cf-button>
        </cf-hover-reveal>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SwitchControl
            label="revealed"
            description="Keeps the first row's actions shown"
            defaultValue="false"
            checked={revealed}
          />
        </>
      </Controls>
    ),
  };
});
