import { NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import { Controls, TextControl } from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface EmptyStateStoryInput {}
interface EmptyStateStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

const sectionLabelStyle = {
  fontSize: "12px",
  fontWeight: "600",
  color: "#6b7280",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

export default pattern<EmptyStateStoryInput, EmptyStateStoryOutput>(() => {
  const message = new Writable("No items yet. Add one below!");

  return {
    [NAME]: "cf-empty-state Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "480px",
          display: "flex",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        <div>
          <div style={sectionLabelStyle}>Message only</div>
          <cf-empty-state message={message} />
        </div>

        <div>
          <div style={sectionLabelStyle}>With icon</div>
          <cf-empty-state>
            <span slot="icon">📋</span>
            Your shopping list is empty. Type above to add items!
          </cf-empty-state>
        </div>

        <div>
          <div style={sectionLabelStyle}>With action</div>
          <cf-empty-state>
            <span slot="icon">📚</span>
            No items yet. Add something to read!
            <cf-button slot="action" size="sm">
              Add first item
            </cf-button>
          </cf-empty-state>
        </div>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <TextControl
            label="message"
            description="Placeholder text for the message-only example"
            defaultValue="No items yet. Add one below!"
            value={message}
          />
        </>
      </Controls>
    ),
  };
});
