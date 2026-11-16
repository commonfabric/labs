import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import katex from "katex";

import { KATEX_STYLES, renderFormula } from "./katex-render.ts";
import { KATEX_STYLES_VERSION } from "./katex-styles.ts";

/** The markup `renderFormula` returns for `tex`, failing if it returns none. */
function htmlOf(tex: string, display = false): string {
  const rendered = renderFormula(tex, display);
  if (!("html" in rendered)) throw new Error(rendered.error);
  return rendered.html;
}

describe("katex-render", () => {
  describe("renderFormula", () => {
    it("returns KaTeX's markup for inline TeX", () => {
      const html = htmlOf("e^{i\\pi} + 1 = 0");
      expect(html).toContain('class="katex"');
      expect(html).not.toContain("katex-display");
    });

    it("returns display markup in display style", () => {
      expect(htmlOf("\\int_0^1 x\\,dx", true)).toContain("katex-display");
    });

    it("returns KaTeX's message for TeX it cannot parse", () => {
      const rendered = renderFormula("\\frac{1", false);
      expect("error" in rendered && rendered.error).toContain(
        "KaTeX parse error",
      );
    });

    it("returns no link for a formula that asks for one", () => {
      expect(htmlOf("\\href{javascript:alert(1)}{x}")).not.toMatch(/<a[\s>]/);
    });

    it("returns a size capped at 10em", () => {
      expect(htmlOf("\\rule{1000em}{1000em}")).toContain(
        "border-right-width:10em",
      );
    });
  });

  describe("KATEX_STYLES", () => {
    it("holds the stylesheet of the KaTeX release the editor imports", () => {
      expect(KATEX_STYLES_VERSION).toBe(katex.version);
      expect(KATEX_STYLES).toContain(".katex{");
    });

    it("resets KaTeX's equation counters on the editor's host", () => {
      expect(KATEX_STYLES).toContain(":host{counter-reset:katexEqnNo");
      expect(KATEX_STYLES).not.toMatch(/(^|\})body\{/);
    });
  });
});
