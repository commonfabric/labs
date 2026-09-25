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
          <cf-button
            size="sm"
            variant="ghost"
            aria-describedby="story-cats-reactors"
          >
            😺 2
          </cf-button>
          <cf-vstack id="story-cats-reactors" slot="card" gap="1">
            <cf-text>Alice</cf-text>
            <cf-text>Bob</cf-text>
          </cf-vstack>
        </cf-hover-card>
        <cf-hover-card>
          <cf-button
            size="sm"
            variant="ghost"
            aria-describedby="story-scream-reactors"
          >
            🙀 1
          </cf-button>
          <cf-text id="story-scream-reactors" slot="card">Carol</cf-text>
        </cf-hover-card>
      </div>
    ),
    controls: (
      <Controls>
        <div
          style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}
        >
          No controls. Rest the pointer on a count, or focus it, to see its
          card.
        </div>
      </Controls>
    ),
  };
});
