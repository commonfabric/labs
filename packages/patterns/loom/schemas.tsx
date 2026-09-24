/** Public linked-cell contract of a shared Loom. */
import type {
  Default,
  NAME,
  PerSession,
  PerSpace,
  Stream,
  UI,
  VNode,
  Writable,
} from "commonfabric";
import type { PanelAdderProfile } from "./admission.tsx";
import type {
  ParticipantProfile,
  ParticipantRoster,
  ParticipantRosterCell,
} from "./participants.tsx";

export type {
  PanelAdderProfile,
  ParticipantProfile,
  ParticipantRoster,
  ParticipantRosterCell,
};

/** Allowlisted public contact information supplied by the publisher. */
export interface PublishedChannel {
  kind: string;
  value: string;
  label?: string;
}

/** Allowlisted source projection, refreshed only by the producer. */
export type PublishedSource =
  | { kind: "page-excerpt"; title: string; body: string }
  | {
    kind: "person-card";
    name: string;
    photo?: string;
    channels: PublishedChannel[];
  };

/** Producer source and collaborative notes have separate write locations. */
export interface PublishedDocument {
  source: PublishedSource;
  notes: string | Default<"">;
}

/**
 * One occurrence in the Loom, retaining the complete target cell reference.
 *
 * `addedByProfile` is the profile under which the person who added the
 * occurrence acted, and the label entry the panel declares at that field, as
 * opposed to the copies of the profile's own label, names the principal who
 * acted; only the root's `admitPanel` writes it. `addedBy` is the DID of the person who added
 * the occurrence as its writer claims it: the root's handlers check that it is
 * a DID, not that it names the person acting, and a direct write to a panel is
 * not checked. A panel with neither is attributed to the Loom's owner.
 */
export type Panel =
  | {
    kind: "piece";
    piece: Writable<unknown>;
    titleOverride?: string;
    addedBy?: string;
    addedByProfile?: PanelAdderProfile;
  }
  | {
    kind: "document";
    content: Writable<PublishedDocument>;
    titleOverride?: string;
    addedBy?: string;
    addedByProfile?: PanelAdderProfile;
  }
  | {
    kind: "url";
    url: string;
    titleOverride?: string;
    addedBy?: string;
    addedByProfile?: PanelAdderProfile;
  };

/** Shared staging and focus, independent of each viewer's session selection. */
export interface Presentation {
  stagedPanels: Writable<Panel>[];
  focusedPanel?: Writable<Panel>;
}

/** Shared state supplied when a Loom is instantiated. */
export interface LoomInput {
  title?: PerSpace<Writable<string | Default<"Shared Loom">>>;
  panels?: PerSpace<Writable<Writable<Panel>[] | Default<[]>>>;
  presentation?: PerSpace<
    Writable<Presentation | Default<{ stagedPanels: [] }>>
  >;
  participants?: PerSpace<ParticipantRosterCell>;
}

/** An occurrence and its optional insertion anchor. Omission appends. */
export interface PanelPosition {
  panel: Writable<Panel>;
  before?: Writable<Panel>;
}

/**
 * Who adds a panel: `as` is the profile under which they act, or `addedBy`
 * names them by DID. An event carries at most one of the two, and `addPanel`
 * takes `addedBy` from the occurrence rather than the event.
 */
export interface PanelAdder {
  as?: ParticipantProfile;
  addedBy?: string;
}

/**
 * The event of every stream that adds a panel. Each is a binding of the one
 * handler that writes `addedByProfile`, so all three take this shape:
 * `addPiece` requires `piece`, and `addPanel` and `duplicatePanel` require
 * `panel` and accept `before`. `addPanel` with `as` adds a copy of `panel`,
 * never recording the profile on the document passed.
 */
export interface PanelAdmission extends PanelAdder {
  piece?: Writable<unknown>;
  panel?: Writable<Panel>;
  before?: Writable<Panel>;
}

/**
 * Ephemeral state local to one viewer session: its selection, and the profile
 * the session acts under when it adds a panel from the root's UI. Without
 * `actingProfile`, the viewer's `#profile` is used.
 */
export interface ViewerState {
  selectedPanel?: Writable<Panel>;
  actingProfile?: ParticipantProfile;
}

/** Standard default-pattern exports and the public composition actions. */
export interface LoomOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  viewerState: PerSession<Writable<ViewerState>>;
  panels: Writable<Panel>[];
  presentation: Presentation;
  pieceRegistry: Writable<unknown>[];
  addPiece: Stream<PanelAdmission>;
  removePiece: Stream<{ piece: Writable<unknown> }>;
  addPanel: Stream<PanelAdmission>;
  removePanel: Stream<{ panel: Writable<Panel> }>;
  movePanel: Stream<PanelPosition>;
  duplicatePanel: Stream<PanelAdmission>;
  setPresentation: Stream<Presentation>;
  participants: ParticipantProfile[];
  addParticipant: Stream<{ profile: ParticipantProfile }>;
}
