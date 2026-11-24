/**
 * Tests for SVG sanitization that hold whichever HTML parser reads the source.
 *
 * Cases that turn on how a browser's HTML parser reads markup inside a drawing
 * are in `sanitize-svg.browser.test.ts`, since happy-dom's parser reads raw
 * text in `script` and `style`, and HTML inside `desc`, differently.
 */

// First, so that `DOMParser` is there when the sanitizer runs.
import "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { sanitizeSvg } from "./sanitize-svg.ts";

/** The sanitized drawing, which each case here expects to exist. */
function sanitized(svg: string): Element {
  const result = sanitizeSvg(svg);
  if (result === null) throw new Error("expected the source to survive");
  return result;
}

/** The local names of every element in the sanitized drawing, root included. */
function elementNames(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].map((element) =>
    element.localName
  );
}

/** Every attribute in the sanitized drawing, as `name=value` pairs. */
function attributes(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((element) =>
    Array.from(
      element.attributes,
      (attribute) => `${attribute.name}=${attribute.value}`,
    )
  );
}

describe("sanitizeSvg()", () => {
  describe("elements", () => {
    it("keeps a plain drawing", () => {
      const root = sanitized(
        '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="blue"/></svg>',
      );

      expect(root.getAttribute("viewBox")).toBe("0 0 100 100");
      expect(attributes(root)).toEqual([
        "viewBox=0 0 100 100",
        "cx=50",
        "cy=50",
        "r=40",
        "fill=blue",
      ]);
    });

    it("keeps nested groups, gradients and filters", () => {
      const root = sanitized(
        '<svg><defs><linearGradient id="grad"><stop offset="0%" stop-color="red"/>' +
          '</linearGradient><filter id="blur"><feGaussianBlur stdDeviation="2"/>' +
          '</filter></defs><g id="layer1"><rect width="10" height="10"/></g></svg>',
      );

      expect(elementNames(root)).toEqual([
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

    it("drops an element that would embed foreign content", () => {
      const root = sanitized(
        '<svg><foreignObject width="100" height="100">' +
          '<div xmlns="http://www.w3.org/1999/xhtml">html content</div>' +
          "</foreignObject><circle cx='5' cy='5' r='4'/></svg>",
      );

      expect(elementNames(root)).toEqual(["svg", "circle"]);
    });

    it("drops an animation element that can retarget an attribute", () => {
      // `<animate>` writes a new value into an attribute while the drawing
      // plays, which would put a URL into an `href` after it had been checked.

      const root = sanitized(
        '<svg><a href="https://example.com">' +
          '<animate attributeName="href" to="javascript:alert(1)"/>' +
          "<text>click</text></a></svg>",
      );

      expect(elementNames(root)).toEqual(["svg", "a", "text"]);
    });

    it("drops an element it does not recognize, and everything in it", () => {
      const root = sanitized(
        "<svg><iframe src='evil.html'/><object data='evil.html'/>" +
          "<set attributeName='onclick' to='alert(1)'/>" +
          "<animateTransform attributeName='transform'/>" +
          "<g><unknown><circle r='1'/></unknown><circle cx='5' cy='5' r='4'/></g>" +
          "</svg>",
      );

      expect(elementNames(root)).toEqual(["svg", "g", "circle"]);
      expect(root.querySelector("circle")?.getAttribute("r")).toBe("4");
    });
  });

  describe("attributes", () => {
    it("drops an event-handler attribute, whatever its case", () => {
      const root = sanitized(
        '<svg onload="alert(1)"><circle onclick="alert(2)" onMouseOver="alert(3)"' +
          ' cx="50" cy="50" r="40"/></svg>',
      );

      expect(attributes(root)).toEqual(["cx=50", "cy=50", "r=40"]);
    });

    it("drops a URL that runs script", () => {
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

        expect(root.querySelector("a")?.hasAttribute("href")).toBe(false);
        expect(root.querySelector("text")?.textContent).toBe("click");
      }
    });

    it("drops a script URL in `xlink:href` and in `src`", () => {
      const root = sanitized(
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink">' +
          '<a xlink:href="javascript:alert(1)"><text>click</text></a>' +
          '<image src="javascript:alert(2)" width="10"/></svg>',
      );

      expect(attributes(root)).toEqual([
        "xmlns:xlink=http://www.w3.org/1999/xlink",
        "width=10",
      ]);
    });

    it("keeps a URL the browser may follow", () => {
      const root = sanitized(
        '<svg><a href="https://example.com"><text>click</text></a>' +
          '<image href="./picture.png" width="10" height="10"/>' +
          '<use href="#shape"/></svg>',
      );

      expect(root.querySelector("a")?.getAttribute("href")).toBe(
        "https://example.com",
      );
      expect(root.querySelector("image")?.getAttribute("href")).toBe(
        "./picture.png",
      );
      expect(root.querySelector("use")?.getAttribute("href")).toBe("#shape");
    });

    it("keeps an image carrying its own bytes", () => {
      const root = sanitized(
        '<svg><image href="data:image/png;base64,AAAA" width="10" height="10"/></svg>',
      );

      expect(root.querySelector("image")?.getAttribute("href")).toBe(
        "data:image/png;base64,AAAA",
      );
    });

    it("drops a data URL from a link, which navigates", () => {
      const root = sanitized(
        '<svg><a href="data:image/png;base64,AAAA"><text>click</text></a></svg>',
      );

      expect(root.querySelector("a")?.hasAttribute("href")).toBe(false);
    });
  });

  describe("source with no drawing", () => {
    it("returns `null` for empty or blank source", () => {
      expect(sanitizeSvg("")).toBeNull();
      expect(sanitizeSvg("   \n\t  ")).toBeNull();
    });

    it("returns `null` for a value that is not a string", () => {
      for (const value of [null, undefined, 123]) {
        // @ts-expect-error: an untyped caller can pass anything.
        expect(sanitizeSvg(value)).toBeNull();
      }
    });

    it("returns `null` for markup with no `svg` element", () => {
      expect(sanitizeSvg("<div>not svg</div>")).toBeNull();
      expect(sanitizeSvg('<circle cx="50" cy="50" r="40"/>')).toBeNull();
      expect(sanitizeSvg("<g><rect width='10' height='10'/></g>")).toBeNull();
    });
  });
});
