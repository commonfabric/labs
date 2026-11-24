import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface KbdStoryInput {}
export interface KbdStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<KbdStoryInput, KbdStoryOutput>(() => {
  return {
    [NAME]: "cf-kbd Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <cf-kbd>⌘</cf-kbd>
          <cf-kbd>C</cf-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>Copy</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <cf-kbd>⌘</cf-kbd>
          <cf-kbd>V</cf-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>Paste</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <cf-kbd>⌘</cf-kbd>
          <cf-kbd>Shift</cf-kbd>
          <cf-kbd>P</cf-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            Command Palette
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <cf-kbd>Ctrl</cf-kbd>
          <cf-kbd>Alt</cf-kbd>
          <cf-kbd>Del</cf-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>
            Task Manager
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <cf-kbd>Esc</cf-kbd>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>Close</span>
        </div>
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Inline keyboard hint element for displaying
        shortcuts.
      </div>
    ),
  };
});
