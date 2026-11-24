/**
 * A memory server that refuses chosen spaces, for a test of how a runtime
 * takes a refusal the server itself does not send yet: the refusal of a
 * deleted space, marked `deleted` (INV-15 in
 * `docs/specs/memory-v2/09-invariants.md`). Everything else is the wrapped
 * server's own doing.
 */

import { isPlainObject } from "@commonfabric/js-values/types";
import {
  decodeMemoryBoundary,
  type ServerMessage,
  type V2Error,
} from "@commonfabric/memory/v2";
import type { loopback } from "@commonfabric/memory/v2/client";
import type { Server } from "@commonfabric/memory/v2/server";

/** How {@link refusingServer} refuses a space. */
export type SpaceRefusal = "deleted" | "unauthorized";

/** What a loopback transport uses of a memory server. */
type LoopbackServer = Parameters<typeof loopback>[0];

/**
 * Returns a stand-in for `server`, to hand a loopback transport, and
 * `refuse()`, which from then on refuses every request naming `space` with a
 * permanent `AuthorizationError`, marked `deleted` for a `deleted` refusal, and
 * revokes each session open on `space` with the matching reason, as the
 * server does when an access-list change removes a principal.
 */
export function refusingServer(server: Server): {
  server: LoopbackServer;
  refuse(space: string, refusal: SpaceRefusal): void;
} {
  const refused = new Map<string, SpaceRefusal>();
  const sessions: {
    connection: ReturnType<Server["connect"]>;
    space: string;
    sessionId: string;
  }[] = [];

  const connect: LoopbackServer["connect"] = (send, syncParts, options) => {
    // The space each `session.open` in flight names, by request.
    const opening = new Map<string, string>();
    const connection = server.connect(
      (message: ServerMessage, payload?: string) => {
        if (message.type === "response") {
          const space = opening.get(message.requestId);
          opening.delete(message.requestId);
          const sessionId = (message.ok as { sessionId?: unknown } | undefined)
            ?.sessionId;
          if (space !== undefined && typeof sessionId === "string") {
            sessions.push({ connection, space, sessionId });
          }
        }
        send(message, payload);
      },
      syncParts,
      options,
    );
    return {
      receive(payload: string): Promise<void> {
        const message = decodeMemoryBoundary(payload);
        if (
          isPlainObject(message) && typeof message.requestId === "string" &&
          typeof message.space === "string"
        ) {
          const refusal = refused.get(message.space);
          if (refusal !== undefined) {
            send({
              type: "response",
              requestId: message.requestId,
              error: refusalError(message.space, refusal),
            });
            return Promise.resolve();
          }
          if (message.type === "session.open") {
            opening.set(message.requestId, message.space);
          }
        }
        return connection.receive(payload);
      },
      close(): void {
        connection.close();
      },
    };
  };

  return {
    server: { connect },
    refuse(space, refusal) {
      refused.set(space, refusal);
      for (const session of sessions) {
        if (session.space !== space) continue;
        session.connection.revokeSession(space, session.sessionId, refusal);
      }
    },
  };
}

/** Helper for {@link refusingServer}, which returns its refusal of `space`. */
function refusalError(space: string, refusal: SpaceRefusal): V2Error {
  return refusal === "deleted"
    ? {
      name: "AuthorizationError",
      message: `Space ${space} is deleted`,
      permanentEvidence: true,
      aclRevision: 1,
      deleted: true,
    }
    : {
      name: "AuthorizationError",
      message: `Not authorized for ${space}`,
      permanentEvidence: true,
      aclRevision: 1,
    };
}
