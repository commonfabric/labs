import { css } from "lit";

export const styles = css`
  :host {
    --cf-code-editor-border-color: var(--cf-theme-color-border, #e5e7eb);
    --cf-code-editor-border-radius: var(--cf-theme-border-radius, 0.375rem);
    --cf-code-editor-font-size: var(
      --cf-theme-font-size,
      var(--cf-font-body-size, 0.875rem)
    );
    --cf-code-editor-font-family-mono: var(
      --cf-theme-mono-font-family,
      monospace
    );
    --cf-code-editor-font-family-prose: var(
      --cf-theme-font-family,
      var(
        --cf-font-family-sans,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Roboto,
        sans-serif
      )
    );
    --cf-code-editor-prose-font-size: var(
      --cf-theme-font-size,
      var(--cf-font-body-large-size, 1rem)
    );
    --cf-code-editor-focus-ring: color-mix(
      in srgb,
      var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 16%,
      transparent
    );
    --cf-code-editor-transition-duration: var(
      --cf-theme-animation-duration,
      var(--cf-transition-duration-fast, 150ms)
    );
    --cf-code-editor-transition-ease: var(--cf-transition-timing-ease, ease);

    --cf-code-editor-color-neutral-50: var(
      --cf-colors-gray-100,
      #f2f3f6
    );
    --cf-code-editor-color-neutral-100: var(
      --cf-colors-gray-200,
      #eceef1
    );
    --cf-code-editor-color-neutral-200: var(
      --cf-colors-gray-300,
      #d5d7dd
    );
    --cf-code-editor-color-neutral-400: var(
      --cf-colors-gray-500,
      #94979e
    );
    --cf-code-editor-color-neutral-500: var(
      --cf-colors-gray-600,
      #5b5f65
    );

    --cf-code-editor-color-primary-50: color-mix(
      in srgb,
      var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 8%,
      transparent
    );
    --cf-code-editor-color-primary-100: color-mix(
      in srgb,
      var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 15%,
      transparent
    );
    --cf-code-editor-color-primary-200: color-mix(
      in srgb,
      var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 25%,
      transparent
    );
    --cf-code-editor-color-primary-300: color-mix(
      in srgb,
      var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 40%,
      transparent
    );
    --cf-code-editor-color-primary-600: var(
      --cf-theme-color-primary,
      var(--cf-colors-primary-600, #3e6af7)
    );
    --cf-code-editor-color-primary-700: var(
      --cf-theme-color-primary,
      var(--cf-colors-primary-700, #376bf9)
    );

    --cf-code-editor-color-warning-100: color-mix(
      in srgb,
      var(--cf-theme-color-warning, var(--cf-colors-warning, #e5a126)) 15%,
      transparent
    );
    --cf-code-editor-color-warning-400: var(
      --cf-theme-color-warning,
      var(--cf-colors-warning, #e5a126)
    );
    --cf-code-editor-color-warning-700: color-mix(
      in srgb,
      var(--cf-theme-color-warning, var(--cf-colors-warning, #e5a126)) 72%,
      var(--cf-theme-color-text, var(--cf-colors-gray-900, #16181d))
    );

    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: var(--cf-code-editor-min-height, 200px);
  }

  .code-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    width: 100%;
  }

  .cm-editor {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: 1px solid var(--cf-code-editor-border-color, #e5e7eb);
    border-radius: var(--cf-code-editor-border-radius, 0.375rem);
    display: flex;
    flex-direction: column;
    font-size: var(--cf-code-editor-font-size, 0.875rem);
    font-family: var(--cf-code-editor-font-family-mono, monospace);
  }

  .cm-scroller {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .cm-editor.cm-focused {
    outline: none;
    box-shadow: 0 0 0 3px
      var(--cf-code-editor-focus-ring, hsla(212, 100%, 47%, 0.1));
  }

  /* Ensure the editor takes full height */
  .cm-content {
    min-height: 100%;
  }

  /* Prose mode - remove border and focus ring on outer wrapper */
  :host([mode="prose"]) .cm-editor {
    border: none;
    font-family: var(--cf-code-editor-font-family-prose, sans-serif);
    font-size: var(--cf-code-editor-prose-font-size, 1rem);
  }

  :host([mode="prose"]) .cm-editor.cm-focused {
    box-shadow: none;
  }

  /* Prose markdown styles - scoped to prose mode */
  :host([mode="prose"]) .cm-prose-h1 {
    font-size: 1.75em;
    font-weight: 700;
    line-height: 1.3;
  }

  :host([mode="prose"]) .cm-prose-h2 {
    font-size: 1.4em;
    font-weight: 600;
    line-height: 1.3;
  }

  :host([mode="prose"]) .cm-prose-h3 {
    font-size: 1.15em;
    font-weight: 600;
    line-height: 1.4;
  }

  :host([mode="prose"]) .cm-prose-h4 {
    font-size: 1em;
    font-weight: 600;
    line-height: 1.4;
  }

  :host([mode="prose"]) .cm-prose-h5 {
    font-size: 0.925em;
    font-weight: 600;
    line-height: 1.4;
  }

  :host([mode="prose"]) .cm-prose-h6 {
    font-size: 0.85em;
    font-weight: 600;
    line-height: 1.4;
  }

  :host([mode="prose"]) .cm-prose-bold {
    font-weight: 700;
  }

  :host([mode="prose"]) .cm-prose-italic {
    font-style: italic;
  }

  :host([mode="prose"]) .cm-prose-bullet {
    color: var(--cf-code-editor-color-neutral-400, hsl(0, 0%, 60%));
    padding-right: 0.4em;
  }

  :host([mode="prose"]) .cm-prose-checkbox {
    margin: 0 0.4em 0 0;
    cursor: pointer;
    vertical-align: middle;
  }

  :host([mode="prose"]) .cm-prose-task-checked {
    text-decoration: line-through;
    color: var(--cf-code-editor-color-neutral-400, hsl(0, 0%, 60%));
  }

  :host([mode="prose"]) .cm-prose-footnote {
    color: var(--cf-code-editor-color-primary-600, hsl(212, 72%, 48%));
    font-size: 0.75em;
    padding-left: 1px;
  }

  :host([mode="prose"]) .cm-prose-link {
    color: var(--cf-code-editor-color-primary-600, hsl(212, 72%, 48%));
    text-decoration: underline;
    text-decoration-color: var(
      --cf-code-editor-color-primary-300,
      hsla(212, 72%, 48%, 0.4)
    );
    text-underline-offset: 2px;
  }

  :host([mode="prose"]) .cm-prose-inline-code {
    font-family: var(--cf-code-editor-font-family-mono, monospace);
    font-size: 0.9em;
    background-color: var(--cf-code-editor-color-neutral-100, hsl(0, 0%, 95%));
    border-radius: 3px;
    padding: 0.1em 0.3em;
  }

  :host([mode="prose"]) .cm-prose-codeblock {
    background-color: var(--cf-code-editor-color-neutral-100, hsl(0, 0%, 95%));
    font-family: var(--cf-code-editor-font-family-mono, monospace);
    font-size: 0.9em;
  }

  :host([mode="prose"]) .cm-prose-blockquote {
    border-left: 3px solid
      var(--cf-code-editor-color-neutral-200, hsl(0, 0%, 88%));
    padding-left: 1em !important;
    color: var(--cf-code-editor-color-neutral-500, hsl(0, 0%, 45%));
  }

  :host([mode="prose"]) .cm-prose-hr {
    border: none;
    border-top: 1px solid
      var(--cf-code-editor-color-neutral-200, hsl(0, 0%, 88%));
    margin: 0;
  }

  :host([mode="prose"]) .cm-prose-list-number {
    color: var(--cf-code-editor-color-neutral-400, hsl(0, 0%, 60%));
    padding-right: 0.4em;
  }

  :host([mode="prose"]) .cm-prose-strikethrough {
    text-decoration: line-through;
  }

  /* Table styling - line-based approach */
  :host([mode="prose"]) .cm-prose-table-row {
    display: grid !important;
    grid-template-columns: repeat(var(--table-cols, 3), minmax(0, 1fr));
    border-left: 1px solid
      var(--cf-code-editor-color-neutral-200, hsl(0, 0%, 88%));
    border-right: 1px solid
      var(--cf-code-editor-color-neutral-200, hsl(0, 0%, 88%));
    border-bottom: 1px solid
      var(--cf-code-editor-color-neutral-200, hsl(0, 0%, 88%));
  }

  :host([mode="prose"]) .cm-prose-table-header {
    border-top: 1px solid
      var(--cf-code-editor-color-neutral-200, hsl(0, 0%, 88%));
    background-color: var(--cf-theme-color-surface, #f2f3f6);
    color: var(--cf-theme-color-text, #111827);
    font-weight: 600;
  }

  :host([mode="prose"]) .cm-prose-table-cell {
    padding: 0.35em 0.75em;
  }

  /* Hidden delimiters and their caret buffers must not occupy grid cells. */
  :host([mode="prose"]) .cm-prose-table-row > :not(.cm-prose-table-cell) {
    display: none;
  }

  :host([mode="prose"]) .cm-prose-table-separator {
    height: 0 !important;
    overflow: hidden;
    font-size: 0;
    line-height: 0;
    padding: 0 !important;
  }

  /* Backlink styling - focus-aware display */
  .cm-content .cm-line {
    position: relative;
  }

  /* Collapsed pill view - a resolved mention in either form (click to navigate) */
  .cm-backlink-pill,
  .cm-mention-ref-pill {
    background-color: var(
      --cf-code-editor-color-primary-100,
      hsla(212, 100%, 47%, 0.15)
    );
    color: var(--cf-code-editor-color-primary-700, hsl(212, 80%, 40%));
    border-radius: 9999px;
    padding: 0.125rem 0.5rem;
    cursor: pointer;
    font-weight: 500;
    text-decoration: none;
    transition: background-color
      var(--cf-code-editor-transition-duration, 150ms)
      var(--cf-code-editor-transition-ease, ease);
  }

  .cm-backlink-pill:hover,
  .cm-mention-ref-pill:hover {
    background-color: var(
      --cf-code-editor-color-primary-200,
      hsla(212, 100%, 47%, 0.25)
    );
  }

  /* What the mention universe calls a destination, beside its label.
    Generated content, because the document's own text is the label alone:
    a reference's spelling is computed where it is read and never stored. */
  .cm-mention-ref-pill[data-short-name]::after {
    content: attr(data-short-name);
    margin-left: 0.375rem;
    opacity: 0.65;
    font-variant-numeric: tabular-nums;
  }

  /* Pending pill - incomplete backlink without ID */
  .cm-backlink-pending {
    background-color: var(
      --cf-code-editor-color-warning-100,
      hsla(45, 100%, 50%, 0.15)
    );
    color: var(--cf-code-editor-color-warning-700, hsl(45, 80%, 35%));
    border-radius: 9999px;
    padding: 0.125rem 0.5rem;
    cursor: text;
    font-weight: 500;
    text-decoration: none;
    border: 1px dashed
      var(--cf-code-editor-color-warning-400, hsl(45, 70%, 50%));
  }

  /* Editing view - full [[Name (id)]] format visible (for incomplete backlinks) */
  .cm-backlink-editing {
    background-color: var(
      --cf-code-editor-focus-ring,
      hsla(212, 100%, 47%, 0.1)
    );
    border-radius: 0.25rem;
    padding: 0.125rem 0.25rem;
    text-decoration: none;
  }

  /* Editing mode for name-only view (complete backlinks) */
  .cm-backlink-editing-name {
    background-color: var(
      --cf-code-editor-color-primary-100,
      hsla(212, 100%, 47%, 0.15)
    );
    color: var(--cf-code-editor-color-primary-700, hsl(212, 80%, 40%));
    border-radius: 0;
    padding: 0.125rem 0;
    font-weight: 500;
    text-decoration: none;
  }

  /* Editing mode bracket styling - shows [[ and ]] */
  .cm-backlink-editing-bracket {
    color: var(--cf-code-editor-color-neutral-400, hsl(0, 0%, 60%));
    font-weight: normal;
    background-color: var(
      --cf-code-editor-color-primary-50,
      hsla(212, 100%, 47%, 0.08)
    );
  }

  /* Adjacent mode - cursor next to pill, show [[Name]] with visible brackets */
  .cm-backlink-adjacent-bracket {
    color: var(--cf-code-editor-color-neutral-400, hsl(0, 0%, 60%));
    font-weight: normal;
  }

  .cm-backlink-adjacent-name {
    background-color: var(
      --cf-code-editor-color-primary-100,
      hsla(212, 100%, 47%, 0.15)
    );
    color: var(--cf-code-editor-color-primary-700, hsl(212, 80%, 40%));
    border-radius: 0.25rem;
    padding: 0.125rem 0.25rem;
    font-weight: 500;
    box-shadow: 0 0 0 1px
      var(--cf-code-editor-color-primary-200, hsla(212, 100%, 47%, 0.2));
  }

  /* Legacy fallback - keep for any old usages */
  .cm-backlink {
    background-color: var(
      --cf-code-editor-focus-ring,
      hsla(212, 100%, 47%, 0.1)
    );
    border-radius: 0.25rem;
    padding: 0.125rem 0.25rem;
    cursor: pointer;
    transition: background-color
      var(--cf-code-editor-transition-duration, 150ms)
      var(--cf-code-editor-transition-ease, ease);
  }

  .cm-backlink:hover {
    background-color: var(
      --cf-code-editor-color-primary-200,
      hsla(212, 100%, 47%, 0.2)
    );
  }
`;
