/**
 * A Markdown note whose TeX math is set as you write it: `$…$` inline and
 * `$$…$$` display, drawn by KaTeX wherever the cursor is not, and shown as
 * TeX where it is, the way prose mode treats the rest of Markdown. Everyone
 * on the piece edits the one body, through the editor's collaborative mode.
 */

import { Default, NAME, pattern, UI, type VNode } from "commonfabric";

/** The note's title and body. */
export interface MathNoteInput {
  /** The note's title. */
  title?: string | Default<"Math note">;

  /** The note's body: Markdown, where `$…$` and `$$…$$` are TeX. */
  content?: string | Default<"">;
}

/** The note, and the title and body it shows. */
export interface MathNoteOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The note's title. */
  title: string;

  /** The note's body. */
  content: string;
}

export default pattern<MathNoteInput, MathNoteOutput>(
  ({ title, content }) => ({
    [NAME]: title,
    [UI]: (
      <cf-vstack
        gap="3"
        style={{ padding: "1rem", width: "100%", boxSizing: "border-box" }}
      >
        <cf-input
          $value={title}
          aria-label="Note title"
          placeholder="Math note"
        />
        <cf-code-editor
          $value={content}
          collaborative
          language="text/markdown"
          mode="prose"
          math
          wordWrap
          tabIndent
          placeholder="Write Markdown. $…$ and $$…$$ are TeX."
          style={{ minHeight: "20rem" }}
        />
      </cf-vstack>
    ),
    title,
    content,
  }),
);
