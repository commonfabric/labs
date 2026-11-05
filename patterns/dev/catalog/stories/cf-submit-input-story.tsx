import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface SubmitInputStoryInput {}
export interface SubmitInputStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<SubmitInputStoryInput, SubmitInputStoryOutput>(() => {
  return {
    [NAME]: "cf-submit-input Story",
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
        <cf-submit-input
          inputId="story-submit-input"
          placeholder="Your name..."
          buttonText="Create profile"
        />
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. The submit button's real (trusted) click
        bubbles to the host carrying the typed text as event.target.value, so a
        pattern reads it off the trusted gesture — unlike cf-message-input's
        synthetic cf-send event. Use it when the submit must authorize an
        owner-protected write (e.g. creating a profile).
      </div>
    ),
  };
});
