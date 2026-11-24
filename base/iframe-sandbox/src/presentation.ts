/** Presentation supplied by an embedding host to a sandboxed document. */
export interface IframePresentation {
  /** CSS installed before the guest's own styles. */
  readonly css: string;

  /** Root `data-*` attributes used by the stylesheet's selectors. */
  readonly attributes: Readonly<Record<`data-${string}`, string>>;

  /** Stylesheet URLs, subject to the guest's Content Security Policy. */
  readonly stylesheets: readonly string[];
}
