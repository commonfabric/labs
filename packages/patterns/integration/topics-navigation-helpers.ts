/**
 * Driving the shell's piece-to-piece navigation from a browser: resolve a
 * rendered `cf-cell-link`, click it, and wait for the destination view.
 */

import {
  type Page,
  type ProbeApi,
  waitForCondition,
} from "@commonfabric/integration";
import { waitForShellReady } from "@commonfabric/integration/shell-utils";
import {
  CLICK_TARGET_ATTR,
  clickMarked,
  settleView,
} from "./cfc-browser-helpers.ts";

/** Attribute naming the link a mark resolved, so its target can be read back. */
const LINK_TARGET_ATTR = "data-topics-link-target";

/**
 * A predicate that tags one `cf-cell-link` for a click.
 *
 * Both of the ones here take the same four arguments — what to look for, the
 * token to tag with, and the two attributes the tag goes in — so the
 * resolve-and-click tail below is written once and handed whichever predicate
 * found the link.
 */
type MarkLinkPredicate = (
  probe: ProbeApi,
  target: string,
  targetToken: string,
  clickTargetAttribute: string,
  linkTargetAttribute: string,
) => boolean;

/**
 * Find the resolved `cf-cell-link` showing `targetLabel` and tag both it and
 * the native button inside it with `targetToken`. Self-contained: it is
 * serialized and run in the page, so it closes over nothing in this module.
 *
 * A link is named by what it shows: its authored `label` when it carries one,
 * and otherwise the `[NAME]` of the cell it points at. It counts as resolved
 * once it holds that cell and its button has been laid out. A link that is
 * still forming shows a name and has resolved nothing.
 */
const markCellLink: MarkLinkPredicate = (
  probe,
  targetLabel,
  targetToken,
  clickTargetAttribute,
  linkTargetAttribute,
) => {
  for (const element of probe.collect("cf-cell-link")) {
    const link = element as HTMLElement & {
      label?: string;
      _name?: string;
      _resolvedCell?: unknown;
    };
    if ((link.label ?? link._name) !== targetLabel || !link._resolvedCell) {
      continue;
    }
    const chip = link.shadowRoot?.querySelector("cf-chip");
    const button = chip?.shadowRoot?.querySelector("button");
    if (!button || !probe.isRendered(button)) continue;
    link.setAttribute(linkTargetAttribute, targetToken);
    probe.addToken(button, clickTargetAttribute, targetToken);
    return true;
  }
  return false;
};

/**
 * Find the resolved `cf-cell-link` labelled `Open` on the board card showing
 * `cardTitle`, and tag it the way {@link markCellLink} does. Self-contained
 * for the same reason: it is serialized and run in the page.
 *
 * A card is addressed by its title because every card's link is authored with
 * the same `label="Open"`, which leaves them indistinguishable to a predicate
 * that matches on the label alone. Walking out of the link to the `cf-card`
 * around it is what separates them, and the walk crosses shadow boundaries by
 * their hosts because `closest` stops at the first one.
 */
const markCardOpenLink: MarkLinkPredicate = (
  probe,
  cardTitle,
  targetToken,
  clickTargetAttribute,
  linkTargetAttribute,
) => {
  for (const element of probe.collect("cf-cell-link")) {
    const link = element as HTMLElement & {
      label?: string;
      _name?: string;
      _resolvedCell?: unknown;
    };
    if ((link.label ?? link._name) !== "Open" || !link._resolvedCell) continue;

    let card: Element | undefined;
    let current: Node | null = link;
    while (current) {
      if (current instanceof Element && current.matches("cf-card")) {
        card = current;
        break;
      }
      const root = current.getRootNode();
      current = current.parentNode ??
        (root instanceof ShadowRoot ? root.host : null);
    }
    if (!card || !probe.deepText(card).includes(cardTitle)) continue;

    const chip = link.shadowRoot?.querySelector("cf-chip");
    const button = chip?.shadowRoot?.querySelector("button");
    if (!button || !probe.isRendered(button)) continue;
    link.setAttribute(linkTargetAttribute, targetToken);
    probe.addToken(button, clickTargetAttribute, targetToken);
    return true;
  }
  return false;
};

/**
 * Wait for `predicate` to mark a resolved cell link, then issue one trusted
 * browser click on it. Returning the id of the cell the link resolved lets the
 * caller confirm the shell selected exactly the destination the rendered data
 * points at.
 *
 * The view is settled before marking, so the link is resolved against a page
 * that has caught up rather than one mid-render. `clickMarked` carries the rest:
 * it holds until the marked button's box stops moving, measures again just
 * before dispatch, and is handed the mark predicate so a link the page rebuilds
 * in between is tagged again on whatever replaced it.
 *
 * `description` names the link in a failure, as the caller would describe it.
 */
async function markResolveAndClick(
  page: Page,
  predicate: MarkLinkPredicate,
  target: string,
  description: string,
): Promise<string> {
  await settleView(page);
  const token = `topics-cell-link-${crypto.randomUUID()}`;
  const markArgs: [string, string, string, string] = [
    target,
    token,
    CLICK_TARGET_ATTR,
    LINK_TARGET_ATTR,
  ];
  await waitForCondition(page, predicate, { args: markArgs });

  const resolved = await page.evaluate(
    (targetToken: string, linkTargetAttribute: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length > 0) {
        const root = stack.pop()!;
        const found = root.querySelector(
          `[${linkTargetAttribute}="${targetToken}"]`,
        ) as
          | (HTMLElement & {
            _resolvedCell?: {
              id(): string;
              ref(): { path: readonly unknown[] };
            };
          })
          | null;
        const cell = found?._resolvedCell;
        if (cell) return { id: cell.id(), depth: cell.ref().path.length };
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) stack.push(element.shadowRoot);
        }
      }
      return undefined;
    },
    { args: [token, LINK_TARGET_ATTR] },
  );
  if (!resolved) {
    throw new Error(`${description} resolved no destination cell`);
  }
  // The shell selects a piece, so a link the click can follow addresses a cell
  // root. Saying so here names the link that points inside one; the click
  // itself would only report that navigation never happened.
  if (resolved.depth > 0) {
    throw new Error(
      `${description} points ${resolved.depth} step(s) inside ${resolved.id}, ` +
        "which is not a cell the shell can select",
    );
  }

  await clickMarked(page, {
    token,
    remark: { predicate, args: markArgs },
  });
  return resolved.id;
}

/**
 * Click the cell link named `label`, and return the id of the cell it resolved.
 */
export function clickCellLink(page: Page, label: string): Promise<string> {
  return markResolveAndClick(
    page,
    markCellLink,
    label,
    `Cell link "${label}"`,
  );
}

/**
 * Click the `Open` link on the board card titled `title`, and return the id of
 * the cell it resolved.
 *
 * Addressing a card by its title makes the click independent of the order the
 * board lists its cards in, which is by last activity.
 */
export function clickCardOpenLink(
  page: Page,
  title: string,
): Promise<string> {
  return markResolveAndClick(
    page,
    markCardOpenLink,
    title,
    `The Open link on the card titled "${title}"`,
  );
}

/**
 * Wait until the shell's selected view is `pieceId` in `spaceName`. A piece is
 * addressed both bare (`fid1:…`, as a URL carries it) and in storage form
 * (`of:fid1:…`, as a rendered link carries it); either spelling is accepted on
 * both sides of the comparison.
 */
export async function waitForPieceView(
  page: Page,
  spaceName: string,
  pieceId: string,
): Promise<void> {
  await waitForShellReady(page);
  await waitForCondition(
    page,
    (_probe, expectedSpaceName: string, expectedPieceId: string) => {
      const fid = (id: string | undefined) =>
        id === undefined ? undefined : id.replace(/^of:/, "");
      const state = globalThis.app?.serialize() as
        | { view?: { spaceName?: string; pieceId?: string } }
        | undefined;
      return state?.view?.spaceName === expectedSpaceName &&
        fid(state.view.pieceId) === fid(expectedPieceId);
    },
    { args: [spaceName, pieceId] },
  );
}
