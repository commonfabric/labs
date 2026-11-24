/**
 * Integration test example for cf-code-editor with Cell binding.
 * Used to test cursor stability when typing with Cell sync.
 */
import { Default, NAME, pattern, UI } from "commonfabric";

interface Input {
  content: string | Default<"">;
}

export default pattern<Input>(({ content }) => {
  return {
    [NAME]: "Code Editor Test",
    [UI]: (
      <div
        id="test-container"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "16px",
        }}
      >
        <h2>Code Editor Cursor Test</h2>
        <div
          id="editor-container"
          style={{
            border: "1px solid #ccc",
            borderRadius: "8px",
            minHeight: "200px",
          }}
        >
          <cf-code-editor $value={content} language="text/markdown" />
        </div>
        <div
          id="content-display"
          style={{ padding: "8px", background: "#f5f5f5" }}
        >
          Content: {content}
        </div>
      </div>
    ),
    content,
  };
});
