/**
 * Returns the document a guest is loaded as: `html`, with `script`, when there
 * is one, run as a module once the document has been parsed. An empty `html`
 * is no guest at all, as when a host clears the frame or holds it closed
 * while it prepares the guest's resources, so it stays empty and the script
 * does not run.
 *
 * The script goes in as the text of an inline module `<script>` appended to
 * the document, which the parser places at the end of the body, so the guest
 * policy admits it as it admits any inline script the document carries. The
 * element's text ends at the first `</script` however it got there, and a
 * `<!--` in it puts the parser into a state where that closing tag no longer
 * ends it, so both are escaped, as `<\/script` and `<\x21--`. A string, a
 * template, and a regular expression all read those escapes as the characters
 * they replace, so the module runs as it was written; `String.raw` is the one
 * construct that would see the difference.
 */
export function guestDocument(html: string, script?: string): string {
  if (html === "" || script === undefined || script === "") return html;
  return `${html}<script type="module">${inlineScriptText(script)}</script>`;
}

/**
 * Helper for `guestDocument()`, which escapes `script` for the text of an
 * inline `<script>` element.
 */
function inlineScriptText(script: string): string {
  return script.replaceAll(
    /<(\/script|!--)/gi,
    (_match, rest: string) => rest.startsWith("/") ? `<\\${rest}` : "<\\x21--",
  );
}
