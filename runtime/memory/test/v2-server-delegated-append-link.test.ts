import { expect } from "@std/expect";

import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "../v2.ts";
import { testSessionOpenServerOptions } from "./v2-auth-test-helpers.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const SPACE = "did:key:z6Mk-delegated-append-link-space";
const STREAM = { id: "of:delegated-append-link-stream", path: ["stream"] };
const OTHER_STREAM = { id: "of:delegated-append-link-other", path: ["stream"] };

let serverCount = 0;

const createServer = () =>
  new Server({
    ...testSessionOpenServerOptions,
    store: new URL(`memory://delegated-append-link-${++serverCount}`),
    subscriptionRefreshDelayMs: "manual",
  });

/** The delivery of event `eventId` to `STREAM`'s sidecar, linking `link`. */
const delivery = (eventId: string, link: typeof STREAM) => ({
  targetSpace: SPACE,
  targetStream: streamEntriesDocId(STREAM),
  targetStreamLink: link,
  eventId,
  payload: { n: 1 },
  actingPrincipal: "did:key:z6Mk-delegated-append-link-alice",
  actingSession: "delegated-append-link-session",
  capabilityRef: "delegated-append-link-capability",
  sessionId: `service:${SPACE}`,
  localSeq: 1,
});

/** The event ids `STREAM`'s sidecar holds. */
const storedEventIds = async (server: Server): Promise<string[]> => {
  const doc = Engine.read(await server.engineForSpace(SPACE), {
    id: streamEntriesDocId(STREAM),
  });
  const value = doc?.value as StreamEventsDocValue | undefined;
  return (value?.entries ?? []).map((entry) => entry.eventId);
};

describe("Server", () => {
  // Event appends are admitted only with server execution on.
  beforeEach(() => setServerExecutionConfig(true));
  afterEach(() => resetServerExecutionConfig());

  describe("instance members", () => {
    describe("commitDelegatedAppend()", () => {
      it("appends an entry whose stream link derives the target sidecar", async () => {
        const server = createServer();
        try {
          const result = await server.commitDelegatedAppend(
            delivery("event-derived", STREAM),
          );
          expect(result.deduped).toBe(false);
          expect(await storedEventIds(server)).toEqual(["event-derived"]);
        } finally {
          await server.close();
        }
      });

      it("throws `ProtocolError` naming the sidecar, appending nothing, for a stream link that derives another sidecar", async () => {
        const server = createServer();
        try {
          const refused = server.commitDelegatedAppend(
            delivery("event-misrouted", OTHER_STREAM),
          );
          await expect(refused).rejects.toThrow(Engine.ProtocolError);
          await expect(refused).rejects.toThrow(
            "delegated append event-misrouted carries a stream link that " +
              `does not derive its target sidecar "${
                streamEntriesDocId(STREAM)
              }"`,
          );
          expect(await storedEventIds(server)).toEqual([]);
        } finally {
          await server.close();
        }
      });
    });
  });
});
