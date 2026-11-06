/**
 * What a viewer may do to a Loom, as the Loom states it to a host that draws
 * its own deck: each action an id, which the host names in its own words and
 * ignores when it does not know it, with the stream it sends to and the event
 * it sends, so every host does the same thing for the same id and learns of a
 * new one from the Loom rather than from a copy of its rules. `open` alone
 * names no stream: the host opens the panel's piece itself. Each event is one
 * the root's streams accept from this viewer as things stand; they still
 * decide.
 */
import type { SpaceAccessLevel, Writable } from "commonfabric";
import type {
  LoomAction,
  LoomOffers,
  Panel,
  PanelOffer,
  PanelRemoval,
  ParticipantProfile,
  Presentation,
} from "./schemas.tsx";

/** What the offers are worked out from, read by the caller's computation. */
export interface OfferFacts {
  access: SpaceAccessLevel | undefined;
  /** The Loom's panels, in its order; `undefined` before the first read. */
  shared: readonly Writable<Panel>[] | undefined;
  /** The viewer's list: shared panels not hidden, and private ones. */
  shown: readonly Writable<Panel>[];
  hidden: readonly Writable<Panel>[];
  presentation: Presentation | undefined;
  /** The profile the viewer adds panels under, as the root's own UI does. */
  profile: ParticipantProfile | undefined;
  removal: (panel: Writable<Panel>) => PanelRemoval;
}

/**
 * The actions `facts` admit for this viewer: on the Loom, `stage-all`,
 * `clear-focus` and `clear-stage`; on a shown shared panel, `open` (a piece),
 * `focus`, `move-first`, `move-last`, `duplicate`, `hide` and `remove`; on a
 * private panel, `open` and `remove-from-my-view`; on a hidden one, `show`.
 * Removal by a panel's adder, while it is not otherwise offered, is the one
 * action the Loom cannot offer outright, since a computation cannot yet ask who
 * the viewer is: it comes under `ifViewerIs`, for a host to offer when it acts
 * as that principal.
 */
export function loomOffers(facts: OfferFacts): LoomOffers {
  const { access, shown, hidden, profile } = facts;
  const shared = facts.shared ?? [];
  const staged = facts.presentation?.stagedPanels ?? [];
  const focused = facts.presentation?.focusedPanel;
  const writes = access === "OWNER" || access === "WRITE";
  const reads = writes || access === "READ";
  const has = (list: readonly Writable<Panel>[], panel: Writable<Panel>) =>
    list.some((one) => one.equals(panel));
  const present = (
    id: string,
    stagedPanels: Writable<Panel>[],
    focusedPanel?: Writable<Panel>,
  ): LoomAction => ({
    id,
    stream: "setPresentation",
    event: focusedPanel ? { stagedPanels, focusedPanel } : { stagedPanels },
  });
  const loom: LoomAction[] = [];
  if (writes) {
    // Staging is everyone's: every shared panel, those this viewer hid too,
    // and, as the root's own Stage all does, no focus.
    if (shared.some((panel) => !has(staged, panel))) {
      loom.push(present("stage-all", [...shared]));
    }
    if (focused) loom.push(present("clear-focus", [...staged]));
    if (staged.length) loom.push(present("clear-stage", []));
  }
  const offer = (panel: Writable<Panel>): PanelOffer => {
    const actions: LoomAction[] = [];
    if (reads && panel.get()?.kind === "piece") actions.push({ id: "open" });
    const at = shared.findIndex((one) => one.equals(panel));
    // What changes only the viewer's own lists is theirs whatever their
    // access to the Loom's space, as the root's own page offers it.
    if (at < 0) {
      actions.push({
        id: "remove-from-my-view",
        stream: "removePrivatePanel",
        event: { panel },
      });
      return { panel, actions };
    }
    if (writes) {
      // A panel is focused among the staged ones, so focusing stages it too.
      if (!focused?.equals(panel)) {
        actions.push(
          present(
            "focus",
            has(staged, panel) ? [...staged] : [...staged, panel],
            panel,
          ),
        );
      }
      if (at > 0) {
        actions.push({
          id: "move-first",
          stream: "movePanel",
          event: { panel, before: shared[0] },
        });
      }
      if (at < shared.length - 1) {
        actions.push({
          id: "move-last",
          stream: "movePanel",
          event: { panel },
        });
      }
      actions.push({
        id: "duplicate",
        stream: "duplicatePanel",
        event: profile === undefined ? { panel } : { panel, as: profile },
      });
    }
    actions.push({ id: "hide", stream: "hidePanel", event: { panel } });
    if (!writes) return { panel, actions };
    const remove = { id: "remove", stream: "removePanel", event: { panel } };
    const removal = facts.removal(panel);
    if (
      removal.by === "anyone" ||
      (access === "OWNER" &&
        (removal.by === "owner" ||
          (removal.by === "adder" && removal.adderLeft)))
    ) {
      return { panel, actions: [...actions, remove] };
    }
    return removal.by === "adder"
      ? {
        panel,
        actions,
        ifViewerIs: { principal: removal.adder, actions: [remove] },
      }
      : { panel, actions };
  };
  return {
    loom,
    shown: shown.map(offer),
    hidden: hidden.map((panel) => ({
      panel,
      actions: [{ id: "show", stream: "unhidePanel", event: { panel } }],
    })),
  };
}
