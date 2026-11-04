/**
 * Tests for SVG sanitization.
 *
 * These need a browser for `DOMParser`, and run under deno-web-test rather
 * than `deno test`. The harness registers tests through `Deno.test` and calls
 * each one with no arguments, so the BDD functions the rest of the repository
 * uses are not available here.
 */

import { assert, assertEquals } from "@std/assert";
import { sanitizeSvg } from "./sanitize-svg.ts";

/** The sanitized drawing, which each test here expects to exist. */
function sanitized(svg: string): Element {
  const result = sanitizeSvg(svg);
  assert(result !== null, "expected the source to survive sanitizing");
  return result;
}

/** The local names of every element in the sanitized drawing, root included. */
function elementNames(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll("*"))].map((element) =>
    element.localName
  );
}

/** Every attribute in the sanitized drawing, as `name=value` pairs. */
function attributes(root: Element): string[] {
  return [root, ...Array.from(root.querySelectorAll("*"))].flatMap((element) =>
    Array.from(element.attributes).map((attribute) =>
      `${attribute.name}=${attribute.value}`
    )
  );
}

Deno.test("sanitizeSvg keeps a plain drawing", function () {
  const root = sanitized(
    '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="blue"/></svg>',
  );

  assertEquals(root.getAttribute("viewBox"), "0 0 100 100");
  const circle = root.querySelector("circle");
  assertEquals(circle?.getAttribute("cx"), "50");
  assertEquals(circle?.getAttribute("fill"), "blue");
});

Deno.test("sanitizeSvg keeps nested groups, gradients and filters", function () {
  const root = sanitized(
    '<svg><defs><linearGradient id="grad"><stop offset="0%" stop-color="red"/>' +
      '</linearGradient><filter id="blur"><feGaussianBlur stdDeviation="2"/>' +
      '</filter></defs><g id="layer1"><rect width="10" height="10"/></g></svg>',
  );

  assertEquals(elementNames(root), [
    "svg",
    "defs",
    "linearGradient",
    "stop",
    "filter",
    "feGaussianBlur",
    "g",
    "rect",
  ]);
});

Deno.test("sanitizeSvg keeps a style element and a style attribute", function () {
  const root = sanitized(
    "<svg><style>.cls { fill: red; }</style>" +
      '<circle class="cls" style="stroke: blue;" cx="5" cy="5" r="4"/></svg>',
  );

  assertEquals(root.querySelector("style")?.textContent, ".cls { fill: red; }");
  assertEquals(
    root.querySelector("circle")?.getAttribute("style"),
    "stroke: blue;",
  );
});

Deno.test("sanitizeSvg drops a script element", function () {
  const root = sanitized(
    "<svg><script>alert('xss')</script><circle cx='5' cy='5' r='4'/></svg>",
  );

  assertEquals(elementNames(root), ["svg", "circle"]);
});

Deno.test("sanitizeSvg drops a script element nested in a group or in defs", function () {
  const root = sanitized(
    "<svg><g><script>alert(1)</script><circle cx='5' cy='5' r='4'/></g>" +
      "<defs><script>alert(2)</script></defs></svg>",
  );

  assertEquals(elementNames(root), ["svg", "g", "circle", "defs"]);
});

Deno.test("sanitizeSvg drops an element that would embed foreign content", function () {
  const root = sanitized(
    '<svg><foreignObject width="100" height="100">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">html content</div>' +
      "</foreignObject><circle cx='5' cy='5' r='4'/></svg>",
  );

  assertEquals(elementNames(root), ["svg", "circle"]);
});

Deno.test("sanitizeSvg drops an animation element that can retarget an attribute", function () {
  // `<animate>` writes a new value into an attribute while the drawing plays,
  // which would put a URL into an `href` after it had been checked.
  const root = sanitized(
    '<svg><a href="https://example.com">' +
      '<animate attributeName="href" to="javascript:alert(1)"/>' +
      "<text>click</text></a></svg>",
  );

  assertEquals(elementNames(root), ["svg", "a", "text"]);
});

Deno.test("sanitizeSvg drops an element from outside the SVG namespace", function () {
  // `desc` and `title` are the two places a drawing may hold HTML, and an
  // element that arrives there shares a local name with a drawing element it
  // is not.
  const root = sanitized(
    '<svg><desc><a href="javascript:alert(1)">x</a></desc>' +
      "<circle cx='5' cy='5' r='4'/></svg>",
  );

  assertEquals(elementNames(root), ["svg", "desc", "circle"]);
});

Deno.test("sanitizeSvg drops an element it does not recognize", function () {
  const root = sanitized(
    "<svg><iframe src='evil.html'/><object data='evil.html'/>" +
      "<set attributeName='onclick' to='alert(1)'/>" +
      "<animateTransform attributeName='transform'/>" +
      "<circle cx='5' cy='5' r='4'/></svg>",
  );

  assertEquals(elementNames(root), ["svg", "circle"]);
});

Deno.test("sanitizeSvg drops an event-handler attribute", function () {
  const root = sanitized(
    '<svg onload="alert(1)"><circle onclick="alert(2)" onMouseOver="alert(3)"' +
      ' cx="50" cy="50" r="40"/></svg>',
  );

  assertEquals(attributes(root), ["cx=50", "cy=50", "r=40"]);
});

Deno.test("sanitizeSvg drops a URL that runs script", function () {
  for (
    const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
    ]
  ) {
    const root = sanitized(
      `<svg><a href="${url}"><text>click</text></a></svg>`,
    );

    assertEquals(root.querySelector("a")?.hasAttribute("href"), false, url);
    assertEquals(root.querySelector("text")?.textContent, "click");
  }
});

Deno.test("sanitizeSvg drops a script URL in xlink:href", function () {
  const root = sanitized(
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<a xlink:href="javascript:alert(1)"><text>click</text></a></svg>',
  );

  assertEquals(
    root.querySelector("a")?.hasAttributeNS(
      "http://www.w3.org/1999/xlink",
      "href",
    ),
    false,
  );
});

Deno.test("sanitizeSvg keeps a URL the browser may follow", function () {
  const root = sanitized(
    '<svg><a href="https://example.com"><text>click</text></a>' +
      '<image href="./picture.png" width="10" height="10"/>' +
      '<use href="#shape"/></svg>',
  );

  assertEquals(
    root.querySelector("a")?.getAttribute("href"),
    "https://example.com",
  );
  assertEquals(
    root.querySelector("image")?.getAttribute("href"),
    "./picture.png",
  );
  assertEquals(root.querySelector("use")?.getAttribute("href"), "#shape");
});

Deno.test("sanitizeSvg keeps an image carrying its own bytes", function () {
  const root = sanitized(
    '<svg><image href="data:image/png;base64,AAAA" width="10" height="10"/></svg>',
  );

  assertEquals(
    root.querySelector("image")?.getAttribute("href"),
    "data:image/png;base64,AAAA",
  );
});

Deno.test("sanitizeSvg drops a data URL from a link, which navigates", function () {
  const root = sanitized(
    '<svg><a href="data:image/png;base64,AAAA"><text>click</text></a></svg>',
  );

  assertEquals(root.querySelector("a")?.hasAttribute("href"), false);
});

Deno.test("sanitizeSvg returns null for source that holds no drawing", function () {
  assertEquals(sanitizeSvg(""), null);
  assertEquals(sanitizeSvg("   \n\t  "), null);
  assertEquals(sanitizeSvg(null as any), null);
  assertEquals(sanitizeSvg(undefined as any), null);
  assertEquals(sanitizeSvg(123 as any), null);
  assertEquals(sanitizeSvg("<div>not svg</div>"), null);
});

Deno.test("sanitizeSvg returns null for a fragment with no svg element", function () {
  // A bare shape is not a drawing. Nothing paints it: an element by that name
  // outside the SVG namespace has no geometry, and the HTML parser puts one
  // there unless an `<svg>` encloses it.
  assertEquals(sanitizeSvg('<circle cx="50" cy="50" r="40"/>'), null);
  assertEquals(sanitizeSvg("<g><rect width='10' height='10'/></g>"), null);
});

Deno.test("sanitizeSvg recovers from an unclosed element", function () {
  const root = sanitized("<svg><circle cx='5' cy='5' r='4'></svg>");

  assertEquals(elementNames(root), ["svg", "circle"]);
});

Deno.test("sanitizeSvg puts a drawing that declares no namespace in the SVG namespace", function () {
  // The source a drawing arrives in often omits the declaration, and an
  // element outside the SVG namespace draws nothing.
  const root = sanitized("<svg viewBox='0 0 10 10'><rect width='5'/></svg>");

  assertEquals(root.namespaceURI, "http://www.w3.org/2000/svg");
  assertEquals(root.querySelector("rect")?.namespaceURI, root.namespaceURI);
});
