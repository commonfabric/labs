import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface FieldStoryInput {}
interface FieldStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<FieldStoryInput, FieldStoryOutput>(() => {
  return {
    [NAME]: "cf-field Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          maxWidth: "320px",
        }}
      >
        <cf-field label="Name">
          <cf-input placeholder="Enter full name" />
        </cf-field>
        <cf-field label="Email" required>
          <cf-input type="email" placeholder="email@example.com" />
        </cf-field>
        <cf-field
          label="Username"
          error="That username is already taken"
        >
          <cf-input placeholder="Pick a username" />
        </cf-field>
        <cf-field label="Bio" help="Shown on your public profile.">
          <cf-textarea placeholder="A few words about you" />
        </cf-field>
        <cf-text variant="caption" tone="muted" block>
          cf-field wraps any control: cf-input, cf-select, cf-textarea, etc.
          When error is set it replaces the help text.
        </cf-text>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: label, required, error, help.
      </div>
    ),
  };
});
