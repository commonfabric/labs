/** The part of a box's position that placing a card reads. */
export interface AnchorBox {
  top: number;
  bottom: number;
  left: number;
}

/** A width and a height. */
export interface Size {
  width: number;
  height: number;
}

/**
 * Where a card of `card`'s size goes for content at `anchor`, in a window of
 * `window`'s size, keeping `gap` between the card and the content and between
 * the card and the window's edges.
 *
 * The card sits above the content when there is room, and below it otherwise,
 * but no lower than keeps it in the window; a card taller than the window keeps
 * its top in view. It starts at the content's left edge, moved in to keep it in
 * the window, and a card wider than the window keeps its left edge in view.
 */
export function placeCard(
  anchor: AnchorBox,
  card: Size,
  window: Size,
  gap: number,
): { top: number; left: number } {
  const above = anchor.top - gap - card.height;
  const maxTop = window.height - gap - card.height;
  const top = above >= gap
    ? above
    : Math.max(gap, Math.min(anchor.bottom + gap, maxTop));
  const maxLeft = window.width - gap - card.width;
  const left = Math.max(gap, Math.min(anchor.left, maxLeft));
  return { top, left };
}
