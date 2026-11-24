/**
 * KaTeX for prose mode's math, in a module that imports nothing of the
 * editor's. The shell builds it as a script of its own and maps
 * `cf-katex-render` to that script in its page's import map, so the page
 * loads KaTeX only when an editor first draws math, and the script carries no
 * second copy of CodeMirror. `prose-math.ts` draws with `renderFormula`.
 *
 * KaTeX runs with `trust` off, so no command reaches a URL, a class or an
 * attribute of the author's choosing, with a size a formula asks for capped,
 * and with macro expansion capped.
 */

import katex from "katex";

import { KATEX_STYLES } from "./katex-styles.ts";

/** KaTeX's markup for a formula, or KaTeX's message when it cannot parse it. */
export type RenderedFormula = { html: string } | { error: string };

/**
 * KaTeX's settings. `trust` off refuses `\href`, `\url`, `\includegraphics`
 * and the `\html…` commands. `maxSize` caps a size the author writes, in ems,
 * and `maxExpand` the macro expansions in one formula, so a formula cannot
 * draw a page-sized box or loop. `strict` is off because a warning about the
 * author's TeX is not the editor's to log. The MathML half of the output is
 * for screen readers.
 */
const KATEX_OPTIONS = {
  output: "htmlAndMathml",
  throwOnError: true,
  trust: false,
  strict: "ignore",
  maxSize: 10,
  maxExpand: 1000,
} as const;

/**
 * Sets `tex` with KaTeX, in display style when `display`. Returns KaTeX's
 * markup, which holds nothing of the author's but escaped text, or KaTeX's
 * message when it cannot parse `tex`. Throws whatever else KaTeX throws.
 */
export function renderFormula(tex: string, display: boolean): RenderedFormula {
  try {
    return {
      html: katex.renderToString(tex, {
        ...KATEX_OPTIONS,
        displayMode: display,
      }),
    };
  } catch (error) {
    if (!(error instanceof katex.ParseError)) throw error;
    return { error: error.message };
  }
}

/** The rules that lay out KaTeX's markup, for an editor's shadow root. */
export { KATEX_STYLES };
