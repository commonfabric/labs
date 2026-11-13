/**
 * Lays out the editor's children in a margin beside its text, each one that
 * names an anchor of the field beside the line where that anchor is.
 * `../docs/margin.md` describes the arrangement.
 */

import type { Extension } from "@codemirror/state";
import {
  type EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import {
  activeHighlightAnchors,
  highlightAnchors,
  highlightField,
} from "./highlights.ts";

/** The attribute of a child of the editor naming the anchor it sits beside. */
export const MARGIN_ANCHOR_ATTRIBUTE = "data-anchor";

/**
 * A child of the editor that names an anchor, with the children after it that
 * name none, which move with it.
 */
export interface MarginGroup {
  /**
   * How far below the margin's top the text at the group's anchor is drawn,
   * or `undefined` when the field holds no such anchor.
   */
  anchorTop: number | undefined;

  /** The group's height, which is `0` for a group whose children are hidden. */
  height: number;

  /** Whether the group's anchor is where an active highlight starts. */
  active: boolean;
}

/** Where {@link placeMarginGroups} puts each group, and how tall that is. */
export interface MarginPlacement {
  /** The top of each group, in the order the groups were given. */
  tops: number[];

  /** How far down the margin the lowest group reaches. */
  height: number;
}

/**
 * Places `groups` in a margin whose top `leading` pixels hold the children
 * before the first group. A group with an anchor sits beside it, in the
 * order the anchors appear, and is moved down where it would come closer
 * than `gap` to the group above. The first active group keeps its place
 * beside its anchor where the leading children leave room for it, and the
 * groups above it move up to make way. Groups without an anchor follow the
 * others, in the order given. A group with no height takes no place, and its
 * top is `0`.
 */
export function placeMarginGroups(
  groups: readonly MarginGroup[],
  leading: number,
  gap: number,
): MarginPlacement {
  const tops = groups.map(() => 0);
  const anchored: { index: number; top: number; height: number }[] = [];
  const unanchored: { index: number; top: number; height: number }[] = [];
  let active: number | undefined;
  groups.forEach(({ anchorTop, height, active: isActive }, index) => {
    if (height <= 0) return;
    if (anchorTop === undefined) {
      unanchored.push({ index, top: 0, height });
      return;
    }
    anchored.push({ index, top: anchorTop, height });
    if (isActive && active === undefined) active = index;
  });
  // A stable sort, so groups beside one line keep the order given.
  anchored.sort((a, b) => a.top - b.top);
  const pinned = anchored.findIndex(({ index }) => index === active);
  for (let at = pinned - 1; at >= 0; at--) {
    const below = anchored[at + 1];
    anchored[at].top = Math.min(
      anchored[at].top,
      below.top - gap - anchored[at].height,
    );
  }
  let bottom = leading;
  let next = leading > 0 ? leading + gap : 0;
  for (const group of [...anchored, ...unanchored]) {
    group.top = Math.max(group.top, next);
    tops[group.index] = group.top;
    bottom = group.top + group.height;
    next = bottom + gap;
  }
  return { tops, height: bottom };
}

/** The elements the editor draws its margin with. */
export interface MarginElements {
  /** The editor element, whose children the margin shows. */
  host: HTMLElement;

  /**
   * Holds the editor's view and the margin side by side, wrapping the margin
   * below the view where the two do not fit. It has the class `has-margin`
   * while the editor has an element child.
   */
  layout: HTMLElement;

  /**
   * The margin, in the editor's shadow root: a column holding a slot for the
   * editor's children.
   */
  margin: HTMLElement;
}

/** An element of the margin, as it lies in the column before it is moved. */
interface FlowBox {
  element: HTMLElement;

  /** How far below the margin's top the column puts the element. */
  top: number;

  bottom: number;
}

/** A run of elements that moves as one, by `shift`. */
interface MovedRun {
  elements: HTMLElement[];
  shift: number;
}

/** What {@link MarginLayout} measures, and then writes. */
interface MarginMeasure {
  /** The margin's height, or `undefined` where it is left to the column. */
  height: number | undefined;
  runs: MovedRun[];
}

/**
 * The elements the margin lays out: the editor's children, each child that
 * draws no box of its own, `display: contents`, giving way to its children.
 */
function marginElements(host: Element): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (getComputedStyle(child).display === "contents") visit(child);
      else elements.push(child);
    }
  };
  visit(host);
  return elements;
}

/** How far `element`'s `translate` moves it down. */
function shiftOf(element: HTMLElement): number {
  const [, y] = getComputedStyle(element).translate.split(" ");
  return y === undefined ? 0 : Number.parseFloat(y) || 0;
}

/**
 * Moves the margin's elements beside their anchors whenever the text, its
 * layout, the anchors, or an element changes. The margin is a column, which
 * lays the elements out in their order; each run of them is then moved down
 * or up, by its `translate`, as {@link placeMarginGroups} places it.
 */
class MarginLayout implements PluginValue {
  #view: EditorView;
  #elements: MarginElements;
  #sized = new Set<Element>();
  #children: MutationObserver;
  #sizes: ResizeObserver;
  #onScroll = () => this.#schedule();

  constructor(view: EditorView, elements: MarginElements) {
    this.#view = view;
    this.#elements = elements;
    const { host, margin } = elements;
    // A host that sets an element's `style` attribute replaces the
    // `translate` this writes there, and can change its `order` or
    // `display`, so each such change places the elements again.
    this.#children = new MutationObserver((records) => {
      if (records.some(({ type }) => type === "childList")) this.#sync();
      this.#schedule();
    });
    this.#children.observe(host, {
      childList: true,
      attributes: true,
      subtree: true,
      attributeFilter: ["style", MARGIN_ANCHOR_ATTRIBUTE],
    });
    this.#sizes = new ResizeObserver(() => this.#schedule());
    this.#sizes.observe(margin);
    view.scrollDOM.addEventListener("scroll", this.#onScroll, {
      passive: true,
    });
    this.#sync();
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged || update.geometryChanged || update.viewportChanged ||
      update.startState.field(highlightField, false) !==
        update.state.field(highlightField, false)
    ) {
      this.#schedule();
    }
  }

  destroy(): void {
    this.#children.disconnect();
    this.#sizes.disconnect();
    this.#view.scrollDOM.removeEventListener("scroll", this.#onScroll);
    for (const element of marginElements(this.#elements.host)) {
      element.style.removeProperty("translate");
    }
    this.#elements.layout.classList.remove("has-margin");
  }

  /** Watches the size of each element the margin holds, and only those. */
  #sync(): void {
    const { host, layout } = this.#elements;
    const elements = new Set<Element>(marginElements(host));
    for (const element of this.#sized) {
      if (elements.has(element)) continue;
      this.#sizes.unobserve(element);
      this.#sized.delete(element);
    }
    for (const element of elements) {
      if (this.#sized.has(element)) continue;
      this.#sizes.observe(element);
      this.#sized.add(element);
    }
    layout.classList.toggle("has-margin", host.childElementCount > 0);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#sized.size === 0) return;
    this.#view.requestMeasure({
      key: this,
      read: () => this.#measure(),
      write: (measure) => this.#write(measure),
    });
  }

  /**
   * Reads where the column puts each shown element, and how far each run of
   * them moves. An element naming an anchor starts a run, and the elements
   * the column puts after it that name none join it. The elements before
   * the first run stay where the column puts them.
   */
  #measure(): MarginMeasure {
    const view = this.#view;
    const { host, margin } = this.#elements;
    const marginBox = margin.getBoundingClientRect();
    const elements = marginElements(host);
    if (marginBox.top >= view.dom.getBoundingClientRect().bottom) {
      // Wrapped below the text, the margin is the column as it stands.
      return { height: undefined, runs: [{ elements, shift: 0 }] };
    }

    const boxes: FlowBox[] = [];
    const hidden: HTMLElement[] = [];
    for (const element of elements) {
      if (element.getClientRects().length === 0) {
        hidden.push(element);
        continue;
      }
      const box = element.getBoundingClientRect();
      const top = box.top - marginBox.top - shiftOf(element);
      boxes.push({ element, top, bottom: top + box.height });
    }
    // A stable sort, so elements the column stacks at one place keep the
    // document's order.
    boxes.sort((a, b) => a.top - b.top);

    const anchors = highlightAnchors(view.state);
    const active = activeHighlightAnchors(view.state);
    let leading = 0;
    const groups: MarginGroup[] = [];
    const runs: (FlowBox & { elements: HTMLElement[] })[] = [];
    for (const box of boxes) {
      const anchor = box.element.getAttribute(MARGIN_ANCHOR_ATTRIBUTE);
      const run = runs.at(-1);
      if (anchor) {
        groups.push({
          anchorTop: Object.hasOwn(anchors, anchor)
            ? this.#textTop(anchors[anchor]) - marginBox.top
            : undefined,
          height: 0,
          active: active.has(anchor),
        });
        runs.push({ ...box, elements: [box.element] });
      } else if (run === undefined) {
        leading = Math.max(leading, box.bottom);
      } else {
        run.bottom = Math.max(run.bottom, box.bottom);
        run.elements.push(box.element);
      }
    }
    runs.forEach((run, at) => groups[at].height = run.bottom - run.top);

    const gap = Number.parseFloat(getComputedStyle(margin).rowGap) || 0;
    const { tops, height } = placeMarginGroups(groups, leading, gap);
    return {
      height,
      runs: [
        { elements: hidden, shift: 0 },
        ...runs.map(({ elements, top }, at) => ({
          elements,
          shift: tops[at] - top,
        })),
      ],
    };
  }

  /**
   * How far down the screen the text at `offset` is drawn. Text outside the
   * part of the document the view has drawn is placed at the top of its
   * line, by the height the view estimates for the lines above it.
   */
  #textTop(offset: number): number {
    const view = this.#view;
    const at = Math.min(offset, view.state.doc.length);
    return view.coordsAtPos(at, 1)?.top ??
      view.documentTop + view.lineBlockAt(at).top;
  }

  /**
   * Moves each run, writing only what differs from what is there, so that
   * the writes this observes come to rest.
   */
  #write({ height, runs }: MarginMeasure): void {
    const { margin } = this.#elements;
    const minHeight = height === undefined ? "" : `${Math.ceil(height)}px`;
    if (margin.style.minHeight !== minHeight) {
      margin.style.minHeight = minHeight;
    }
    for (const { elements, shift } of runs) {
      const rounded = Math.round(shift);
      const translate = rounded === 0 ? "" : `0px ${rounded}px`;
      for (const element of elements) {
        if (element.style.translate === translate) continue;
        if (translate === "") element.style.removeProperty("translate");
        else element.style.translate = translate;
      }
    }
  }
}

/**
 * Shows the editor's children in its margin, as {@link placeMarginGroups}
 * places them: each child whose {@link MARGIN_ANCHOR_ATTRIBUTE} names an
 * anchor of the field beside the text at that anchor, and each child that
 * names none under the child before it. Where the margin wraps below the
 * view, the children stay in the column, in their order. The margin moves a
 * child by its `translate`, which it owns.
 */
export function margin(elements: MarginElements): Extension {
  return ViewPlugin.define((view) => new MarginLayout(view, elements));
}
