import {
  type AssetRecord,
  ASSETS_ATTRIBUTE,
  substituteAssets,
} from "./assets.ts";

/** The whitespace the parser lets stand ahead of a doctype. */
const LEADING_SPACE = /[\t\n\f\r ]/;

/**
 * Returns the document a guest is loaded as: `html`, with `assets`, and with
 * `script`, when there is one, run as a module once the document has been
 * parsed. An empty `html` is no guest at all, as when a host clears the frame
 * or holds it closed while it prepares the guest's resources, so it stays
 * empty and the script does not run.
 *
 * Each `cf-asset:<name>` in `html` is replaced with the URL of the asset of
 * that name, in the text, before anything parses it, so the parser reads the
 * URL wherever the reference stood: an attribute, a style, or an inline
 * script. A reference to a name `assets` lacks stays as it is
 * (`missingAssets()`). `script` is not searched. The record itself goes into
 * the document right after its doctype, ahead of every script, as a
 * `<script type="application/json" data-cf-assets>` element, which the browser
 * neither runs nor fetches, for `fabric.asset()` to read. Neither a name nor a
 * URL holds a `<`, but the record's JSON escapes any all the same, so nothing
 * in it can end the element. A guest with no assets gets no such element.
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
export function guestDocument(
  html: string,
  script?: string,
  assets: AssetRecord = {},
): string {
  if (html === "") return html;
  const text = withAssetsElement(substituteAssets(html, assets), assets);
  if (script === undefined || script === "") return text;
  return `${text}<script type="module">${inlineScriptText(script)}</script>`;
}

/**
 * Helper for `guestDocument()`, which writes `assets` into `html` after its
 * doctype, or at its start when it has none.
 */
function withAssetsElement(html: string, assets: AssetRecord): string {
  if (Object.keys(assets).length === 0) return html;
  const record = JSON.stringify(assets).replaceAll("<", "\\u003c");
  const element = `<script type="application/json" ${ASSETS_ATTRIBUTE}>` +
    `${record}</script>`;
  const end = leadingDoctypeEnd(html);
  return html.slice(0, end) + element + html.slice(end);
}

/**
 * Helper for `withAssetsElement()`, which returns where the doctype `html`
 * opens with ends, or, when it opens with none, where its byte order mark ends
 * (`0` without one), so that the mark stays first. Ahead of a doctype the
 * parser lets stand a byte order mark, whitespace, and comments, each comment
 * ending at its first `-->`; a doctype anywhere later is ignored. The scan
 * reads each character once.
 */
function leadingDoctypeEnd(html: string): number {
  const start = html.startsWith("\ufeff") ? 1 : 0;
  let at = start;
  for (;;) {
    while (at < html.length && LEADING_SPACE.test(html[at]!)) at++;
    if (!html.startsWith("<!--", at)) break;
    const close = html.indexOf("-->", at + 4);
    if (close === -1) return start;
    at = close + 3;
  }
  if (html.slice(at, at + 9).toLowerCase() !== "<!doctype") return start;
  const close = html.indexOf(">", at);
  return close === -1 ? start : close + 1;
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
