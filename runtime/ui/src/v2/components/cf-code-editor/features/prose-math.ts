/**
 * Draws TeX formulas in prose mode. KaTeX sets each formula where the
 * selection is not, and the formula's TeX shows as written where it is, the
 * way prose mode treats the rest of Markdown. A `$$` formula that has its
 * lines to itself is drawn as a block, centered. The formulas are the nodes
 * `math-syntax.ts` parses.
 *
 * Nothing here imports KaTeX. The editor loads it, from `katex-render.ts`,
 * when it first draws math, and hands `proseMath()` its `renderFormula`.
 */

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
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

import type { RenderedFormula } from "./katex-render.ts";
import { DISPLAY_MATH, INLINE_MATH } from "./math-syntax.ts";

/** Sets a formula's TeX, in display style when `display`. */
export type FormulaRenderer = (
  tex: string,
  display: boolean,
) => RenderedFormula;

/**
 * What sets the formulas, as `proseMath()` was given it. A state without one
 * draws each formula as KaTeX's refusal would, so a test building decorations
 * needs none.
 */
const formulaRenderer = Facet.define<FormulaRenderer, FormulaRenderer>({
  combine: (renderers) =>
    renderers[0] ?? (() => ({ error: "No renderer draws formulas here." })),
});

/** A formula set by KaTeX, in place of its TeX. */
class MathWidget extends WidgetType {
  /** The formula's TeX, without its delimiters. */
  readonly #tex: string;

  /** Whether KaTeX sets it in display style. */
  readonly #display: boolean;

  /** Whether it is drawn as a block, in place of whole lines. */
  readonly #block: boolean;

  /** What sets it. */
  readonly #render: FormulaRenderer;

  /**
   * Constructs an instance which draws `tex` with `render`, in display style
   * when `display`, as a block in place of whole lines when `block`.
   */
  constructor(
    tex: string,
    display: boolean,
    block: boolean,
    render: FormulaRenderer,
  ) {
    super();
    this.#tex = tex;
    this.#display = display;
    this.#block = block;
    this.#render = render;
  }

  /** @inheritDoc */
  override eq(other: WidgetType): boolean {
    return other instanceof MathWidget && other.#tex === this.#tex &&
      other.#display === this.#display && other.#block === this.#block &&
      other.#render === this.#render;
  }

  /**
   * Draws the formula, or, when KaTeX cannot parse it, its TeX as written
   * with KaTeX's message as the tooltip.
   */
  override toDOM(): HTMLElement {
    const element = document.createElement(this.#block ? "div" : "span");
    element.className = this.#block ? "cm-prose-math-block" : "cm-prose-math";
    const rendered = this.#render(this.#tex, this.#display);
    if ("html" in rendered) {
      // With `trust` off, KaTeX's markup holds nothing of the author's but
      // escaped text.
      element.innerHTML = rendered.html;
    } else {
      const delimiter = this.#display ? "$$" : "$";
      element.classList.add("cm-prose-math-error");
      element.title = rendered.error;
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

/** A formula in the document, with what drawing it needs. */
interface Formula {
  /** Where its syntax node starts, at its opening delimiter. */
  from: number;

  /** Where its syntax node ends, after its closing delimiter. */
  to: number;

  /** Where the range its widget replaces starts: a block's first line. */
  drawnFrom: number;

  /** Where the range its widget replaces ends: a block's last line. */
  drawnTo: number;

  /** Its TeX, without its delimiters or the space inside them. */
  tex: string;

  /** Whether it is `$$` math, set in display style. */
  display: boolean;

  /** Whether it has its lines to itself, and is drawn as a block. */
  block: boolean;
}

/** The formulas of `state`'s syntax tree, in document order. */
function findFormulas(state: EditorState): Formula[] {
  const formulas: Formula[] = [];
  const { doc } = state;
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== INLINE_MATH && node.name !== DISPLAY_MATH) return;
      const display = node.name === DISPLAY_MATH;
      const delimiter = display ? 2 : 1;
      // A formula running over a container's lines holds that container's
      // markup at the start of each line after its first, such as a
      // blockquote's `>`. The parser makes each one a child of the formula,
      // and it is Markdown, not TeX, so the TeX is the text around them.
      let tex = "";
      let start = node.from + delimiter;
      const child = node.node.cursor();
      if (child.firstChild()) {
        do {
          if (child.name === "MathMark") continue;
          tex += doc.sliceString(start, child.from);
          start = child.to;
        } while (child.nextSibling());
      }
      tex = (tex + doc.sliceString(start, node.to - delimiter)).trim();
      if (tex === "") return false;
      const first = doc.lineAt(node.from);
      const last = doc.lineAt(node.to);
      const block = display &&
        doc.sliceString(first.from, node.from).trim() === "" &&
        doc.sliceString(node.to, last.to).trim() === "";
      formulas.push({
        from: node.from,
        to: node.to,
        drawnFrom: block ? first.from : node.from,
        drawnTo: block ? last.to : node.to,
        tex,
        display,
        block,
      });
      return false;
    },
  });
  return formulas;
}

/**
 * Helper for the math field, which draws `formulas` for `state`. A formula the
 * selection touches, while the editor has focus, keeps its TeX, marked as
 * source; any other is replaced by its rendering.
 */
function drawFormulas(
  formulas: readonly Formula[],
  state: EditorState,
  hasFocus: boolean,
): Range<Decoration>[] {
  const render = state.facet(formulaRenderer);
  return formulas.map((formula) => {
    const touched = hasFocus &&
      state.selection.ranges.some((range) =>
        range.from <= formula.drawnTo && range.to >= formula.drawnFrom
      );
    return touched
      ? Decoration.mark({ class: "cm-prose-math-source" }).range(
        formula.from,
        formula.to,
      )
      : Decoration.replace({
        widget: new MathWidget(
          formula.tex,
          formula.display,
          formula.block,
          render,
        ),
        block: formula.block,
      }).range(formula.drawnFrom, formula.drawnTo);
  });
}

/**
 * Builds the math decorations for `state`. A formula the selection touches,
 * while the editor has focus, keeps its TeX, marked as source; any other is
 * replaced by its rendering. Exported for tests, which need no view.
 */
export function buildMathDecorations(
  state: EditorState,
  hasFocus: boolean,
): Range<Decoration>[] {
  return drawFormulas(findFormulas(state), state, hasFocus);
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

/** What the math field holds. */
interface MathState {
  /** The document's formulas, found when it or its parse last changed. */
  formulas: readonly Formula[];

  /** How they are drawn for the current selection and focus. */
  decorations: DecorationSet;
}

/**
 * The math decorations. They come from a state field rather than a view
 * plugin, because a block formula replaces line breaks, which CodeMirror
 * accepts only from a field. The field walks the syntax tree only when the
 * document, its parse or the renderer changes; a change of selection or
 * focus draws again from the formulas it found.
 */
const mathField = StateField.define<MathState>({
  create(state) {
    const formulas = findFormulas(state);
    const hasFocus = state.field(focusedField, false) ?? false;
    return {
      formulas,
      decorations: Decoration.set(
        drawFormulas(formulas, state, hasFocus),
        true,
      ),
    };
  },
  update(value, transaction) {
    const { startState, state } = transaction;
    const found = transaction.docChanged ||
      syntaxTree(startState) !== syntaxTree(state) ||
      startState.facet(formulaRenderer) !== state.facet(formulaRenderer);
    if (
      !found && transaction.selection === undefined &&
      !transaction.effects.some((effect) => effect.is(setFocused))
    ) {
      return value;
    }
    const formulas = found ? findFormulas(state) : value.formulas;
    return {
      formulas,
      decorations: Decoration.set(
        drawFormulas(formulas, state, state.field(focusedField)),
        true,
      ),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
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
  // A `$$` formula inside a sentence keeps display style but sits in the
  // line, where KaTeX's display wrapper would break it and center it.
  ".cm-prose-math .katex-display, .cm-prose-math .katex-display > .katex": {
    display: "inline-block",
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
 * The editor extension that draws formulas with `render`. It needs the
 * language to parse Markdown with `mathMarkdown`; without that, it finds no
 * formula. `hasFocus` says whether the view the extension joins has focus
 * now, so an extension added to a focused view draws as focused from its
 * first update.
 */
export function proseMath(
  hasFocus: boolean,
  render: FormulaRenderer,
): Extension {
  return [
    formulaRenderer.of(render),
    focusedField.init(() => hasFocus),
    focusSync,
    mathField,
    mathTheme,
  ];
}
