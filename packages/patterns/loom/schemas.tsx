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
import type {
  ParticipantProfile,
  ParticipantRoster,
  ParticipantRosterCell,
} from "./participants.tsx";

export type { ParticipantProfile, ParticipantRoster, ParticipantRosterCell };

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
 * `addedBy` is the DID of the person who added the occurrence, as its writer
 * claims it: the root's handlers check that it is a DID, not that it names the
 * person acting, and a direct write to a panel is not checked. A panel without
 * it is attributed to the Loom's owner.
 */
export type Panel =
  | {
    kind: "piece";
    piece: Writable<unknown>;
    titleOverride?: string;
    addedBy?: string;
  }
  | {
    kind: "document";
    content: Writable<PublishedDocument>;
    titleOverride?: string;
    addedBy?: string;
  }
  | { kind: "url"; url: string; titleOverride?: string; addedBy?: string };

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

/** A duplication, attributed to `addedBy` rather than to the source's adder. */
export interface PanelDuplication extends PanelPosition {
  addedBy?: string;
}

/** Ephemeral selection local to one viewer session. */
export interface ViewerState {
  selectedPanel?: Writable<Panel>;
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
  addPiece: Stream<{ piece: Writable<unknown>; addedBy?: string }>;
  removePiece: Stream<{ piece: Writable<unknown> }>;
  addPanel: Stream<PanelPosition>;
  removePanel: Stream<{ panel: Writable<Panel> }>;
  movePanel: Stream<PanelPosition>;
  duplicatePanel: Stream<PanelDuplication>;
  setPresentation: Stream<Presentation>;
  participants: ParticipantProfile[];
  addParticipant: Stream<{ profile: ParticipantProfile }>;
}
