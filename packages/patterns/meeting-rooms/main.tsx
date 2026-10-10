/**
 * Shared meeting creation decisions. Callers allocate an empty space after
 * reserving, record it here, then prepare only the recorded space.
 */

import {
  computed,
  currentPrincipal,
  handler,
  isWellFormedDID,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  Writable,
} from "commonfabric";

/** One calendar occurrence and a caller-retained creation attempt. */
export interface MeetingAttempt {
  /** Lowercase SHA-256 of the normalized calendar occurrence identity. */
  meeting: string;

  /** Opaque identifier persisted by the caller before reservation. */
  attempt: string;
}

/** An empty space on the directory's host, vetted by the allocating caller. */
export interface MeetingAllocation {
  /** Random space DID owned by the claim's creator. */
  space: string;

  /** Stable public cause for idempotent Loom root provisioning. */
  publicationSeed: string;
}

/** A retained creation attempt and its eventual immutable allocation. */
export interface MeetingClaim {
  /** Authenticated actor of the first committed reservation. */
  creator: string;

  /** Original attempt, retained across retries and creator devices. */
  attempt: string;

  /** Lifecycle state; unfamiliar future values are retained and refused. */
  state: string;

  /** The only space the creator may prepare for this occurrence. */
  allocation?: MeetingAllocation;
}

/** The winning creator's proposed empty-space allocation. */
export interface AllocateMeeting extends MeetingAttempt {
  /** Space and root cause to retain together. */
  allocation: MeetingAllocation;
}

/** An action result, authoritative only after its transaction commits. */
export type MeetingClaimResult =
  | { status: "reserved" | "allocated" | "existing" | "published" }
  | {
    status: "conflict";
    reason:
      | "missing"
      | "creator"
      | "attempt"
      | "allocation"
      | "unsupported-state"
      | "malformed-state";
  };

/** Raw storage selection preserves malformed fields for boundary validation. */
interface State {
  /** Occurrence records selected without schema filtering. */
  claims: Writable<Record<string, any>>;
}

/** Observable shared decisions and their transactional mutation handlers. */
export interface MeetingRoomsOutput {
  /** Human-readable piece name. */
  [NAME]: string;

  /** Retained decisions, containing only coordination metadata. */
  claims: PerSpace<Record<string, MeetingClaim>>;

  /** Retains the first authenticated creator and attempt for an occurrence. */
  reserve: Stream<MeetingAttempt, MeetingClaimResult>;

  /** Retains the first empty-space allocation submitted by that creator. */
  allocate: Stream<AllocateMeeting, MeetingClaimResult>;

  /** Records the creator's readiness after preparation in the retained space. */
  publish: Stream<MeetingAttempt, MeetingClaimResult>;
}

/** Helper for protocol validation, which recognizes bounded attempt strings. */
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Helper for protocol validation, which recognizes plain data records. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

/** Validates routing data while preserving additional future fields. */
export function isMeetingAllocation(
  value: unknown,
): value is MeetingAllocation {
  return record(value) && isWellFormedDID(value.space) &&
    identifier(value.publicationSeed);
}

/** Validates stored metadata, including the fields of unfamiliar states. */
export function isMeetingClaim(value: unknown): value is MeetingClaim {
  return record(value) && isWellFormedDID(value.creator) &&
    identifier(value.attempt) && typeof value.state === "string" &&
    value.state.length > 0 && value.state.length <= 64 &&
    (value.allocation === undefined || isMeetingAllocation(value.allocation)) &&
    (value.state !== "reserved" || value.allocation === undefined) &&
    (!(value.state === "allocated" || value.state === "ready") ||
      value.allocation !== undefined);
}

/** Helper for handlers, which validates occurrence and attempt identifiers. */
function validate(event: MeetingAttempt): void {
  if (
    !event || typeof event.meeting !== "string" ||
    !/^[a-f0-9]{64}$/.test(event.meeting) || !identifier(event.attempt)
  ) {
    throw new TypeError(
      "A meeting requires an opaque key and a retained attempt identifier.",
    );
  }
}

/** Helper for mutations, which checks the stored claim and actor. */
function conflict(
  current: unknown,
  event: MeetingAttempt,
): MeetingClaimResult | undefined {
  if (current === undefined) return { status: "conflict", reason: "missing" };
  if (!isMeetingClaim(current)) {
    return { status: "conflict", reason: "malformed-state" };
  }
  if (!["reserved", "allocated", "ready"].includes(current.state)) {
    return { status: "conflict", reason: "unsupported-state" };
  }
  if (current.creator !== currentPrincipal()) {
    return { status: "conflict", reason: "creator" };
  }
  if (current.attempt !== event.attempt) {
    return { status: "conflict", reason: "attempt" };
  }
}

/** Retains one creator in a transaction confined to the directory's space. */
const reserve = handler<MeetingAttempt, State, MeetingClaimResult>(
  (event, { claims }) => {
    validate(event);
    const creator = currentPrincipal();
    if (!creator) {
      throw new Error(
        "A meeting reservation requires an authenticated principal.",
      );
    }
    if (!record(claims.get())) {
      return { status: "conflict", reason: "malformed-state" };
    }
    const current = claims.key(event.meeting).get();
    if (current !== undefined) {
      if (!isMeetingClaim(current)) {
        return { status: "conflict", reason: "malformed-state" };
      }
      if (!["reserved", "allocated", "ready"].includes(current.state)) {
        return { status: "conflict", reason: "unsupported-state" };
      }
      return { status: "existing" };
    }
    claims.key(event.meeting).set({
      creator,
      attempt: event.attempt,
      state: "reserved",
    });
    return { status: "reserved" };
  },
);

/** Records an allocation before any Loom root or content may be provisioned. */
const allocate = handler<AllocateMeeting, State, MeetingClaimResult>(
  (event, { claims }) => {
    validate(event);
    if (!isMeetingAllocation(event.allocation)) {
      throw new TypeError(
        "A meeting allocation requires a space DID and publication seed.",
      );
    }
    if (!record(claims.get())) {
      return { status: "conflict", reason: "malformed-state" };
    }
    const current = claims.key(event.meeting).get();
    const refused = conflict(current, event);
    if (refused) return refused;
    if (current.allocation !== undefined) {
      return current.allocation.space === event.allocation.space &&
          current.allocation.publicationSeed ===
            event.allocation.publicationSeed
        ? { status: "existing" }
        : { status: "conflict", reason: "allocation" };
    }
    claims.key(event.meeting).key("allocation").set({
      space: event.allocation.space,
      publicationSeed: event.allocation.publicationSeed,
    });
    claims.key(event.meeting).key("state").set("allocated");
    return { status: "allocated" };
  },
);

/** Records preparation in the retained space without changing its allocation. */
const publish = handler<MeetingAttempt, State, MeetingClaimResult>(
  (event, { claims }) => {
    validate(event);
    if (!record(claims.get())) {
      return { status: "conflict", reason: "malformed-state" };
    }
    const current = claims.key(event.meeting).get();
    const refused = conflict(current, event);
    if (refused) return refused;
    if (current.allocation === undefined) {
      return { status: "conflict", reason: "allocation" };
    }
    claims.key(event.meeting).key("state").set("ready");
    return { status: "published" };
  },
);

export default pattern<Record<string, never>, MeetingRoomsOutput>(() => {
  const claims = new Writable.perSpace<Record<string, any>>({});
  return {
    [NAME]: "Meeting rooms",
    claims: computed(() => claims.get()),
    reserve: reserve({ claims }),
    allocate: allocate({ claims }),
    publish: publish({ claims }),
  };
});
