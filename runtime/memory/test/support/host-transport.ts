/**
 * A transport to a real memory `Server` for tests of what a client does as
 * its connection is lost: the host can go down and come back, the server's
 * answers can be lost while it still handles what it is sent, and the send of
 * a frame can be held or failed.
 */

import type { FabricPlainObject } from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/js-values/types";
import { decodeMemoryBoundary, encodeMemoryBoundary } from "../../v2.ts";
import { connectionError, type Transport } from "../../v2/client.ts";
import type { Server } from "../../v2/server.ts";

/** A transport to `server` whose host can go down and come back, whose
 * answers, or only its answers to `session.open`, can be lost while the
 * server still handles each frame, and whose send of a frame can fail with
 * its connection. */
export function hostTransport(server: Server) {
  let connection: ReturnType<Server["connect"]> | undefined;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let down = false;
  let losingAnswers = false;
  let losingOpenAnswers = false;
  const lostAnswers = new Set<unknown>();
  let losingAnswerTo: string | undefined;
  let awaited:
    | { type: string; handled: PromiseWithResolvers<void> }
    | undefined;
  type Held = { release: PromiseWithResolvers<void>; fails: boolean };
  let holding: (Held & { type: string }) | undefined;
  let failing: string | undefined;
  const held = new Set<Held>();
  const sent: FabricPlainObject[] = [];
  const reset = () => {
    connection?.close();
    connection = undefined;
    losingAnswers = false;
    losingOpenAnswers = false;
  };
  const transport = {
    async send(payload: string) {
      if (connection === undefined) {
        if (down) throw connectionError("test host is down");
        const opened = server.connect((message) => {
          if (connection !== opened || losingAnswers) return;
          if (
            message.type === "response" && lostAnswers.has(message.requestId)
          ) {
            return;
          }
          receiver(encodeMemoryBoundary(message));
        });
        connection = opened;
      }
      const decoded = decodeMemoryBoundary(payload);
      if (!isPlainObject(decoded)) throw new Error("Expected a request record");
      sent.push(decoded);
      if (failing !== undefined && decoded.type === failing) {
        // As the runner's WebSocket transport does when a write fails: it
        // reports the connection closed, then rejects the send.
        failing = undefined;
        const error = connectionError("test write failed");
        reset();
        closeReceiver(error);
        throw error;
      }
      if (losingOpenAnswers && decoded.type === "session.open") {
        lostAnswers.add(decoded.requestId);
      }
      if (losingAnswerTo !== undefined && decoded.type === losingAnswerTo) {
        losingAnswerTo = undefined;
        lostAnswers.add(decoded.requestId);
      }
      await connection.receive(payload);
      if (awaited !== undefined && decoded.type === awaited.type) {
        awaited.handled.resolve();
      }
      if (holding !== undefined && decoded.type === holding.type) {
        const { release, fails } = holding;
        holding = undefined;
        held.add({ release, fails });
        await release.promise;
      }
    },
    reset,
    close() {
      reset();
      return Promise.resolve();
    },
    setReceiver(next: (payload: string) => void) {
      receiver = next;
    },
    setCloseReceiver(next: (error?: Error) => void) {
      closeReceiver = next;
    },
  } satisfies Transport;
  const drop = () => {
    reset();
    closeReceiver(new Error("test connection dropped"));
    for (const { release, fails } of held) {
      if (fails) release.reject(connectionError("test write failed"));
      else release.resolve();
    }
    held.clear();
  };
  return {
    transport,
    /** The frames of `type` sent so far. */
    sentOfType(type: string) {
      return sent.filter((message) => message.type === type).length;
    },
    /** The ids of the watches each `session.watch.set` sent so far named. */
    watchSetsSent() {
      return sent.filter((message) => message.type === "session.watch.set")
        .map((message) =>
          Array.isArray(message.watches)
            ? message.watches.map((watch) =>
              isPlainObject(watch) ? watch.id : undefined
            )
            : undefined
        );
    },
    /** The `localSeq` of each `transact` frame sent so far, in order. */
    transactsSent() {
      return sent.filter((message) => message.type === "transact").map((
        message,
      ) => (message.commit as { localSeq?: number } | undefined)?.localSeq);
    },
    /** The `transact` frames sent for the commit `localSeq`. */
    transactsOf(localSeq: number) {
      return sent.filter((message) =>
        message.type === "transact" &&
        (message.commit as { localSeq?: number } | undefined)?.localSeq ===
          localSeq
      ).length;
    },
    /** Resolves once the server has handled the next frame of `type`. */
    whenHandled(type: string) {
      awaited = { type, handled: Promise.withResolvers<void>() };
      return awaited.handled.promise;
    },
    /** The connection drops, and every redial fails until `hostUp()`. */
    hostDown() {
      down = true;
      drop();
    },
    hostUp() {
      down = false;
    },
    /** What the server sends is lost until the connection drops. */
    loseAnswers() {
      losingAnswers = true;
    },
    /** The send of the next frame of `type` stays unsettled after the
     * server has handled it and its answer has arrived, until the connection
     * drops: the window in which an accepted commit is still outstanding.
     * The drop then settles it, or with `fails` rejects it with the
     * connection. */
    holdNextSendOf(type: string, fails = false) {
      holding = { type, release: Promise.withResolvers<void>(), fails };
    },
    /** The server's answers to `session.open` are lost until the connection
     * drops, so a session sits restoring on a live connection. */
    loseOpenAnswers() {
      losingOpenAnswers = true;
    },
    /** The server's answer to the next frame of `type` is lost. */
    loseAnswerToNext(type: string) {
      losingAnswerTo = type;
    },
    /** The send of the next frame of `type` fails with its connection,
     * before the server sees it. */
    failNextSendOf(type: string) {
      failing = type;
    },
    drop,
  };
}
