import { NAME, pattern, UI, type VNode } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface MarkdownStoryInput {}
export interface MarkdownStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<MarkdownStoryInput, MarkdownStoryOutput>(() => {
  const content = `## Markdown Rendering

This component renders **bold**, *italic*, and \`inline code\`.

- Bullet lists
- With multiple items

\`\`\`js
const greeting = "Hello from cf-markdown";
console.log(greeting);
\`\`\`

> Blockquotes are supported too.`;

  return {
    [NAME]: "cf-markdown Story",
    [UI]: (
      <div
        style={{
          padding: "1rem",
          maxWidth: "480px",
        }}
      >
        <cf-markdown content={content} />
      </div>
    ),
    controls: (
      <div style={{ color: "#6b7280", fontSize: "13px", padding: "8px 12px" }}>
        No interactive controls. Attributes: variant (default, inverse),
        streaming, compact.
      </div>
    ),
  };
});
