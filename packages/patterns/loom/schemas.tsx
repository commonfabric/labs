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
import type { PanelAdderDid, PanelAdderProfile } from "./admission.tsx";
import type {
  ParticipantProfile,
  ParticipantRoster,
  ParticipantRosterCell,
} from "./participants.tsx";

export type {
  PanelAdderDid,
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
 * acted. `addedBy` is the DID of the principal who added the occurrence, and
 * the label entry the panel declares there names the same principal when the
 * root wrote it. Of the root's handlers only `admitPanel` writes either, and
 * once it has written a panel no other handler may. An occurrence it creates
 * records `addedByProfile` when its event names a profile, and otherwise
 * `addedBy` when the event acted for a principal, so a run that acts for no
 * one records neither. An occurrence a caller made may hold an
 * `addedBy` the root never wrote: the value is its writer's claim, and a label
 * entry there names the writer, not the principal the value names. A panel
 * with neither names no adder.
 */
export type Panel =
  | {
    kind: "piece";
    piece: Writable<unknown>;
    titleOverride?: string;
    addedBy?: PanelAdderDid;
    addedByProfile?: PanelAdderProfile;
  }
  | {
    kind: "document";
    content: Writable<PublishedDocument>;
    titleOverride?: string;
    addedBy?: PanelAdderDid;
    addedByProfile?: PanelAdderProfile;
  }
  | {
    kind: "url";
    url: string;
    titleOverride?: string;
    addedBy?: PanelAdderDid;
    addedByProfile?: PanelAdderProfile;
  };

/** Shared staging and focus, independent of each viewer's session selection. */
export interface Presentation {
  stagedPanels: Writable<Panel>[];
  focusedPanel?: Writable<Panel>;
}

/**
 * A chat room as the Loom links it: its name, and nothing of its conversation,
 * so a reader of the Loom loads none of the room's messages. A client opens
 * the room through the link, under its own access.
 */
export interface LinkedChatRoom {
  [NAME]?: string;
}

/**
 * Where the Loom keeps its chat room: a link to a room piece in the Loom's own
 * space, in `room`, absent while the Loom names none.
 */
export interface ChatRoomRecord {
  room?: Writable<LinkedChatRoom>;
}

/**
 * The shared chat-room cell; a Loom naming no room holds `{}`. It holds a
 * record rather than the link itself because a handler's cell for a field
 * holding a link writes through the link, so replacing the link there would
 * write into the room it names.
 */
export type ChatRoomCell = Writable<
  ChatRoomRecord | Default<Record<PropertyKey, never>>
>;

/** Shared state supplied when a Loom is instantiated. */
export interface LoomInput {
  title?: PerSpace<Writable<string | Default<"Shared Loom">>>;
  panels?: PerSpace<Writable<Writable<Panel>[] | Default<[]>>>;
  presentation?: PerSpace<
    Writable<Presentation | Default<{ stagedPanels: [] }>>
  >;
  participants?: PerSpace<ParticipantRosterCell>;
  chatRoom?: PerSpace<ChatRoomCell>;
}

/** The room `setChatRoom` names as the Loom's chat. Omission clears it. */
export interface ChatRoomChoice {
  room?: Writable<LinkedChatRoom>;
}

/** An occurrence and its optional insertion anchor. Omission appends. */
export interface PanelPosition {
  panel: Writable<Panel>;
  before?: Writable<Panel>;
}

/**
 * The profile under which the person adding a panel acts. Without one, the
 * root records the principal the event acted for; an event never names it.
 */
export interface PanelAdder {
  as?: ParticipantProfile;
}

/**
 * The event of every stream that adds a panel. Each is a binding of the one
 * handler that writes a panel's adder, so all three take this shape:
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
  chatRoom?: Writable<LinkedChatRoom>;
  setChatRoom: Stream<ChatRoomChoice>;
}
