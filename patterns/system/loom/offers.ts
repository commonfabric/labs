/**
 * What a viewer may do to a Loom, as ids a host draws in its own words, so
 * that every host offers the same actions and learns of a new one from the
 * Loom rather than from a copy of its rules. Each id names one stream event
 * the root accepts from this viewer as things stand; the streams still decide.
 */
import type { SpaceAccessLevel, Writable } from "commonfabric";
import type {
  LoomOffers,
  Panel,
  PanelOffer,
  PanelRemoval,
  Presentation,
} from "./schemas.tsx";

/** What the offers are worked out from, read by the caller's computation. */
export interface OfferFacts {
  access: SpaceAccessLevel | undefined;
  /** The Loom's panels, in its order. */
  shared: readonly Writable<Panel>[];
  /** The viewer's list: shared panels not hidden, and private ones. */
  shown: readonly Writable<Panel>[];
  hidden: readonly Writable<Panel>[];
  presentation: Presentation;
  removal: (panel: Writable<Panel>) => PanelRemoval;
}

/**
 * The actions `facts` admit for this viewer: on the Loom, `stage-all`,
 * `clear-focus` and `clear-stage`; on a shown shared panel, `open` (a piece),
 * `focus`, `move-first`, `move-last`, `duplicate`, `hide` and `remove`; on a
 * private panel, `open` and `remove-from-my-view`; on a hidden one, `show`.
 * Removal by a panel's adder is the one offer the Loom cannot make itself,
 * since a computation cannot yet ask who the viewer is: such a panel names its
 * adder in `removableBy` instead.
 */
export function loomOffers(facts: OfferFacts): LoomOffers {
  const { access, shared, shown, hidden, presentation } = facts;
  const writes = access === "OWNER" || access === "WRITE";
  const reads = writes || access === "READ";
  const { stagedPanels: staged, focusedPanel: focused } = presentation;
  const has = (list: readonly Writable<Panel>[], panel: Writable<Panel>) =>
    list.some((one) => one.equals(panel));
  const loom: string[] = [];
  if (writes) {
    if (shared.some((panel) => !has(staged, panel))) loom.push("stage-all");
    if (focused) loom.push("clear-focus");
    if (staged.length) loom.push("clear-stage");
  }
  const panels = shown.map((panel): PanelOffer => {
    const actions: string[] = [];
    const piece = panel.get()?.kind === "piece";
    if (reads && piece) actions.push("open");
    const at = shared.findIndex((one) => one.equals(panel));
    if (at < 0) {
      if (reads) actions.push("remove-from-my-view");
      return { panel, actions };
    }
    if (writes) {
      if (!focused?.equals(panel)) actions.push("focus");
      if (at > 0) actions.push("move-first");
      if (at < shared.length - 1) actions.push("move-last");
      actions.push("duplicate");
    }
    if (reads) actions.push("hide");
    if (!writes) return { panel, actions };
    const removal = facts.removal(panel);
    if (
      removal.by === "anyone" ||
      (access === "OWNER" &&
        (removal.by === "owner" ||
          (removal.by === "adder" && removal.adderLeft)))
    ) {
      actions.push("remove");
      return { panel, actions };
    }
    return removal.by === "adder"
      ? { panel, actions, removableBy: removal.adder }
      : { panel, actions };
  });
  for (const panel of hidden) {
    if (reads) panels.push({ panel, actions: ["show"] });
  }
  return { loom, panels };
}
