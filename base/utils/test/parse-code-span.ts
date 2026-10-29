/**
 * Test-only reader for a Markdown code span, used to check that a message
 * carrying arbitrary text still hands that text back intact.
 */

/**
 * Reads one Markdown code span: the opening and closing delimiters are
 * equal-length backtick runs, and a reader drops one leading and one trailing
 * space when the content has both and is not all spaces.
 *
 * Written from the specification rather than from `backtickQuote()`, so that a
 * round-trip test has an independent other half. A parser derived from that
 * function would agree with it whatever either one did.
 */
export function parseCodeSpan(markdown: string): string {
  const open = /^`+/.exec(markdown)?.[0];
  const close = /`+$/.exec(markdown)?.[0];

  if ((open === undefined) || (close === undefined)) {
    throw new Error(`Not a code span: ${markdown}`);
  } else if (open.length !== close.length) {
    throw new Error(`Mismatched delimiters: ${markdown}`);
  }

  const content = markdown.slice(open.length, markdown.length - close.length);

  return (content.startsWith(" ") && content.endsWith(" ") &&
      /[^ ]/.test(content))
    ? content.slice(1, -1)
    : content;
}
