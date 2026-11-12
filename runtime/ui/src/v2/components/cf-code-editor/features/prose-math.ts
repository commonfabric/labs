/**
 * Draws TeX formulas in prose mode. KaTeX sets each formula where the
 * selection is not, and the formula's TeX shows as written where it is, the
 * way prose mode treats the rest of Markdown. A `$$` formula that has its
 * lines to itself is drawn as a block, centered. The formulas are the nodes
 * `math-syntax.ts` parses.
 *
 * This module brings KaTeX and its layout rules, so the editor loads it only
 * when it first draws math, and the shell's bundle carries it in a chunk of
 * its own.
 *
 * KaTeX runs with `trust` off, so no command reaches a URL, a class or an
 * attribute of the author's choosing, with a size a formula asks for capped,
 * and with macro expansion capped.
 */

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import katex from "katex";
import { type CSSResult, unsafeCSS } from "lit";

import { KATEX_STYLES } from "./katex-styles.ts";
import { DISPLAY_MATH, INLINE_MATH } from "./math-syntax.ts";

/**
 * KaTeX's layout rules, for the shadow root of an editor that draws
 * formulas. The fonts they name are declared by the page; see
 * `docs/prose-markdown.md`.
 */
export const mathStyles: CSSResult = unsafeCSS(KATEX_STYLES);

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

/** A formula set by KaTeX, in place of its TeX. */
class MathWidget extends WidgetType {
  /** The formula's TeX, without its delimiters. */
  readonly #tex: string;

  /** Whether KaTeX sets it in display style. */
  readonly #display: boolean;

  /** Whether it is drawn as a block, in place of whole lines. */
  readonly #block: boolean;

  /**
   * Constructs an instance which draws `tex` in display style when
   * `display`, as a block in place of whole lines when `block`.
   */
  constructor(tex: string, display: boolean, block: boolean) {
    super();
    this.#tex = tex;
    this.#display = display;
    this.#block = block;
  }

  /** @inheritDoc */
  override eq(other: WidgetType): boolean {
    return other instanceof MathWidget && other.#tex === this.#tex &&
      other.#display === this.#display && other.#block === this.#block;
  }

  /**
   * Draws the formula, or, when KaTeX cannot parse it, its TeX as written
   * with KaTeX's message as the tooltip.
   */
  override toDOM(): HTMLElement {
    const element = document.createElement(this.#block ? "div" : "span");
    element.className = this.#block ? "cm-prose-math-block" : "cm-prose-math";
    try {
      // KaTeX's markup as a string rather than through `katex.render()`,
      // which refuses a document in quirks mode, as the browser test harness
      // is. With `trust` off, the markup holds nothing of the author's but
      // escaped text.
      element.innerHTML = katex.renderToString(this.#tex, {
        ...KATEX_OPTIONS,
        displayMode: this.#display,
      });
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error;
      const delimiter = this.#display ? "$$" : "$";
      element.classList.add("cm-prose-math-error");
      element.title = error.message;
      element.textContent = `${delimiter}${this.#tex}${delimiter}`;
    }
    return element;
  }

  /**
   * Lets the editor handle a click on the formula, so the click places the
   * cursor beside it, which shows its TeX.
   */
  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Builds the math decorations for `state`. A formula the selection touches,
 * while the editor has focus, keeps its TeX, marked as source; any other is
 * replaced by KaTeX's rendering. Exported for tests, which need no view.
 */
export function buildMathDecorations(
  state: EditorState,
  hasFocus: boolean,
): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  const { doc, selection } = state;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== INLINE_MATH && node.name !== DISPLAY_MATH) return;
      const display = node.name === DISPLAY_MATH;
      const delimiter = display ? 2 : 1;
      const tex = doc.sliceString(node.from + delimiter, node.to - delimiter)
        .trim();
      if (tex === "") return false;
      const first = doc.lineAt(node.from);
      const last = doc.lineAt(node.to);
      const block = display &&
        doc.sliceString(first.from, node.from).trim() === "" &&
        doc.sliceString(node.to, last.to).trim() === "";
      const from = block ? first.from : node.from;
      const to = block ? last.to : node.to;
      const touched = hasFocus &&
        selection.ranges.some((range) => range.from <= to && range.to >= from);
      decorations.push(
        touched
          ? Decoration.mark({ class: "cm-prose-math-source" }).range(
            node.from,
            node.to,
          )
          : Decoration.replace({
            widget: new MathWidget(tex, display, block),
            block,
          }).range(from, to),
      );
      return false;
    },
  });
  return decorations;
}

/** Says that the editor gained focus (`true`) or lost it. */
const setFocused = StateEffect.define<boolean>();

/**
 * Whether the editor has focus, kept where a state field can read it.
 * `focusSync` keeps it in step with the view.
 */
const focusedField = StateField.define<boolean>({
  create: () => false,
  update(focused, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFocused)) focused = effect.value;
    }
    return focused;
  },
});

/**
 * The math decorations. They come from a state field rather than a view
 * plugin, because a block formula replaces line breaks, which CodeMirror
 * accepts only from a field.
 */
const mathField = StateField.define<DecorationSet>({
  create: (state) =>
    Decoration.set(
      buildMathDecorations(state, state.field(focusedField, false) ?? false),
      true,
    ),
  update(decorations, transaction) {
    if (
      transaction.docChanged || transaction.selection !== undefined ||
      transaction.effects.some((effect) => effect.is(setFocused)) ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    ) {
      return Decoration.set(
        buildMathDecorations(
          transaction.state,
          transaction.state.field(focusedField),
        ),
        true,
      );
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Keeps `focusedField` in step with the view's focus. CodeMirror's own
 * `focusChangeEffect` is not enough: it sends its transaction a microtask
 * after the update that noticed the change, and drops it when any other
 * transaction lands first, which the editor's own updates do. This compares
 * the two after every update instead.
 */
const focusSync = ViewPlugin.fromClass(
  class {
    /** Whether a correction is queued and has not gone out yet. */
    #queued = false;

    /** Whether the view this plugin belongs to is gone. */
    #destroyed = false;

    /** Constructs an instance which corrects `view`'s field if it is wrong. */
    constructor(view: EditorView) {
      this.#check(view);
    }

    /** Corrects the field after `update` if it no longer matches focus. */
    update(update: ViewUpdate): void {
      this.#check(update.view);
    }

    /** Stops a queued correction from going out. */
    destroy(): void {
      this.#destroyed = true;
    }

    /**
     * Helper for the plugin, which queues a transaction setting the field to
     * the view's focus when the two differ. A view cannot dispatch while it
     * updates, so the transaction goes out once this update is done, and it
     * reads focus then, so it never carries a stale value.
     */
    #check(view: EditorView): void {
      if (this.#queued || view.hasFocus === view.state.field(focusedField)) {
        return;
      }
      this.#queued = true;
      queueMicrotask(() => {
        this.#queued = false;
        if (this.#destroyed) return;
        if (view.hasFocus !== view.state.field(focusedField)) {
          view.dispatch({ effects: setFocused.of(view.hasFocus) });
        }
      });
    }
  },
);

/** How a formula looks around what KaTeX draws. */
const mathTheme = EditorView.baseTheme({
  ".cm-prose-math-block": {
    padding: "0.25em 0",
    overflowX: "auto",
    overflowY: "hidden",
  },
  ".cm-prose-math-block .katex-display": {
    margin: "0",
  },
  ".cm-prose-math-error": {
    color: "var(--cf-theme-color-error)",
    fontFamily: "var(--cf-theme-font-mono, monospace)",
  },
  ".cm-prose-math-source": {
    fontFamily: "var(--cf-theme-font-mono, monospace)",
  },
});

/**
 * The editor extension that draws formulas. It needs the language to parse
 * Markdown with `mathMarkdown`; without that, it finds no formula.
 * `hasFocus` says whether the view the extension joins has focus now, so an
 * extension added to a focused view draws as focused from its first update.
 */
export function proseMath(hasFocus: boolean): Extension {
  return [focusedField.init(() => hasFocus), focusSync, mathField, mathTheme];
}
