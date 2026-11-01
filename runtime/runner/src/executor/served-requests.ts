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
import { ProtocolError } from "@commonfabric/memory/v2";
import type {
  ServedRequestHandler,
  ServedRequestOutcome,
  Server,
} from "@commonfabric/memory/v2/server";

/**
 * One delegated event append as a `served` request's `append` body carries
 * it: the entry `Server.commitDelegatedAppend` takes, without the target
 * space, which the session names, and without the session, which is the
 * routed session the request came on. `localSeq` is the sender's, from the
 * counter its host keeps for every commit it makes.
 */
export type ServedAppendEntry = Omit<
  Parameters<Server["commitDelegatedAppend"]>[0],
  "targetSpace" | "sessionId"
>;

/** What the owner answers an `append` with. */
export type ServedAppendResult = { seq?: number; deduped: boolean };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  } = body as Record<string, unknown>;
  if (typeof targetStream !== "string") return { invalid: "targetStream" };
  if (typeof eventId !== "string") return { invalid: "eventId" };
  if (typeof capabilityRef !== "string") return { invalid: "capabilityRef" };
  if (typeof localSeq !== "number") return { invalid: "localSeq" };
  if (targetStreamLink !== undefined && !isPlainObject(targetStreamLink)) {
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
 * The handler for this process's memory server. An `append` runs
 * `commitDelegatedAppend` on the session's space under the routed session,
 * and answers with the seq it committed at, or that the owner's eventId
 * horizon deduped it. The engine's `ProtocolError` is the deterministic
 * refusal the sender does not retry; a body that is not an entry is refused
 * the same way. A kind this handler does not serve is answered as
 * unavailable, which the sender keeps and sends again: a process that
 * serves a kind later takes it then.
 */
export function servedRequestHandler(options: {
  server: Pick<Server, "commitDelegatedAppend">;
}): ServedRequestHandler {
  return async (call): Promise<ServedRequestOutcome> => {
    if (call.kind !== "append") {
      return {
        refusal: {
          code: "unavailable",
          message: `This process serves no \`${call.kind}\` crossing`,
        },
      };
    }
    const read = readAppendEntry(call.body);
    if ("invalid" in read) {
      return {
        refusal: {
          code: "refused",
          message:
            `The append carries no readable \`${read.invalid}\`, so it is refused`,
        },
      };
    }
    try {
      const result = await options.server.commitDelegatedAppend({
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
}
