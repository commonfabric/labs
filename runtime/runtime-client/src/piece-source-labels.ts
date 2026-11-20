/**
 * How a piece's recorded source facts read to a person: what a source
 * revision's operation is called, and what kind of origin a piece follows.
 * The origin kinds are defined by `docs/specs/piece-source-lifecycle.md`.
 */

import type {
  PieceOriginView,
  PieceSourceRevisionOperation,
} from "./protocol/types.ts";

/** An origin as a person reads it. */
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

/** What the operation that made a source revision is called. */
export function sourceOperationLabel(
  operation: PieceSourceRevisionOperation,
): string {
  switch (operation) {
    case "baseline":
      return "Baseline";
    case "create":
      return "Created from source";
    case "edit":
      return "Direct source edit";
    case "origin-update":
      return "Source update";
    case "detach":
      return "Stopped following source";
    case "revert":
      return "Restored source version";
    case "follow":
      return "Followed source";
    case "repoint":
      return "Followed earlier source";
  }
}
