/**
 * Keeps remote editor presence in CodeMirror's transaction coordinate space.
 * Transport and document synchronization stay outside this module.
 */

import {
  type ChangeDesc,
  EditorSelection,
  type EditorState,
  type Extension,
  Facet,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

/** Memory operation coordinate space for one presence selection. */
export interface PresenceCursor {
  /** Current operation epoch. */
  readonly epoch: number;

  /** Integrated operation version within `.epoch`. */
  readonly version: number;
}

/** Wire form of a CodeMirror selection range, including side association. */
export interface PresenceSelectionRangeJSON {
  /** Fixed end of the selection range. */
  readonly anchor: number;

  /** Moving end of the selection range. */
  readonly head: number;

  /** CodeMirror side association retained for boundary mapping. */
  readonly assoc: -1 | 0 | 1;
}

/** Wire form of a CodeMirror editor selection. */
export interface PresenceSelectionJSON {
  /** All selection ranges, in CodeMirror's normalized order. */
  readonly ranges: readonly PresenceSelectionRangeJSON[];

  /** Index of the main range in `.ranges`. */
  readonly main: number;
}

/** Latest-value presence record for one remote participant. */
export interface ParticipantPresence {
  /** Server-owned identity for the participant's WebSocket connection. */
  readonly participantId: string;

  /** Strictly increasing replacement revision for this connection. */
  readonly revision: number;

  /** Untrusted plain-text participant label. */
  readonly name: string;

  /** Whether the remote editor owns focus. */
  readonly focused: boolean;

  /** Memory cursor whose document coordinates contain `.selection`. */
  readonly cursor: PresenceCursor;

  /** Remote selection, or `null` before this participant establishes one. */
  readonly selection: PresenceSelectionJSON | null;

  /** Whether `.selection` is exact or mapped back over pending local edits. */
  readonly basis: "confirmed" | "provisional";
}

/** Presence selection currently mapped through the local editor document. */
export interface DisplayedParticipantPresence {
  /** Source record from which this displayed state was installed. */
  readonly record: ParticipantPresence;

  /** Selection in the current local CodeMirror document. */
  readonly selection: EditorSelection | null;
}

/** Receiver state retained independently for one participant. */
export interface ParticipantPresenceState {
  /** Newest accepted record, which may still be in a future Memory version. */
  readonly latest: ParticipantPresence | undefined;

  /** Last record that could be installed and mapped through local changes. */
  readonly displayed: DisplayedParticipantPresence | undefined;
}

/** Complete remote-presence state held by the CodeMirror extension. */
export interface CodeMirrorPresenceState {
  /** Confirmed Memory cursor known by the local editor. */
  readonly cursor: PresenceCursor;

  /** Latest and displayed state keyed by server-owned participant id. */
  readonly participants: ReadonlyMap<string, ParticipantPresenceState>;

  /** Decorations derived from every currently displayed participant. */
  readonly decorations: DecorationSet;
}

/** Maximum Unicode code points shown in a remote participant label. */
export const MAX_RENDERED_PRESENCE_NAME_LENGTH = 80;

/** Maximum remote participant records retained by one editor. */
export const MAX_PRESENCE_PARTICIPANTS = 128;

/** Upsert input together with the receiver's current local overlay. */
export interface CodeMirrorPresenceUpsert {
  /** Remote record expressed in its confirmed Memory coordinates. */
  readonly participant: ParticipantPresence;

  /** Receiver changes from that confirmed document to its local document. */
  readonly pendingChanges: readonly ChangeDesc[];
}

/** Cursor advancement together with the receiver's rebased local overlay. */
export interface CodeMirrorPresenceCursorAdvance {
  /** Newly confirmed Memory cursor. */
  readonly cursor: PresenceCursor;

  /** Receiver changes from the new confirmed document to its local document. */
  readonly pendingChanges: readonly ChangeDesc[];
}

const PARTICIPANT_COLORS = [
  "#0b57d0",
  "#b3261e",
  "#146c2e",
  "#6f3096",
  "#8b5000",
  "#00677d",
  "#4f52a5",
  "#a31545",
] as const;

/** Installs or replaces one remote participant record. */
export const codeMirrorPresenceUpsertEffect = StateEffect.define<
  CodeMirrorPresenceUpsert
>();

/** Removes one remote participant by its server-owned id. */
export const codeMirrorPresenceRemoveEffect = StateEffect.define<string>();

/** Advances the confirmed Memory coordinate space used by presence. */
export const codeMirrorPresenceCursorEffect = StateEffect.define<
  CodeMirrorPresenceCursorAdvance
>();

/** Removes every remote participant without changing the Memory cursor. */
export const codeMirrorPresenceClearEffect = StateEffect.define<null>();

const initialCursorFacet = Facet.define<PresenceCursor, PresenceCursor>({
  combine: (values) => values.at(-1) ?? { epoch: 0, version: 0 },
});

/** Bounds an untrusted name without splitting a Unicode code point. */
const boundedPresenceName = (name: string): string =>
  Array.from(name).slice(0, MAX_RENDERED_PRESENCE_NAME_LENGTH).join("");

/** Returns a stable, accessible palette color for a participant id. */
export function presenceParticipantColor(participantId: string): string {
  return PARTICIPANT_COLORS[presenceParticipantColorIndex(participantId)];
}

/** Selects one fixed palette entry using stable FNV-1a hashing. */
const presenceParticipantColorIndex = (participantId: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < participantId.length; index++) {
    hash ^= participantId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % PARTICIPANT_COLORS.length;
};

/** Combines pending changes from the confirmed document to the local one. */
export function composePendingChangeDesc(
  pending: readonly ChangeDesc[],
): ChangeDesc | undefined {
  let composed = pending[0];
  for (let index = 1; index < pending.length; index++) {
    composed = composed.composeDesc(pending[index]);
  }
  return composed;
}

/** Maps a local selection back into the last confirmed document. */
export function mapSelectionToConfirmed(
  selection: EditorSelection,
  pending: readonly ChangeDesc[],
): EditorSelection {
  const composed = composePendingChangeDesc(pending);
  if (composed === undefined) return selection;
  const inverse = composed.invertedDesc;
  return EditorSelection.create(
    selection.ranges.map((range) => {
      if (!range.empty) return range.map(inverse, range.assoc);

      const associations = [range.assoc, -1, 0, 1] as const;
      let best:
        | { assoc: -1 | 0 | 1; position: number; distance: number }
        | undefined;
      for (const assoc of associations) {
        const position = inverse.mapPos(range.head, assoc);
        const roundTrip = composed.mapPos(position, assoc);
        const distance = Math.abs(roundTrip - range.head);
        if (best === undefined || distance < best.distance) {
          best = { assoc, position, distance };
        }
      }
      return EditorSelection.cursor(best!.position, best!.assoc);
    }),
    selection.mainIndex,
  );
}

/** Serializes a selection while retaining CodeMirror range associations. */
export function presenceSelectionToJSON(
  selection: EditorSelection,
): PresenceSelectionJSON {
  return {
    ranges: selection.ranges.map((range) => ({
      anchor: range.anchor,
      head: range.head,
      assoc: range.assoc,
    })),
    main: selection.mainIndex,
  };
}

/** Renders a remote caret and the bounded name attached to its main range. */
class RemoteCaretWidget extends WidgetType {
  readonly #name: string;
  readonly #colorIndex: number;
  readonly #showName: boolean;

  /** Constructs an instance for one remote selection head. */
  constructor(name: string, colorIndex: number, showName: boolean) {
    super();
    this.#name = boundedPresenceName(name);
    this.#colorIndex = colorIndex;
    this.#showName = showName;
  }

  /** @inheritDoc */
  override eq(other: RemoteCaretWidget): boolean {
    return this.#name === other.#name &&
      this.#colorIndex === other.#colorIndex &&
      this.#showName === other.#showName;
  }

  /** @inheritDoc */
  override toDOM(view: EditorView): HTMLElement {
    const caret = view.dom.ownerDocument.createElement("span");
    caret.className = "cm-remote-presence-caret " +
      `cm-remote-presence-color-${this.#colorIndex}`;
    caret.setAttribute("aria-label", `${this.#name}'s cursor`);
    caret.setAttribute("role", "img");

    if (this.#showName) {
      const label = view.dom.ownerDocument.createElement("span");
      label.className = "cm-remote-presence-name";
      label.textContent = this.#name;
      caret.append(label);
    }

    return caret;
  }
}

/** Decodes a selection when every range fits the current document. */
const decodeSelection = (
  record: ParticipantPresence,
  documentLength: number,
): EditorSelection | undefined => {
  if (record.selection === null) return undefined;
  if (
    record.selection.ranges.length === 0 ||
    !Number.isInteger(record.selection.main) ||
    record.selection.main < 0 ||
    record.selection.main >= record.selection.ranges.length ||
    record.selection.ranges.some((range) =>
      !Number.isInteger(range.anchor) || !Number.isInteger(range.head) ||
      range.anchor < 0 || range.head < 0 || range.anchor > documentLength ||
      range.head > documentLength ||
      (range.assoc !== -1 && range.assoc !== 0 && range.assoc !== 1)
    )
  ) {
    return undefined;
  }
  return EditorSelection.create(
    record.selection.ranges.map((range) =>
      EditorSelection.range(
        range.anchor,
        range.head,
        undefined,
        undefined,
        range.assoc,
      )
    ),
    record.selection.main,
  );
};

/** Installs one record as state in the local document coordinate space. */
const displayRecord = (
  record: ParticipantPresence,
  documentLength: number,
  pendingChanges: readonly ChangeDesc[],
): DisplayedParticipantPresence | undefined => {
  let composed: ChangeDesc | undefined;
  try {
    composed = composePendingChangeDesc(pendingChanges);
  } catch {
    return undefined;
  }
  if (composed !== undefined && composed.newLength !== documentLength) {
    return undefined;
  }
  if (record.selection === null) {
    return { record, selection: null };
  }
  const selection = decodeSelection(
    record,
    composed?.length ?? documentLength,
  );
  if (selection === undefined) return undefined;
  return {
    record,
    selection: composed === undefined
      ? selection
      : mapSelectionWithAssociations(selection, composed),
  };
};

/** Maps every range with the side association carried by that range. */
const mapSelectionWithAssociations = (
  selection: EditorSelection,
  changes: ChangeDesc,
): EditorSelection =>
  EditorSelection.create(
    selection.ranges.map((range) => range.map(changes, range.assoc)),
    selection.mainIndex,
  );

/** Maps installed selection coordinates through one CodeMirror transaction. */
const mapDisplayed = (
  displayed: DisplayedParticipantPresence | undefined,
  changes: ChangeDesc,
): DisplayedParticipantPresence | undefined => {
  if (displayed === undefined || displayed.selection === null) {
    return displayed;
  }
  return {
    ...displayed,
    selection: mapSelectionWithAssociations(displayed.selection, changes),
  };
};

/** Builds marks and caret widgets from the currently displayed selections. */
const buildDecorations = (
  participants: ReadonlyMap<string, ParticipantPresenceState>,
): DecorationSet => {
  const ranges: Range<Decoration>[] = [];
  for (const [participantId, participant] of participants) {
    const displayed = participant.displayed;
    if (displayed === undefined || displayed.selection === null) continue;
    const colorIndex = presenceParticipantColorIndex(participantId);
    const name = boundedPresenceName(displayed.record.name);
    displayed.selection.ranges.forEach((selectionRange, rangeIndex) => {
      if (!selectionRange.empty) {
        ranges.push(
          Decoration.mark({
            attributes: {
              class: "cm-remote-presence-selection " +
                `cm-remote-presence-color-${colorIndex}`,
              title: `${name}'s selection`,
            },
          }).range(selectionRange.from, selectionRange.to),
        );
      }
      ranges.push(
        Decoration.widget({
          side: 1,
          widget: new RemoteCaretWidget(
            name,
            colorIndex,
            rangeIndex === displayed.selection!.mainIndex,
          ),
        }).range(selectionRange.head),
      );
    });
  }
  return Decoration.set(ranges, true);
};

/** Maps every displayed participant through a CodeMirror transaction. */
const mapParticipants = (
  participants: ReadonlyMap<string, ParticipantPresenceState>,
  changes: ChangeDesc,
): Map<string, ParticipantPresenceState> => {
  const mapped = new Map<string, ParticipantPresenceState>();
  for (const [participantId, participant] of participants) {
    mapped.set(participantId, {
      latest: participant.latest,
      displayed: mapDisplayed(participant.displayed, changes),
    });
  }
  return mapped;
};

/** Reconciles queued participant records with a confirmed cursor advance. */
const applyCursor = (
  participants: Map<string, ParticipantPresenceState>,
  previous: PresenceCursor,
  next: PresenceCursor,
  documentLength: number,
  pendingChanges: readonly ChangeDesc[],
): Map<string, ParticipantPresenceState> => {
  if (next.epoch !== previous.epoch) return new Map();
  if (next.version < previous.version) return participants;

  for (const [participantId, participant] of participants) {
    const latest = participant.latest;
    if (latest === undefined) continue;
    if (latest.cursor.epoch !== next.epoch) {
      participants.delete(participantId);
      continue;
    }
    if (latest.cursor.version === next.version) {
      const displayed = displayRecord(latest, documentLength, pendingChanges);
      if (displayed !== undefined) {
        participants.set(participantId, { latest, displayed });
      } else if (participant.displayed === undefined) {
        participants.delete(participantId);
      } else {
        participants.set(participantId, {
          latest: undefined,
          displayed: participant.displayed,
        });
      }
      continue;
    }
    if (
      latest.cursor.version < next.version &&
      latest.revision !== participant.displayed?.record.revision
    ) {
      if (participant.displayed === undefined) {
        participants.delete(participantId);
      } else {
        participants.set(participantId, {
          latest: undefined,
          displayed: participant.displayed,
        });
      }
    }
  }
  return participants;
};

const presenceField = StateField.define<CodeMirrorPresenceState>({
  create: (state) => ({
    cursor: state.facet(initialCursorFacet),
    participants: new Map(),
    decorations: Decoration.none,
  }),
  update: (value, transaction) => {
    let cursor = value.cursor;
    let participants = mapParticipants(value.participants, transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(codeMirrorPresenceClearEffect)) {
        participants = new Map();
        continue;
      }
      if (effect.is(codeMirrorPresenceRemoveEffect)) {
        participants.delete(effect.value);
        continue;
      }
      if (effect.is(codeMirrorPresenceCursorEffect)) {
        const next = effect.value.cursor;
        participants = applyCursor(
          participants,
          cursor,
          next,
          transaction.newDoc.length,
          effect.value.pendingChanges,
        );
        if (
          next.epoch !== cursor.epoch || next.version >= cursor.version
        ) {
          cursor = next;
        }
        continue;
      }
      if (effect.is(codeMirrorPresenceUpsertEffect)) {
        const record = effect.value.participant;
        const existing = participants.get(record.participantId);
        const existingRevision = Math.max(
          existing?.latest?.revision ?? -1,
          existing?.displayed?.record.revision ?? -1,
        );
        if (record.revision <= existingRevision) {
          continue;
        }
        if (record.cursor.epoch !== cursor.epoch) {
          participants.delete(record.participantId);
          continue;
        }
        if (record.cursor.version < cursor.version) continue;
        if (
          existing === undefined &&
          participants.size >= MAX_PRESENCE_PARTICIPANTS
        ) {
          continue;
        }
        if (record.cursor.version > cursor.version) {
          participants.set(record.participantId, {
            latest: record,
            displayed: existing?.displayed,
          });
          continue;
        }
        const displayed = displayRecord(
          record,
          transaction.newDoc.length,
          effect.value.pendingChanges,
        );
        if (displayed !== undefined) {
          participants.set(record.participantId, {
            latest: record,
            displayed,
          });
        }
      }
    }

    return {
      cursor,
      participants,
      decorations: buildDecorations(participants),
    };
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

const presenceTheme = EditorView.baseTheme({
  ".cm-remote-presence-selection": {
    backgroundColor:
      "color-mix(in srgb, var(--cm-remote-presence-color) 24%, transparent)",
  },
  ".cm-remote-presence-caret": {
    borderLeft: "2px solid var(--cm-remote-presence-color)",
    boxSizing: "border-box",
    display: "inline-block",
    height: "1.2em",
    marginLeft: "-1px",
    pointerEvents: "none",
    position: "relative",
    verticalAlign: "text-bottom",
    width: 0,
    zIndex: 1,
  },
  ".cm-remote-presence-name": {
    backgroundColor: "var(--cm-remote-presence-color)",
    borderRadius: "2px",
    color: "white",
    fontFamily: "var(--cf-theme-font-family, sans-serif)",
    fontSize: "0.7rem",
    fontWeight: "600",
    insetBlockEnd: "100%",
    insetInlineStart: "-2px",
    lineHeight: "1.2",
    maxWidth: "20rem",
    overflow: "hidden",
    padding: "1px 4px",
    position: "absolute",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ...Object.fromEntries(PARTICIPANT_COLORS.map((color, index) => [
    `.cm-remote-presence-color-${index}`,
    { "--cm-remote-presence-color": color },
  ])),
});

/** Installs remote presence at one confirmed Memory operation cursor. */
export function codeMirrorPresence(initialCursor: PresenceCursor): Extension {
  return [initialCursorFacet.of(initialCursor), presenceField, presenceTheme];
}

/** Reads remote presence when the extension is installed in `state`. */
export function codeMirrorPresenceState(
  state: EditorState,
): CodeMirrorPresenceState | undefined {
  return state.field(presenceField, false);
}
