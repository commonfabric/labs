/**
 * The handler a memory server runs `served` requests through
 * (04-protocol.md §4.3.12; docs/plans/serving-loop-owner-routing.md): the
 * crossings a serving loop elsewhere in the deployment sends the process
 * that owns the target space. The memory package sits below the runner and
 * cannot build the handler itself, so the process that runs the serving loop
 * installs it with `Server.setServedRequestHandler()`, beside the lifecycle
 * verbs' handler. The sender's side is `routed-plane.ts`.
 */

import type { FabricPlainObject } from "@commonfabric/api";
import { isFabricPlainObject } from "@commonfabric/data-model";
import { getLogger } from "@commonfabric/logger";
import { decodeMemoryBoundary, ProtocolError } from "@commonfabric/memory/v2";
import type {
  ServedRequestCall,
  ServedRequestHandler,
  ServedRequestOutcome,
  Server,
} from "@commonfabric/memory/v2/server";
import {
  commitForeignWaveBatch,
  foreignWaveCommitNotice,
} from "./engine-wave-sink.ts";
import {
  type ServedAclChangeData,
  servedAclChangeOf,
} from "./served-acl-change.ts";
import type { WaveSpaceCommit } from "./wave.ts";

/**
 * One delegated event append as a `served` request's `append` body carries
 * it: the entry `Server.commitDelegatedAppend` takes, without the target
 * space, which the session names, and without the session, which is the
 * routed session the request came on. `localSeq` is the sender's, numbered
 * on the routed session by the plane that sent it.
 */
export type ServedAppendEntry = Omit<
  Parameters<Server["commitDelegatedAppend"]>[0],
  "targetSpace" | "sessionId"
>;

/** What the owner answers an `append` with. */
export type ServedAppendResult = { seq?: number; deduped: boolean };

/** The memory server as the handler uses it. */
export type ServedRequestServer = Pick<
  Server,
  | "commitDelegatedAppend"
  | "engineForSpace"
  | "noteExecutorCommit"
  | "commitServedAclChange"
>;

const logger = getLogger("served-requests", {
  enabled: true,
  level: "warn",
});

/**
 * Whether `value` is a sender's position for a crossing: a safe integer
 * from zero, as the plane numbers them. Read the same way for every kind,
 * so a body with another kind of number is refused before it reaches the
 * commit's bookkeeping.
 */
const isLocalSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The refusal of a body that reads as no crossing of its kind. */
const unreadable = (
  kind: string,
  field: string,
): ServedRequestOutcome => ({
  refusal: {
    code: "refused",
    message: `The ${kind} carries no readable \`${field}\`, so it is refused`,
  },
});

/**
 * Reads an `append` body as the entry it carries, or returns the reason it
 * is not one. A body a sender built from an outbox row always reads; one
 * that does not is refused deterministically, since sending it again would
 * read the same way.
 */
const readAppendEntry = (
  body: FabricPlainObject,
): { entry: ServedAppendEntry } | { invalid: string } => {
  const {
    targetStream,
    targetStreamLink,
    eventId,
    payload,
    actingPrincipal,
    actingSession,
    sessionlessSpaceScope,
    capabilityRef,
    localSeq,
  } = body;
  if (typeof targetStream !== "string") return { invalid: "targetStream" };
  if (typeof eventId !== "string") return { invalid: "eventId" };
  if (typeof capabilityRef !== "string") return { invalid: "capabilityRef" };
  if (!isLocalSeq(localSeq)) {
    return { invalid: "localSeq" };
  }
  if (
    targetStreamLink !== undefined && !isFabricPlainObject(targetStreamLink)
  ) {
    return { invalid: "targetStreamLink" };
  }
  if (actingPrincipal !== undefined && typeof actingPrincipal !== "string") {
    return { invalid: "actingPrincipal" };
  }
  if (actingSession !== undefined && typeof actingSession !== "string") {
    return { invalid: "actingSession" };
  }
  if (
    sessionlessSpaceScope !== undefined &&
    typeof sessionlessSpaceScope !== "boolean"
  ) {
    return { invalid: "sessionlessSpaceScope" };
  }
  return {
    entry: {
      targetStream,
      ...(targetStreamLink === undefined ? {} : {
        targetStreamLink: targetStreamLink as NonNullable<
          ServedAppendEntry["targetStreamLink"]
        >,
      }),
      eventId,
      payload,
      ...(actingPrincipal === undefined ? {} : { actingPrincipal }),
      ...(actingSession === undefined ? {} : { actingSession }),
      ...(sessionlessSpaceScope === undefined ? {} : { sessionlessSpaceScope }),
      capabilityRef,
      localSeq,
    },
  };
};

/**
 * Runs an `append`: `commitDelegatedAppend` on the session's space under the
 * routed session, answered with the seq it committed at, or that the owner's
 * eventId horizon deduped it. The engine's `ProtocolError` is the
 * deterministic refusal the sender does not retry; a body that is not an
 * entry is refused the same way.
 */
const runAppend = async (
  server: ServedRequestServer,
  call: ServedRequestCall,
): Promise<ServedRequestOutcome> => {
  const read = readAppendEntry(call.body);
  if ("invalid" in read) return unreadable("append", read.invalid);
  try {
    const result = await server.commitDelegatedAppend({
      ...read.entry,
      targetSpace: call.space,
      sessionId: call.sessionId,
    });
    const ok: ServedAppendResult = {
      deduped: result.deduped,
      ...(result.seq === undefined ? {} : { seq: result.seq }),
    };
    return { ok };
  } catch (error) {
    if (error instanceof ProtocolError) {
      return { refusal: { code: "refused", message: error.message } };
    }
    throw error;
  }
};

/**
 * Runs a `commit`: the foreign wave batch the body carries, in the memory
 * boundary's encoding, committed against the session's space as the sender's
 * own sink commits a foreign batch (protocol.md §2b), keyed by the routed
 * session and the sender's number, and reported to this server as a warm
 * authored commit, which activates the space here. Every failure of that
 * commit is answered as `refused`, the admission's refusals and the store's
 * failures alike, since the sender replays the event on every answer but
 * success; a batch for another space, or a home one, is refused the same
 * way.
 */
const runCommit = async (
  server: ServedRequestServer,
  call: ServedRequestCall,
): Promise<ServedRequestOutcome> => {
  const { batch: encoded, localSeq } = call.body;
  if (typeof encoded !== "string") return unreadable("commit", "batch");
  if (!isLocalSeq(localSeq)) return unreadable("commit", "localSeq");
  const decoded = decodeMemoryBoundary(encoded);
  if (!isFabricPlainObject(decoded) || decoded.space !== call.space) {
    return {
      refusal: {
        code: "refused",
        message: "The commit carries no batch into the session's space",
      },
    };
  }
  if (
    !Array.isArray(decoded.operations) || !Array.isArray(decoded.preconditions)
  ) {
    return unreadable("commit", "batch");
  }
  if (decoded.home !== false) {
    return {
      refusal: {
        code: "refused",
        message: "The commit carries a home batch, which only the loop of " +
          "the batch's own space commits",
      },
    };
  }
  const batch = decoded as unknown as WaveSpaceCommit;
  const engine = await server.engineForSpace(call.space);
  // No principal, as the sender's own sink passes none: the commit is keyed
  // by the routed session and the sender's number alone.
  const result = commitForeignWaveBatch(engine, batch, {
    sessionId: call.sessionId,
    localSeq,
  });
  if (result.error !== undefined) {
    return { refusal: { code: "refused", message: result.error.message } };
  }
  try {
    const notice = foreignWaveCommitNotice(engine, batch, result.ok.seq);
    if (notice !== undefined) server.noteExecutorCommit(notice);
  } catch (error) {
    // The batch is in the store whatever the report did, so a failure to
    // announce it is logged rather than answered as a failed commit, which
    // would have the sender replay the event over a batch that landed.
    logger.error("served-commit-report-failed", () => [
      `reporting the served commit at seq ${result.ok.seq} in ${call.space} ` +
      "failed",
      error,
    ]);
  }
  return { ok: { seq: result.ok.seq } };
};

/**
 * Reads an `acl` body as the change it carries, or returns the field that
 * does not read.
 */
const readAclChange = (
  body: FabricPlainObject,
): { change: ServedAclChangeData } | { invalid: string } => {
  const { change } = body;
  if (!isFabricPlainObject(change)) return { invalid: "change" };
  const { space, actingPrincipal, actingSession, capabilityRef, sourceEvent } =
    change;
  if (typeof space !== "string") return { invalid: "change.space" };
  if (typeof actingPrincipal !== "string") {
    return { invalid: "change.actingPrincipal" };
  }
  if (actingSession !== undefined && typeof actingSession !== "string") {
    return { invalid: "change.actingSession" };
  }
  if (typeof capabilityRef !== "string") {
    return { invalid: "change.capabilityRef" };
  }
  if (
    !isFabricPlainObject(sourceEvent) ||
    typeof sourceEvent.space !== "string" ||
    typeof sourceEvent.sidecarId !== "string" ||
    typeof sourceEvent.eventId !== "string"
  ) {
    return { invalid: "change.sourceEvent" };
  }
  if (
    !Array.isArray(change.changes) ||
    change.changes.some((item) =>
      !isFabricPlainObject(item) || typeof item.principal !== "string" ||
      (item.level !== undefined && typeof item.level !== "string") ||
      item.actor !== actingPrincipal
    )
  ) {
    return { invalid: "change.changes" };
  }
  return {
    change: {
      space,
      actingPrincipal,
      ...(actingSession === undefined ? {} : { actingSession }),
      capabilityRef,
      sourceEvent: {
        space: sourceEvent.space,
        sidecarId: sourceEvent.sidecarId,
        eventId: sourceEvent.eventId,
      },
      changes: change.changes as ServedAclChangeData["changes"],
    },
  };
};

/**
 * Runs an `acl`: the served access-list change the body carries, as the
 * list of changes, rebuilt and committed by this server's own admission
 * (`Server.commitServedAclChange()`) under the routed session and the
 * sender's number. The server's refusal is answered as `refused`; the answer
 * carries the commit's seq, or none where the change left the list as it was.
 */
const runAcl = async (
  server: ServedRequestServer,
  call: ServedRequestCall,
): Promise<ServedRequestOutcome> => {
  const { localSeq } = call.body;
  if (!isLocalSeq(localSeq)) return unreadable("acl", "localSeq");
  const read = readAclChange(call.body);
  if ("invalid" in read) return unreadable("acl", read.invalid);
  if (read.change.space !== call.space) {
    return {
      refusal: {
        code: "refused",
        message: "The acl carries a change to a space other than the " +
          "session's",
      },
    };
  }
  const verdict = await server.commitServedAclChange({
    ...servedAclChangeOf(read.change),
    sessionId: call.sessionId,
    localSeq,
  });
  if ("refused" in verdict) {
    return { refusal: { code: "refused", message: verdict.refused } };
  }
  return { ok: verdict.seq === undefined ? {} : { seq: verdict.seq } };
};

/**
 * The handler for this process's memory server: each kind run as the
 * function above it describes, under the routed session the request came on.
 */
export function servedRequestHandler(options: {
  server: ServedRequestServer;
}): ServedRequestHandler {
  return (call): Promise<ServedRequestOutcome> => {
    switch (call.kind) {
      case "append":
        return runAppend(options.server, call);
      case "commit":
        return runCommit(options.server, call);
      case "acl":
        return runAcl(options.server, call);
    }
  };
}
