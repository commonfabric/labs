/**
 * Brings the tiles on the page up to date with a fresh rendering. This runs in
 * the browser, on every update the server sends. A tile is matched with its
 * earlier rendering by its label, which the renderer writes into its
 * `data-tile-label` attribute and which is unique among the dashboard's tiles.
 * A tile whose markup has not changed is left in place, and a changed tile is
 * replaced. Inside a replaced tile, an element carrying a `data-focus-key` is
 * matched with the element carrying the same key in the replacement, which
 * takes over its keyboard focus and its scroll position; a focused link with
 * no key is matched by its href. Tiles are then put in the rendering's order,
 * and a tile the rendering no longer has is removed.
 */

/** Makes the tiles in `container` match `rendered`, tile by tile. */
export function reconcileTiles(
  container: Element,
  rendered: readonly HTMLElement[],
): void {
  const keyed = (tile: Element) => [
    ...tile.querySelectorAll<HTMLElement>("[data-focus-key]"),
  ];
  const onPage = new Map(
    [...container.children].map((tile) => [
      tile.getAttribute("data-tile-label"),
      tile,
    ]),
  );
  const tiles = rendered.map((next) => {
    const label = next.getAttribute("data-tile-label");
    const current = onPage.get(label);
    if (!current) return next;
    onPage.delete(label);
    if (current.outerHTML === next.outerHTML) return current;

    // The element in `next` that stands for `element` in `current`.
    const counterpart = (element: Element): HTMLElement | undefined => {
      if (element === current) return next;
      const key = element.getAttribute("data-focus-key");
      const byKey = key === null ? undefined : keyed(next).find((candidate) =>
        candidate.getAttribute("data-focus-key") === key
      );
      const href = element.localName === "a"
        ? element.getAttribute("href")
        : null;
      return byKey ?? (href === null ? undefined : [
        ...next.querySelectorAll("a"),
      ].find((link) => link.getAttribute("href") === href));
    };
    const scrolled = keyed(current)
      .filter((element) => element.scrollTop > 0)
      .map((element) => ({ element, scrollTop: element.scrollTop }));
    const active = current.ownerDocument.activeElement;
    const focused = active && current.contains(active) ? active : null;
    current.replaceWith(next);
    for (const { element, scrollTop } of scrolled) {
      const successor = counterpart(element);
      if (successor) successor.scrollTop = scrollTop;
    }
    if (focused) counterpart(focused)?.focus({ preventScroll: true });
    return next;
  });
  for (const removed of onPage.values()) removed.remove();
  tiles.forEach((tile, index) => {
    const atIndex = container.children.item(index);
    if (atIndex !== tile) container.insertBefore(tile, atIndex);
  });
}
