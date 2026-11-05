import { CFMarkdown } from "./cf-markdown.ts";

if (!customElements.get("cf-markdown")) {
  customElements.define("cf-markdown", CFMarkdown);
}

export type { CFMarkdown as CFMarkdownElement } from "./cf-markdown.ts";

export { CFMarkdown };
export type { MarkdownVariant } from "./cf-markdown.ts";
