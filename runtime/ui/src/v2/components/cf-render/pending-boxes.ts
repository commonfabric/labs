/** Pending presentation follows computed display boxes without changing render semantics. */

const PENDING = '[data-cf-pending="true"]';
const BOX_ATTRIBUTE = "data-cf-pending-box";
const TEXT_HIGHLIGHT = "cf-render-pending-text";

/**
 * Tracks first light-DOM boxes beneath the renderer's semantic pending marks.
 * A boxless custom element's private shadow content owns its own presentation.
 */
export function watchPendingBoxes(container: HTMLElement): {
  readonly container: HTMLElement;
  refresh(): void;
  dispose(): void;
} {
  const view = container.ownerDocument.defaultView;
  if (!view) throw new Error("Pending presentation requires a document window");
  let owned = new Set<Element>();
  // Text directly inside display: contents has no element box to dim. Keep
  // the renderer's text nodes in place: it reuses them for later patches.
  const ranges = new Map<Text, Range>();
  const highlightText = (nodes: Set<Text>): void => {
    const registry = view.CSS?.highlights;
    if (!registry) return;
    let highlight = registry.get(TEXT_HIGHLIGHT);
    for (const [node, range] of ranges) {
      if (nodes.has(node)) continue;
      highlight?.delete(range);
      ranges.delete(node);
    }
    for (const node of nodes) {
      if (!highlight) {
        highlight = new view.Highlight();
        registry.set(TEXT_HIGHLIGHT, highlight);
      }
      let range = ranges.get(node);
      if (!range) {
        range = node.ownerDocument.createRange();
        ranges.set(node, range);
        highlight.add(range);
      }
      range.selectNode(node);
    }
    if (highlight?.size === 0) registry.delete(TEXT_HIGHLIGHT);
  };
  let hasPending = false;
  let disposed = false;

  const refresh = (): void => {
    if (disposed) return;
    const roots = [...container.querySelectorAll(PENDING)];
    if (container.matches(PENDING)) roots.unshift(container);
    hasPending = roots.length > 0;
    const next = new Set<Element>();
    const text = new Set<Text>();
    const visit = (element: Element): void => {
      const display = view.getComputedStyle(element).display;
      if (display === "none") return;
      if (display !== "contents") {
        next.add(element);
        return;
      }
      for (const child of element.childNodes) {
        if (child instanceof view.Element) visit(child);
        else if (child instanceof view.Text && child.length > 0) {
          text.add(child);
        }
      }
    };
    for (const root of roots) {
      const ancestor = root.parentElement?.closest(PENDING);
      if (ancestor && container.contains(ancestor)) continue;
      visit(root);
    }
    for (const element of owned) {
      if (!next.has(element)) element.removeAttribute(BOX_ATTRIBUTE);
    }
    for (const element of next) {
      if (!owned.has(element)) element.setAttribute(BOX_ATTRIBUTE, "");
    }
    owned = next;
    highlightText(text);
  };

  const addsPending = (node: Node): boolean =>
    node instanceof view.Element &&
    (node.matches(PENDING) || node.querySelector(PENDING) !== null);
  const observer = new view.MutationObserver((records) => {
    const relevant = records.filter((record) =>
      record.type !== "attributes" || record.attributeName !== BOX_ATTRIBUTE
    );
    if (relevant.length === 0) return;
    if (
      !hasPending &&
      !relevant.some((record) =>
        record.attributeName === "data-cf-pending" ||
        [...record.addedNodes].some(addsPending)
      )
    ) return;
    refresh();
  });
  observer.observe(container, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  // Shadow-root style text and stylesheet loads can change a wrapper's display
  // without changing its own attributes. CSSOM owners can refresh explicitly.
  const root = container.getRootNode();
  if (root !== container) {
    observer.observe(root, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  if (root instanceof view.ShadowRoot) {
    observer.observe(root.host, { attributes: true });
  }
  const refreshPending = (): void => {
    if (hasPending) refresh();
  };
  root.addEventListener("load", refreshPending, true);
  view.addEventListener("resize", refreshPending);
  refresh();

  return {
    container,
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      root.removeEventListener("load", refreshPending, true);
      view.removeEventListener("resize", refreshPending);
      for (const element of owned) element.removeAttribute(BOX_ATTRIBUTE);
      owned.clear();
      highlightText(new Set());
    },
  };
}
