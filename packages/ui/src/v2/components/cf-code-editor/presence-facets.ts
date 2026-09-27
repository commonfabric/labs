/**
 * The `caret` facet: what an editor publishes about its participant in a
 * presence room, and how a room's record becomes a participant the CodeMirror
 * presence extension renders. The relay carries a facet as an opaque plain
 * object, so this module is where the facet's shape is held to — strictly,
 * since a peer wrote it.
 */

import type { FabricPlainObject } from "@commonfabric/data-model";
import type { PresenceRecord } from "@commonfabric/runtime-client";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type {
  ParticipantPresence,
  PresenceCursor,
  PresenceSelectionJSON,
} from "./codemirror-presence.ts";

/** The facet name an editor's focus and selection travel under. */
export const CARET_FACET = "caret";

/** Failure categories safe to expose without room or participant data. */
export type PresenceFailureCategory =
  | "configuration"
  | "connection"
  | "protocol";

/** An editor's focus and selection, in confirmed memory coordinates. */
export interface CaretFacet {
  /** Whether the remote editor owns focus. */
  readonly focused: boolean;

  /** Memory cursor whose document coordinates contain `.selection`. */
  readonly cursor: PresenceCursor;

  /** The selection, or `null` before the participant establishes one. */
  readonly selection: PresenceSelectionJSON | null;

  /** Whether `.selection` is exact or mapped back over pending local edits. */
  readonly basis: "confirmed" | "provisional";
}

const maximumSelectionRanges = 16;
const maximumPosition = 2_147_483_647;

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

const isNonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isSelectionAssociation = (value: unknown): value is -1 | 0 | 1 =>
  value === -1 || value === 0 || value === 1;

const decodeCursor = (value: unknown): PresenceCursor => {
  if (
    !isObjectNotArray(value) || !hasExactKeys(value, ["epoch", "version"]) ||
    !isNonnegativeSafeInteger(value.epoch) ||
    !isNonnegativeSafeInteger(value.version) || value.epoch > maximumPosition ||
    value.version > maximumPosition
  ) {
    throw new Error("Presence cursor is invalid");
  }
  return { epoch: value.epoch, version: value.version };
};

const decodeSelection = (value: unknown): PresenceSelectionJSON | null => {
  if (value === null) return null;
  if (
    !isObjectNotArray(value) || !hasExactKeys(value, ["main", "ranges"]) ||
    !Array.isArray(value.ranges) || value.ranges.length === 0 ||
    value.ranges.length > maximumSelectionRanges ||
    !isNonnegativeSafeInteger(value.main) || value.main >= value.ranges.length
  ) {
    throw new Error("Presence selection is invalid");
  }
  const ranges = value.ranges.map((range) => {
    if (
      !isObjectNotArray(range) ||
      !hasExactKeys(range, ["anchor", "head", "assoc"]) ||
      !isNonnegativeSafeInteger(range.anchor) ||
      !isNonnegativeSafeInteger(range.head) || range.anchor > maximumPosition ||
      range.head > maximumPosition ||
      !isSelectionAssociation(range.assoc)
    ) {
      throw new Error("Presence selection range is invalid");
    }
    return { anchor: range.anchor, head: range.head, assoc: range.assoc };
  });
  return { ranges, main: value.main };
};

/**
 * Reads a `caret` facet strictly, or throws for any shape other than the one
 * `caretFacetOf()` writes: extra or missing keys, a non-integer position, a
 * range beyond the coordinate bound, a focused participant with no selection.
 */
export function decodeCaretFacet(value: unknown): CaretFacet {
  if (
    !isObjectNotArray(value) ||
    !hasExactKeys(value, ["focused", "cursor", "selection", "basis"]) ||
    typeof value.focused !== "boolean" ||
    (value.focused && value.selection === null) ||
    (value.basis !== "provisional" && value.basis !== "confirmed")
  ) {
    throw new Error("Presence caret facet is invalid");
  }
  return {
    focused: value.focused,
    cursor: decodeCursor(value.cursor),
    selection: decodeSelection(value.selection),
    basis: value.basis,
  };
}

/** Writes a `caret` facet in the form `decodeCaretFacet()` reads. */
export function caretFacetOf(caret: CaretFacet): FabricPlainObject {
  return {
    focused: caret.focused,
    cursor: { epoch: caret.cursor.epoch, version: caret.cursor.version },
    selection: caret.selection === null ? null : {
      ranges: caret.selection.ranges.map((range) => ({
        anchor: range.anchor,
        head: range.head,
        assoc: range.assoc,
      })),
      main: caret.selection.main,
    },
    basis: caret.basis,
  };
}

/**
 * Turns a room record into the participant the CodeMirror extension renders,
 * or returns `null` for a record carrying no readable `caret` facet — a
 * participant that has no caret to show, whatever else it publishes.
 */
export function participantFromRecord(
  record: PresenceRecord,
): ParticipantPresence | null {
  const facet = record.facets[CARET_FACET];
  if (facet === undefined) return null;
  let caret: CaretFacet;
  try {
    caret = decodeCaretFacet(facet);
  } catch {
    return null;
  }
  return {
    participantId: record.participantId,
    revision: record.revision,
    name: record.name,
    focused: caret.focused,
    cursor: caret.cursor,
    selection: caret.selection,
    basis: caret.basis,
  };
}

/**
 * The category an editor reports for a presence failure: a relay refusal is
 * `protocol`, a server or runtime without presence is `configuration`, and
 * anything else is the connection's.
 */
export function presenceFailureCategory(
  error: unknown,
): PresenceFailureCategory {
  if (!(error instanceof Error)) return "connection";
  if (error.name === "PresenceError") return "protocol";
  if (error.name === "ProtocolError") return "configuration";
  if (error.message.includes("does not support presence")) {
    return "configuration";
  }
  return "connection";
}
