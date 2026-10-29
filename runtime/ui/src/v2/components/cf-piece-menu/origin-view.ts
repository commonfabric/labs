/**
 * How a piece's recorded source facts read to a person.
 *
 * The origin kinds these describe are defined by
 * `docs/specs/piece-source-lifecycle.md`; the runtime classifies a piece's
 * recorded source into one of them and the panel names it.
 */

import {
  STORED_ARGUMENT_SCHEMA_REFUSAL,
  storedArgumentRefusalDetail,
} from "@commonfabric/runner/shared";
import type {
  PieceOriginView,
  PieceReconciliationView,
  PieceSourceView,
} from "@commonfabric/runtime-client";

export interface OriginDescription {
  /** Short label naming the kind of origin. */
  label: string;

  /** One sentence on what that origin can do. */
  detail: string;
}

/** How an origin reads to a person, including the detached case. */
export function describeOrigin(
  origin: PieceOriginView | undefined,
): OriginDescription {
  if (origin === undefined) {
    return {
      label: "Detached",
      detail: "This piece records no origin, so nothing supplies new code " +
        "for it. It is the only durable reference to the source it runs.",
    };
  }
  switch (origin.kind) {
    case "system":
      return {
        label: "Deployment pattern",
        detail: "A pattern this deployment serves; a new release of the " +
          "deployment can replace it.",
      };
    case "fabric-piece":
      return {
        label: "Fabric piece",
        detail: "A stable piece in the fabric; the origin names whichever " +
          "pattern that piece currently runs.",
      };
    case "fabric-pattern":
      return {
        label: "Exact pattern",
        detail: "Content-addressed source: this origin always resolves to " +
          "the same code.",
      };
  }
}

/** A content identity abbreviated for display; the full value stays in a title. */
function shortIdentity(identity: string): string {
  return identity.length > 14 ? `${identity.slice(0, 12)}…` : identity;
}

/**
 * A pattern named for display: its content identity, abbreviated unless the
 * whole value is asked for, and the export within it that is the pattern.
 * Naming the export as one and quoting it marks the name as an identifier
 * taken from the source.
 */
export function patternRefLabel(
  ref: { identity: string; symbol: string },
  options?: { whole?: boolean },
): string {
  const identity = options?.whole ? ref.identity : shortIdentity(ref.identity);
  return `${identity} (export symbol "${ref.symbol}")`;
}

/** A recorded timestamp as a readable local time. */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * Which state a piece's source is in.
 *
 * `following`, `unknown`, `unreachable`, and `refused` all record an origin.
 * What separates them is what the last attempt to follow it did, which is why
 * an origin alone cannot say — and `unknown` is the case where nothing has
 * tried, which reads as up to date unless it is named. `unusable` records a
 * string nothing can follow, which is not detachment: the piece carries
 * something a person can repair.
 */
export type FollowState =
  | "following"
  | "unknown"
  | "unreachable"
  | "refused"
  | "detached"
  | "unusable";

export interface FollowDescription {
  state: FollowState;

  /**
   * Short label naming the state, for the row whose heading supplies the
   * subject. It is not a sentence: "Unknown" says what it means under
   * "Source updates" and nothing at all on its own.
   */
  label: string;

  /** What happened, as a sentence that stands without that heading. */
  summary: string;

  /** What follows from it, and whether it resolves itself. */
  detail: string;

  /**
   * What the attempt reported, shown on a line of its own. It is kept out of
   * `detail` because a compiler's report is not a clause: it can run to many
   * lines, and folding one into a sentence produces neither.
   */
  reason?: string;

  /** When the piece reached this state, when that is recorded. */
  at?: number;

  /** The pattern the origin offered, when one was resolved. */
  offered?: { identity: string; symbol: string };

  /**
   * Whether asking the origin now is worth offering. It is not when the
   * origin has just been asked and offered what the piece runs: a button to
   * fix a state that is not broken reads as though something is.
   */
  canUpdate: boolean;

  /**
   * Whether an update that overrides the compatibility check is worth
   * offering. Only a refusal over a contract mismatch earns it. Offering to
   * ignore a check nothing has failed invites the reader to wonder what they
   * are being protected from.
   */
  canForce: boolean;
}

/** Why this piece did not take what its origin offered. */
function refusalReason(reconciliation: PieceReconciliationView): string {
  if (reconciliation.detail !== undefined) return reconciliation.detail;
  switch (reconciliation.reason) {
    case "incompatible-schema":
      return "the new source's inputs or outputs do not match the ones this " +
        "piece runs";
    case "argument-mismatch":
      return "the data this piece holds does not fit the new source";
    case "source-invalid":
      return "the source the origin offered could not be used";
    case "identity-mismatch":
      return "the source did not match the version its origin advertised";
    case "apply-failed":
      return "the new source could not be applied to this piece";
    default:
      return "the piece did not take what the origin offered";
  }
}

/** Whether a piece is running what its origin offers, and how that reads. */
export function describeFollowState(
  source: PieceSourceView,
): FollowDescription {
  if (source.unusableOrigin !== undefined) {
    return {
      state: "unusable",
      label: "Origin cannot be followed",
      summary: "Nothing can follow the source this piece records.",
      detail: "The piece has not been detached — it is carrying a source " +
        "someone can read and repair.",
      reason: source.unusableOrigin.reason,
      canUpdate: false,
      canForce: false,
    };
  }
  if (source.origin === undefined) {
    return {
      state: "detached",
      label: "Not following a source",
      summary: "This piece records no origin.",
      detail: "Nothing supplies new code for it.",
      canUpdate: false,
      canForce: false,
    };
  }
  const reconciliation = source.reconciliation;
  if (reconciliation === undefined) {
    return {
      state: "unknown",
      label: "Unknown",
      summary: "Nothing has looked for new source at this origin.",
      detail: "The piece is running the source it last accepted, which may " +
        "or may not be what the origin offers now.",
      canUpdate: true,
      canForce: false,
    };
  }
  if (reconciliation.outcome === "followed") {
    return {
      state: "following",
      label: "Up to date",
      summary: "This piece is running the source its origin offered.",
      detail: "",
      at: reconciliation.at,
      ...(reconciliation.offered === undefined
        ? {}
        : { offered: reconciliation.offered }),
      canUpdate: false,
      canForce: false,
    };
  }
  if (reconciliation.outcome === "unreachable") {
    return {
      state: "unreachable",
      label: "Could not reach the origin",
      summary: "This piece could not reach its origin.",
      detail: "It is running the source it last accepted. This may right " +
        "itself when the origin comes back.",
      reason: reconciliation.detail ?? "the origin did not answer",
      at: reconciliation.at,
      ...(reconciliation.offered === undefined
        ? {}
        : { offered: reconciliation.offered }),
      canUpdate: true,
      canForce: false,
    };
  }
  return {
    state: "refused",
    label: "New source refused",
    summary: "The origin offered new source and this piece did not take it.",
    // The one refusal with no override behind it needs to say so, or its box
    // reads as one whose button someone forgot to add.
    detail: reconciliation.reason === "argument-mismatch"
      ? "The new source cannot run on the data this piece holds, so there " +
        "is nothing to overrule — the data would have to change first. " +
        "Until then the piece runs the source it last accepted, and can " +
        "stop following this origin or go back to an earlier version."
      : "The piece is running the source it last accepted, and this will " +
        "happen again every time the piece is opened.",
    reason: refusalReason(reconciliation),
    at: reconciliation.at,
    ...(reconciliation.offered === undefined
      ? {}
      : { offered: reconciliation.offered }),
    canUpdate: true,
    canForce: reconciliation.reason === "incompatible-schema",
  };
}

/** How a refused attempt to follow a typed source reads. */
export interface SourceFailureDescription {
  /** What went wrong, and whether anything can be done about it. */
  summary: string;

  /** What the attempt reported, on a line of its own. */
  reason: string;
}

/**
 * A failed attempt to follow a source, as a person reads it.
 *
 * One failure is singled out. A candidate the piece's own stored data cannot
 * satisfy is the refusal no confirmation gets past, and it arrives as a
 * message naming the rule it broke before the part worth reading. Left as it
 * came, it reads as an operation that went wrong and might go right next time,
 * beside a dialog offering no way to insist — so it says instead that the data
 * is what would have to change.
 */
export function describeSourceFailure(
  message: string,
): SourceFailureDescription {
  if (message.startsWith(`${STORED_ARGUMENT_SCHEMA_REFUSAL}:`)) {
    return {
      summary: "That source cannot run on the data this piece holds, so " +
        "following it is not something this piece can be told to do anyway. " +
        "The data would have to change first.",
      reason: storedArgumentRefusalDetail(message),
    };
  }
  return { summary: "Could not follow that source.", reason: message };
}
