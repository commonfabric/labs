/**
 * Driving the shell's piece-to-piece navigation from a browser: resolve a
 * rendered `cf-cell-link`, click it, and wait for the destination view.
 */

import type { DID } from "@commonfabric/identity";
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
 * The resolution a click's marking asked a labelled link for, kept on the link
 * as `__activation`: the click's token, the source the link had when asked,
 * the resolution itself, and its target once it lands (`settled`).
 */
type LinkActivation = {
  token: string;
  source?: unknown;
  resolution: Promise<void>;
  target?: unknown;
  settled: boolean;
};

/**
 * Find the `cf-cell-link` showing `targetLabel` and, with a `cardTitle`,
 * inside the board card showing that title, and tag both it and the native
 * button inside it with `targetToken`. Self-contained: it is serialized and
 * run in the page, so it closes over nothing in this module.
 *
 * A link is named by what it shows: its authored `label` when it carries one,
 * and otherwise the `[NAME]` of the cell it points at, which an unlabelled link
 * shows once it has resolved. The first such link whose button has been laid
 * out is the candidate.
 *
 * A card is addressed by its title because every card's link is authored with
 * the same `label="Open"`, which leaves them indistinguishable to a predicate
 * that matches on the label alone. Walking out of the link to the `cf-card`
 * around it is what separates them, and the walk crosses shadow boundaries by
 * their hosts because `closest` stops at the first one.
 *
 * A labelled link resolves only when acted on. So the candidate is asked to
 * resolve for this click (`resolveTarget()`), as a press would, and is tagged
 * once that resolution lands. Until then this returns a promise that looks
 * over the links again when the resolution settles, since a resolution
 * changes nothing on the page that would make the wait look again. The
 * destination is the one this click found, never one an earlier interaction
 * left, and no other link is asked.
 */
function markCellLink(
  probe: ProbeApi,
  targetLabel: string,
  cardTitle: string,
  targetToken: string,
  clickTargetAttribute: string,
  linkTargetAttribute: string,
): boolean | Promise<boolean> {
  for (const element of probe.collect("cf-cell-link")) {
    const link = element as HTMLElement & {
      label?: string;
      _name?: string;
      _resolvedCell?: unknown;
      resolveTarget?: () => Promise<unknown>;
      cell?: unknown;
      link?: unknown;
      __activation?: LinkActivation;
    };
    if ((link.label ?? link._name) !== targetLabel) continue;
    if (cardTitle !== "") {
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
    }
    const chip = link.shadowRoot?.querySelector("cf-chip");
    const button = chip?.shadowRoot?.querySelector("button");
    if (!button || !probe.isRendered(button)) continue;
    if (link.label && link.resolveTarget) {
      let activation = link.__activation;
      const source = link.cell ?? link.link;
      // A resolution that found nothing because the link was given a new
      // source meanwhile is superseded, not empty: resolve again.
      if (
        activation?.token !== targetToken ||
        (activation.settled && !activation.target &&
          activation.source !== source)
      ) {
        const started: LinkActivation = {
          token: targetToken,
          source,
          resolution: link.resolveTarget().then((target) => {
            started.target = target;
            started.settled = true;
          }),
          settled: false,
        };
        link.__activation = started;
        activation = started;
      }
      if (!activation.settled) {
        return activation.resolution.then(() =>
          markCellLink(
            probe,
            targetLabel,
            cardTitle,
            targetToken,
            clickTargetAttribute,
            linkTargetAttribute,
          )
        );
      }
      // Resolved for this click and found nothing: try the next match.
      if (!activation.target) continue;
    } else if (!link._resolvedCell) {
      continue;
    }
    link.setAttribute(linkTargetAttribute, targetToken);
    probe.addToken(button, clickTargetAttribute, targetToken);
    return true;
  }
  return false;
}

/**
 * Finds the root cell link at `targetSpace`, `targetScope`, and `targetId`,
 * and tags it the way {@link markCellLink} does. The complete cell address
 * keeps replacement marking bound to the link already chosen: one piece id
 * can name documents in several spaces and scopes.
 *
 * A labelled link counts at the destination it resolved for this click
 * (`targetToken`), an unlabelled one at the target it follows. A labelled
 * link with no resolution for this click is asked to resolve only when it is
 * one the first pass could have chosen: showing `targetLabel` and, with a
 * `cardTitle`, inside the `cf-card` showing it. Such links are asked one at a
 * time, and only as far as the first that matches. Any other labelled link on
 * the page is left unresolved, since on a board asking it would start the
 * piece behind it. A link it asks is waited for the way {@link markCellLink}
 * waits.
 */
function markResolvedCellLink(
  probe: ProbeApi,
  targetLabel: string,
  cardTitle: string,
  targetSpace: string,
  targetScope: string,
  targetId: string,
  targetToken: string,
  clickTargetAttribute: string,
  linkTargetAttribute: string,
): boolean | Promise<boolean> {
  type Destination = {
    space(): string;
    id(): string;
    ref(): { scope?: string; path: readonly unknown[] };
  };
  for (const element of probe.collect("cf-cell-link")) {
    const link = element as HTMLElement & {
      label?: string;
      _name?: string;
      _resolvedCell?: Destination;
      resolveTarget?: () => Promise<unknown>;
      cell?: unknown;
      link?: unknown;
      __activation?: LinkActivation;
    };
    const chip = link.shadowRoot?.querySelector("cf-chip");
    const button = chip?.shadowRoot?.querySelector("button");
    const onDemand = Boolean(link.label && link.resolveTarget);
    let activation = link.__activation?.token === targetToken
      ? link.__activation
      : undefined;
    const cell = onDemand
      ? activation?.target as Destination | undefined
      : link._resolvedCell;
    if (onDemand && cell === undefined) {
      if ((link.label ?? link._name) !== targetLabel) continue;
      if (cardTitle !== "") {
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
      }
      if (!button || !probe.isRendered(button)) continue;
      // Resolved for this click and found nothing from the source it still
      // has: not this link. A source given since makes that result stale.
      const source = link.cell ?? link.link;
      const superseded = activation?.settled === true &&
        activation.source !== source;
      if (activation?.settled && !superseded) continue;
      if (activation === undefined || superseded) {
        const started: LinkActivation = {
          token: targetToken,
          source,
          resolution: link.resolveTarget!().then((target) => {
            started.target = target;
            started.settled = true;
          }),
          settled: false,
        };
        link.__activation = started;
        activation = started;
      }
      return activation.resolution.then(() =>
        markResolvedCellLink(
          probe,
          targetLabel,
          cardTitle,
          targetSpace,
          targetScope,
          targetId,
          targetToken,
          clickTargetAttribute,
          linkTargetAttribute,
        )
      );
    }
    if (!cell) continue;
    const ref = cell.ref();
    if (
      cell.space() !== targetSpace ||
      (ref.scope ?? "space") !== targetScope ||
      cell.id() !== targetId ||
      ref.path.length > 0
    ) continue;

    if (!button || !probe.isRendered(button)) continue;
    link.setAttribute(linkTargetAttribute, targetToken);
    probe.addToken(button, clickTargetAttribute, targetToken);
    return true;
  }
  return false;
}

/**
 * Wait for {@link markCellLink} to mark the resolved cell link `selection`
 * names, then issue one trusted browser click on it, and return the id of the
 * piece the click navigated to (the `cf-navigate` it dispatched). That is what
 * the caller then waits for the shell to select. A labelled link resolves
 * again when it is pressed, so a slot that moved after the link was chosen
 * opens, and reports, its new target, not the one the choice found.
 *
 * The view is settled before marking, so the link is resolved against a page
 * that has caught up rather than one mid-render. `clickMarked` carries the rest:
 * it holds until the marked button's box stops moving, measures again just
 * before dispatch, and is handed a predicate for the resolved destination so a
 * rebuilt link is tagged again and a surviving link is revalidated without
 * selecting a different cell carrying the same label or id.
 *
 * `selection` is what the link is chosen by: the label it shows and, for a
 * card's link, the card's title, empty otherwise. Revalidation asks only a
 * link it could match to resolve.
 *
 * `description` names the link in a failure, as the caller would describe it.
 */
async function markResolveAndClick(
  page: Page,
  selection: { label: string; cardTitle: string },
  description: string,
): Promise<string> {
  await settleView(page);
  const token = `topics-cell-link-${crypto.randomUUID()}`;
  await waitForCondition(page, markCellLink, {
    args: [
      selection.label,
      selection.cardTitle,
      token,
      CLICK_TARGET_ATTR,
      LINK_TARGET_ATTR,
    ],
  });

  const resolved = await page.evaluate(
    (targetToken: string, linkTargetAttribute: string) => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length > 0) {
        const root = stack.pop()!;
        type Destination = {
          space(): string;
          id(): string;
          ref(): { scope?: string; path: readonly unknown[] };
        };
        const found = root.querySelector(
          `[${linkTargetAttribute}="${targetToken}"]`,
        ) as
          | (HTMLElement & {
            label?: string;
            _resolvedCell?: Destination;
            resolveTarget?: () => Promise<unknown>;
            __activation?: LinkActivation;
          })
          | null;
        // A labelled link's destination is the one it resolved for this
        // click; an unlabelled link's is the target it follows.
        const cell = found?.label && found.resolveTarget
          ? (found.__activation?.token === targetToken
            ? found.__activation.target as Destination | undefined
            : undefined)
          : found?._resolvedCell;
        if (cell) {
          const ref = cell.ref();
          return {
            space: cell.space(),
            scope: ref.scope ?? "space",
            id: cell.id(),
            depth: ref.path.length,
          };
        }
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

  const remarkArgs: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ] = [
    selection.label,
    selection.cardTitle,
    resolved.space,
    resolved.scope,
    resolved.id,
    token,
    CLICK_TARGET_ATTR,
    LINK_TARGET_ATTR,
  ];
  // What the click opens is what the marked link's own activation found:
  // the resolution its press or click makes (a labelled link resolves again
  // when acted on), or, where it makes none, the one this click's choice
  // recorded, or the target an unlabelled link follows. The helper waits for
  // a navigation to that whole destination (space, piece, scope and path), so
  // another link finishing a lookup of its own after this click is not taken
  // for this one, and neither is a navigation dispatched while the helper
  // revalidates.
  await page.evaluate(
    (
      targetToken: string,
      clickTargetAttribute: string,
      linkTargetAttribute: string,
    ) => {
      type ClickRecord = {
        clicked: boolean;
        link?: HTMLElement & {
          resolveTarget?: (...args: unknown[]) => Promise<unknown>;
        };
        resolutions: Promise<unknown>[];
        navigations: {
          space?: string;
          id?: string;
          scope: string;
          path: string[];
        }[];
      };
      const scope = globalThis as typeof globalThis & {
        __topicsClicks?: Record<string, ClickRecord>;
      };
      const record: ClickRecord = {
        clicked: false,
        resolutions: [],
        navigations: [],
      };
      (scope.__topicsClicks ??= {})[targetToken] = record;
      const markedLinkOf = (event: Event) => {
        const path = event.composedPath();
        const onMarked = path.some((node) =>
          node instanceof Element &&
          (node.getAttribute(clickTargetAttribute) ?? "").split(/\s+/)
            .includes(targetToken)
        );
        if (!onMarked) return undefined;
        return path.find((node) =>
          node instanceof Element &&
          node.getAttribute(linkTargetAttribute) === targetToken
        ) as ClickRecord["link"];
      };
      // Seen before the link's own handlers, so the resolution its press
      // starts is the one recorded.
      const watch = (link: ClickRecord["link"]) => {
        if (!link || record.link === link) return;
        record.link = link;
        const original = link.resolveTarget;
        if (typeof original !== "function") return;
        link.resolveTarget = function (this: unknown, ...args: unknown[]) {
          const resolving = original.apply(this, args);
          record.resolutions.push(resolving);
          return resolving;
        };
      };
      const onPointerDown = (event: Event) => watch(markedLinkOf(event));
      const onClick = (event: Event) => {
        const link = markedLinkOf(event);
        if (!link) return;
        watch(link);
        record.clicked = true;
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("click", onClick, true);
      };
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("click", onClick, true);
      // The whole destination, so a navigation to the same piece id in
      // another space, scope or path is not taken for this click's.
      globalThis.addEventListener("cf-navigate", (event: Event) => {
        if (!record.clicked) return;
        const view = (event as CustomEvent<{
          spaceDid?: unknown;
          spaceName?: unknown;
          pieceId?: unknown;
          pieceScope?: unknown;
          piecePath?: unknown;
        }>).detail ?? {};
        const space = view.spaceDid ?? view.spaceName;
        record.navigations.push({
          space: typeof space === "string" ? space : undefined,
          id: typeof view.pieceId === "string" ? view.pieceId : undefined,
          scope: typeof view.pieceScope === "string"
            ? view.pieceScope
            : "space",
          path: Array.isArray(view.piecePath) ? view.piecePath.map(String) : [],
        });
      });
    },
    { args: [token, CLICK_TARGET_ATTR, LINK_TARGET_ATTR] },
  );
  await clickMarked(page, {
    token,
    remark: {
      predicate: markResolvedCellLink,
      args: remarkArgs,
      revalidateBeforeClick: true,
    },
  });
  await waitForCondition(
    page,
    (_probe: ProbeApi, targetToken: string) =>
      (globalThis as typeof globalThis & {
        __topicsClicks?: Record<string, { clicked: boolean }>;
      }).__topicsClicks?.[targetToken]?.clicked === true,
    { args: [token] },
  );
  // The click's lookup is tracked in the page and awaited through
  // `waitForCondition`, so a lookup that never settles fails the wait's bound
  // instead of holding the helper past it.
  let settled: ClickOutcome | undefined;
  try {
    settled = await waitForCondition(
      page,
      (_probe: ProbeApi, targetToken: string) => {
        type LinkTarget = {
          space(): string;
          id(): string;
          ref(): { scope?: string; path: readonly unknown[] };
        };
        const record = (globalThis as typeof globalThis & {
          __topicsClicks: Record<string, {
            link?: HTMLElement & {
              label?: string;
              _resolvedCell?: LinkTarget;
              resolveTarget?: unknown;
              __activation?: LinkActivation;
            };
            resolutions: Promise<unknown>[];
            settling?: Promise<ClickOutcome>;
          }>;
        }).__topicsClicks[targetToken];
        record.settling ??= (async (): Promise<ClickOutcome> => {
          // A click handler may start its resolution in the same task as the
          // click; let it.
          await new Promise((resolve) => setTimeout(resolve, 0));
          const link = record.link;
          const target = record.resolutions.length > 0
            ? await record.resolutions[record.resolutions.length - 1]
            : link?.label && link.resolveTarget
            ? (link.__activation?.token === targetToken
              ? link.__activation.target
              : undefined)
            : link?._resolvedCell;
          const cell = target as LinkTarget | undefined;
          if (!cell) return { destination: null };
          const ref = cell.ref();
          return {
            destination: {
              space: cell.space(),
              id: cell.id(),
              scope: ref.scope ?? "space",
              path: ref.path.map(String),
            },
          };
        })().catch((error) => ({ error: String(error) }));
        return record.settling;
      },
      { args: [token] },
    );
  } catch (cause) {
    throw new Error(`${description}: the click's lookup never settled`, {
      cause,
    });
  }
  if (settled && "error" in settled) {
    throw new Error(
      `${description}: the click's lookup failed: ${settled.error}`,
    );
  }
  const opened = settled?.destination;
  if (!opened) {
    throw new Error(`${description} resolved no destination when clicked`);
  }
  try {
    await waitForCondition(
      page,
      (_probe: ProbeApi, targetToken: string, expected: Destination) =>
        (globalThis as typeof globalThis & {
          __topicsClicks?: Record<string, { navigations: Destination[] }>;
        }).__topicsClicks?.[targetToken]?.navigations.some((view) =>
          view.space === expected.space && view.id === expected.id &&
          view.scope === expected.scope &&
          view.path.length === expected.path.length &&
          view.path.every((key, index) => key === expected.path[index])
        ) === true,
      { args: [token, opened] },
    );
  } catch (cause) {
    throw new Error(
      `${description} never navigated to ${opened.id} in ${opened.space}` +
        (opened.scope === "space" ? "" : ` (${opened.scope} scope)`) +
        (opened.path.length === 0 ? "" : ` at /${opened.path.join("/")}`),
      { cause },
    );
  }
  return opened.id;
}

/** Where a click navigated to: what a `cf-navigate` names, in full. */
type Destination = {
  space: string;
  id: string;
  scope: string;
  path: string[];
};

/** What the clicked link's lookup settled on. */
type ClickOutcome =
  | { destination: Destination | null }
  | { error: string };

/**
 * Click the cell link named `label`, and return the id of the piece the click
 * navigated to.
 */
export function clickCellLink(page: Page, label: string): Promise<string> {
  return markResolveAndClick(
    page,
    { label, cardTitle: "" },
    `Cell link "${label}"`,
  );
}

/**
 * Click the `Open` link on the board card titled `title`, and return the id of
 * the piece the click navigated to.
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
    { label: "Open", cardTitle: title },
    `The Open link on the card titled "${title}"`,
  );
}

/**
 * Wait until the shell's selected view is `pieceId` in `spaceDid`. A piece is
 * addressed both bare (`fid1:…`, as a URL carries it) and in storage form
 * (`of:fid1:…`, as a rendered link carries it); either spelling is accepted on
 * both sides of the comparison.
 */
export async function waitForPieceView(
  page: Page,
  spaceDid: DID,
  pieceId: string,
): Promise<void> {
  await waitForShellReady(page);
  await waitForCondition(
    page,
    (_probe, expectedSpaceDid: string, expectedPieceId: string) => {
      const fid = (id: string | undefined) =>
        id === undefined ? undefined : id.replace(/^of:/, "");
      const state = globalThis.app?.serialize() as
        | { view?: { spaceDid?: string; pieceId?: string } }
        | undefined;
      return state?.view?.spaceDid === expectedSpaceDid &&
        fid(state.view.pieceId) === fid(expectedPieceId);
    },
    { args: [spaceDid, pieceId] },
  );
}
