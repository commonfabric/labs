import { html } from "lit";
import { BaseElement } from "./base-element.ts";

/**
 * Retired elements: inert passthrough stubs for components we have removed.
 *
 * Why this exists: a pattern's source is DURABLE. Pieces keep running the
 * source they were stored with, for as long as that piece lives — so the set
 * of element names patterns may emit is not "whatever the current palette
 * defines", it is the union of every palette that has ever shipped. Deleting a
 * component therefore does not retire it; it only removes the definition out
 * from under source that still names it.
 *
 * Removing `cf-cell-context` (#5132) demonstrated the cost. Stored home
 * sections still emitted it, and with both the component and its `jsx.d.ts`
 * declaration gone, rows that mapped over durable data stopped instantiating —
 * silently, because the failure surfaced as cell requests that never settled
 * rather than as an error. Blank Favorites and Profile tabs, nothing in the
 * console, for weeks.
 *
 * So a retired element keeps a definition that renders its children and does
 * nothing else. It stays a known element, its props keep their declared
 * meaning, and the subtree underneath it goes on working. It is loud rather
 * than fatal: one console warning per element per session at runtime. It has
 * no JSX declaration, because declaring a retired element in
 * `JSX.IntrinsicElements` stops spaces with stored source that names it from
 * rendering; new source that names it therefore fails to type-check. Patterns
 * get rewritten off it at their own pace; the stub leaves only when nothing
 * durable names it any more.
 */

const warned = new Set<string>();

/** Warn once per element name per session that durable source still uses it. */
export function warnRetiredElementUsed(
  tag: string,
  replacement?: string,
): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(
    `[retired-element] <${tag}> is retired and now renders as an inert ` +
      `passthrough. Durable pattern source still names it` +
      (replacement ? `; use ${replacement} instead.` : ".") +
      ` Update the pattern's source to stop relying on it.`,
  );
}

/** Reset the warn-once ledger. Test seam only. */
export function resetRetiredElementWarnings(): void {
  warned.clear();
}

/**
 * Base class for a retired element: renders a default slot, nothing else.
 *
 * Subclasses declare their own tag name and any props the retired component
 * carried, so source that binds those props keeps working.
 *
 * They must also KEEP THAT COMPONENT'S HOST LAYOUT. This class deliberately
 * imposes none: an inert element is not a layout-neutral one. Stored source
 * was authored against the retired component's box — `display: block` with
 * `flex: 1`, an inline variant, whatever it had — and collapsing every stub to
 * `display: contents` would silently reflow the pages this exists to keep
 * working. Copy the retired component's `:host` rules into the stub; the point
 * is that nothing changes for source that still names it.
 */
export abstract class RetiredElement extends BaseElement {
  static override styles = [BaseElement.baseStyles];

  /** The tag this stub stands in for. */
  protected abstract retiredTag: string;

  /** What to use instead, when there is a successor. */
  protected retiredReplacement?: string;

  /**
   * Emit this element's retirement warning.
   *
   * Idempotent by way of the warn-once ledger, which is what lets `render()`
   * call it directly. Warning from render rather than `connectedCallback`
   * keeps the signal on the path that proves the element was actually used,
   * and keeps this class free of anything needing a live document — so the
   * behavior is unit-testable instead of reachable only from a browser lane.
   */
  notifyRetiredUsage(): void {
    warnRetiredElementUsed(this.retiredTag, this.retiredReplacement);
  }

  override render() {
    this.notifyRetiredUsage();
    return html`
      <slot></slot>
    `;
  }
}
