/**
 * Brings a live page up to date with a fresh rendering of it. This runs in the
 * browser, on every rendering the server sends (live-page.ts).
 */

/** The parts of an element `reconcileMain` reads and changes. */
export interface Part<E> {
  readonly outerHTML: string;
  readonly innerHTML: string;
  readonly children: ArrayLike<E>;
  replaceWith(next: E): void;
}

/**
 * Makes `main`, the page's `<main>`, match `next`, the one in a fresh
 * rendering, and reports whether it changed anything. Where the two hold the
 * same number of elements, only the elements that differ are replaced, so a
 * reader's selection or search highlights in an unchanged part of the page
 * survive an update to another part. Otherwise `main` is replaced whole.
 */
export function reconcileMain<E extends Part<E>>(main: E, next: E): boolean {
  if (next.innerHTML === main.innerHTML) return false;
  const before = Array.from(main.children);
  const after = Array.from(next.children);
  const changed = after.length === before.length
    ? after.flatMap((part, index) =>
      part.outerHTML === before[index].outerHTML ? [] : [index]
    )
    : [];
  // No element differing means the difference is in text between them.
  if (changed.length === 0) main.replaceWith(next);
  for (const index of changed) before[index].replaceWith(after[index]);
  return true;
}
