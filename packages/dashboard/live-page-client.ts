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
 * rendering, and reports whether it changed anything. An element whose tag,
 * attributes, and text between its children match its counterpart's, and
 * which has as many children, is kept, and each of its children is made to
 * match in the same way. Any other element that differs is replaced whole.
 * So only what changed is replaced, and the rest of the page, with a reader's
 * focus, selection, or search highlights in it, stays where it is.
 */
export function reconcileMain<E extends Part<E>>(main: E, next: E): boolean {
  if (main.outerHTML === next.outerHTML) return false;
  // Everything in an element's markup other than its child elements: its tags,
  // its attributes, and the text between the children.
  const frame = (part: E): string => {
    const inner = part.innerHTML;
    let at = 0;
    const kept: string[] = [];
    for (const child of Array.from(part.children)) {
      const start = inner.indexOf(child.outerHTML, at);
      kept.push(inner.slice(at, start));
      at = start + child.outerHTML.length;
    }
    kept.push(inner.slice(at));
    // The inner markup ends where the closing tag starts, so it is the last
    // copy of it in the outer markup; an earlier one may be in an attribute.
    const outer = part.outerHTML;
    const start = outer.lastIndexOf(inner);
    return outer.slice(0, start) + kept.join("\0") +
      outer.slice(start + inner.length);
  };
  const reconcile = (current: E, fresh: E): void => {
    if (current.outerHTML === fresh.outerHTML) return;
    const before = Array.from(current.children);
    const after = Array.from(fresh.children);
    if (
      before.length === 0 || before.length !== after.length ||
      frame(current) !== frame(fresh)
    ) {
      current.replaceWith(fresh);
      return;
    }
    before.forEach((child, index) => reconcile(child, after[index]));
  };
  reconcile(main, next);
  return true;
}

/**
 * The event a live page's `<main>` is sent, before the page is brought up to
 * date, with the fresh rendering's `<main>` as its detail. The event bubbles to
 * the document. A page that the reader has rearranged, as by sorting a table,
 * arranges the fresh rendering the same way when it hears this, so the parts
 * that did not change compare equal and are kept.
 */
export const LIVE_PAGE_UPDATE = "live-page-update";

/**
 * Announces `next` to the page as `LIVE_PAGE_UPDATE`, then makes `main` match
 * it with `reconcileMain`, and reports whether that changed anything.
 */
export function updateMain<
  E extends Part<E> & { dispatchEvent(event: CustomEvent<E>): unknown },
>(main: E, next: E): boolean {
  main.dispatchEvent(
    new CustomEvent(LIVE_PAGE_UPDATE, { bubbles: true, detail: next }),
  );
  return reconcileMain(main, next);
}

/** The parts of a document `updateIcon` reads and changes. */
export interface IconHolder {
  querySelector(selector: string): {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  } | null;
}

/**
 * Gives the tab's favicon in `page` the image of the one in `fresh`, a new
 * rendering of it.
 */
export function updateIcon(page: IconHolder, fresh: IconHolder): void {
  const icon = page.querySelector('link[rel="icon"]');
  const href = fresh.querySelector('link[rel="icon"]')?.getAttribute("href");
  if (icon && href && icon.getAttribute("href") !== href) {
    icon.setAttribute("href", href);
  }
}
