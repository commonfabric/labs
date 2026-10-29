import { action, Default, NAME, pattern, UI, Writable } from "commonfabric";

interface Input {
  content: Writable<string | Default<"">>;
}

export default pattern<Input>(({ content }) => {
  const replaceContent = action(() => content.set("random string"));

  return {
    [NAME]: "Collaborative Code Editor Test",
    [UI]: (
      <div style={{ padding: "16px" }}>
        <cf-code-editor
          $value={content}
          collaborative
          language="text/markdown"
          style="min-height: 12rem;"
        />
        <cf-button id="replace-content" onClick={replaceContent}>
          Replace content
        </cf-button>
        <div id="materialized-content">{content}</div>
      </div>
    ),
    content,
  };
});
