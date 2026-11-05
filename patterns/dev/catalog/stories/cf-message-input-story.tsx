import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface MessageInputStoryInput {}
export interface MessageInputStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<MessageInputStoryInput, MessageInputStoryOutput>(() => {
  return {
    [NAME]: "cf-message-input Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "400px",
        }}
      >
        <cf-message-input placeholder="Type a message..." button-text="Send" />
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Fires cf-send on button click or Enter.
        Shift+Enter for newline.
      </div>
    ),
  };
});
