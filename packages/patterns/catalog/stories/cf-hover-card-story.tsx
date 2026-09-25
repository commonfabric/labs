import { NAME, pattern, UI, type VNode } from "commonfabric";

import { Controls } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface HoverCardStoryInput {}
interface HoverCardStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<HoverCardStoryInput, HoverCardStoryOutput>(() => {
  return {
    [NAME]: "cf-hover-card Story",
    [UI]: (
      <div
        style={{
          padding: "4rem 1rem 1rem",
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
        }}
      >
        <cf-hover-card>
          <cf-button size="sm" variant="ghost">😺 2</cf-button>
          <cf-vstack slot="card" gap="1">
            <cf-text>Alice</cf-text>
            <cf-text>Bob</cf-text>
          </cf-vstack>
        </cf-hover-card>
        <cf-hover-card>
          <cf-button size="sm" variant="ghost">🙀 1</cf-button>
          <cf-text slot="card">Carol</cf-text>
        </cf-hover-card>
      </div>
    ),
    controls: (
      <Controls>
        <></>
      </Controls>
    ),
  };
});
