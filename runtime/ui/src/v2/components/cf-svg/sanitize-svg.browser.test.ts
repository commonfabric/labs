/**
 * Tests for SVG sanitization that turn on how a browser's HTML parser reads a
 * drawing: raw text in `script` and `style`, the switch back to HTML inside
 * `desc`, recovery from an unclosed element, and the namespace a drawing lands
 * in. happy-dom's parser reads the first three differently, so these run in a
 * browser, under deno-web-test rather than `deno test`; `sanitize-svg.test.ts`
 * holds the cases any parser agrees on. The harness registers tests through
 * `Deno.test` and calls each one with no arguments, so the BDD functions the
 * rest of the repository uses are not available here.
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
