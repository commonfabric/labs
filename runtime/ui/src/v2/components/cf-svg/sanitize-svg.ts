/**
 * Turns SVG source into an element that is safe to put in a document.
 *
 * The guarantee is that nothing in the source runs script. An element survives
 * only if it appears in the allowlist below, so an element nobody anticipated
 * is dropped rather than kept; an attribute whose name begins with `on` is
 * removed; and a URL-valued attribute keeps its value only when the scheme
 * allowlist in `safe-url.ts` accepts it.
 *
 * The element that comes back is inserted as a node. Nothing serializes it
 * back to a string, so no second parse can read the sanitized tree differently
 * from the way this function left it.
 *
 * The guarantee does not extend to the network: a drawing may reference an
 * image or a font, and displaying it fetches what it references.
 */

import { safeImageUrl, safeUrl } from "../../core/safe-url.ts";

/**
 * The elements a drawing is built from.
 *
 * The list leaves out three groups on purpose. `script` runs code. `animate`,
 * `animateMotion`, `animateTransform` and `set` retarget an attribute while the
 * drawing plays, which would let a drawing write a `javascript:` URL into an
 * attribute this function had already checked. `foreignObject` opens a window
 * back into HTML, where everything the list excludes becomes available again.
 *
 * `style` is the one entry that paints nothing, and it is here because a
 * drawing exported from a design tool routinely carries its fills in a
 * stylesheet rather than on each shape, and drops to black without it. CSS
 * runs no script, so it does not cost the guarantee above. It can name a URL,
 * which the network caveat above already covers and which this function does
 * not read: a `url()` inside a stylesheet is not an attribute value.
 */
const ALLOWED_ELEMENTS = new Set([
  "a",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feconvolvematrix",
  "fediffuselighting",
  "fedisplacementmap",
  "fedistantlight",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "feimage",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "fepointlight",
  "fespecularlighting",
  "fespotlight",
  "fetile",
  "feturbulence",
  "filter",
  "g",
  "image",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "metadata",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "svg",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tspan",
  "use",
]);

/** The attributes that name something for the browser to fetch or follow. */
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src"]);

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function sanitizeElement(element: Element): void {
  for (const child of Array.from(element.children)) {
    if (
      child.namespaceURI !== SVG_NAMESPACE ||
      !ALLOWED_ELEMENTS.has(child.localName.toLowerCase())
    ) {
      child.remove();
      continue;
    }
    sanitizeElement(child);
  }

  // A link navigates, so it is held to the schemes a document may point at.
  // Everything else with a URL loads a drawing, which may carry its own bytes.
  const checkUrl = element.localName.toLowerCase() === "a"
    ? safeUrl
    : safeImageUrl;
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const dangerous = name.startsWith("on") ||
      (URL_ATTRIBUTES.has(name) && checkUrl(attribute.value) === null);
    if (dangerous) element.removeAttributeNode(attribute);
  }
}

/**
 * Parses and sanitizes SVG source, returning the drawing it describes.
 *
 * Returns `null` when the source holds no drawing.
 *
 * The source is read by the HTML parser, which puts a drawing in the SVG
 * namespace whether or not the source declares one, and which recovers from
 * markup that an XML parser would reject. The document it builds has no
 * browsing context: nothing in it runs, and nothing in it loads, before this
 * function has finished with it.
 */
export function sanitizeSvg(svgString: string): Element | null {
  if (typeof svgString !== "string" || svgString.trim() === "") return null;

  const doc = new DOMParser().parseFromString(svgString, "text/html");
  const root = doc.body.querySelector("svg");
  if (root === null || root.namespaceURI !== SVG_NAMESPACE) return null;

  sanitizeElement(root);
  return root;
}
