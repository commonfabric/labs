/**
 * Sorts the failure of a presence room into what a component may tell
 * whoever is outside it. A category names no room, participant, or server
 * payload, so it is safe to hand to a pattern's markup or a sandboxed guest.
 */

/** Failure categories safe to expose without room or participant data. */
export type PresenceFailureCategory =
  | "configuration"
  | "connection"
  | "protocol";

/**
 * The category a component reports for a presence failure: a relay refusal
 * is `protocol`, a server or runtime without presence is `configuration`,
 * and anything else, another protocol failure among them, is the
 * connection's. Only `configuration` says that joining again cannot help.
 */
export function presenceFailureCategory(
  error: unknown,
): PresenceFailureCategory {
  if (!(error instanceof Error)) return "connection";
  if (error.name === "PresenceError") return "protocol";
  if (error.message.includes("does not support presence")) {
    return "configuration";
  }
  return "connection";
}
