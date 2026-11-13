import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricPlainObject } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { encodeMemoryBoundary } from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import type {
  ServedRequestCall,
  ServedRequestOutcome,
  Server,
} from "@commonfabric/memory/v2/server";
import {
  isServedRefusal,
  RoutedPlane,
  type RouteOptions,
} from "../../src/executor/routed-plane.ts";
import type { WaveSpaceCommit } from "../../src/executor/wave.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
} from "../memory-v2-test-utils.ts";

const serviceSigner = await Identity.fromPassphrase("routed plane service");
const space = (await Identity.fromPassphrase("routed plane target"))
  .did() as MemorySpace;
const doc = "of:routed-plane-watched";

const appendEntry = {
  targetStream: "of:routed-plane-sidecar",
  targetStreamLink: { id: "of:routed-plane-stream", path: [] },
  eventId: "evt-routed-plane",
  payload: {},
  actingPrincipal: "did:key:z6MkRoutedPlaneActor",
  actingSession: "actor-session",
  capabilityRef: "cap-routed-plane",
};

const batch: WaveSpaceCommit = {
  space,
  home: false,
  basisSeq: 0,
  rebasedHeads: [],
  operations: [],
  preconditions: [],
  annotations: [],
  consequenceOf: [],
  basisInstances: [],
  holder: undefined,
};

/**
 * One connection the route dialed: the server's end of it, whether the
 * client closed it, and the frames the server sent while `held`, which the
 * test hands to the client's receiver itself.
 */
type Dial = {
  connection: ReturnType<Server["connect"]>;
  receiver: ((payload: string) => void) | undefined;
  held: boolean;
  heldFrames: string[];
  closed: boolean;
};

describe("RoutedPlane", () => {
  let server: Server;
  let dials: Dial[];
  let failDial: Error | undefined;
  let failWatchAdd: Error | undefined;
  let answers: ServedRequestOutcome[];
  let calls: ServedRequestCall[];
  let planes: RoutedPlane[];

  /**
   * The route to `server` over loopback connections it records in `dials`,
   * which throws `failDial` where set, and refuses a watch add with
   * `failWatchAdd` where set, as an owner that refuses it does.
   */
  const route = (): RouteOptions => ({
    createTransport: () => {
      if (failDial !== undefined) throw failDial;
      const dial: Partial<Dial> & Pick<Dial, "held" | "heldFrames"> = {
        receiver: undefined,
        held: false,
        heldFrames: [],
        closed: false,
      };
      const inner = MemoryClient.loopback({
        connect: (send, syncParts, options) => {
          dial.connection = server.connect(
            (message, payload) => {
              if (!dial.held) return send(message, payload);
              dial.heldFrames.push(payload ?? encodeMemoryBoundary(message));
            },
            syncParts,
            options,
          );
          return dial.connection;
        },
      }, { inProcess: false });
      dials.push(dial as Dial);
      return {
        ...inner,
        send: (payload) =>
          failWatchAdd !== undefined && payload.includes("session.watch.add")
            ? Promise.reject(failWatchAdd)
            : inner.send(payload),
        setReceiver: (receiver) => {
          dial.receiver = receiver;
          inner.setReceiver(receiver);
        },
        close: () => {
          dial.closed = true;
          return inner.close();
        },
      };
    },
    sessionOpenAuth: testPrincipalSessionOpenAuthFactory(serviceSigner),
  });

  const newPlane = (): RoutedPlane => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    return plane;
  };

  /** Answers each served request with the next of `answers`. */
  const answerInTurn = () =>
    server.setServedRequestHandler((call) => {
      calls.push(call);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no answer is queued");
      return Promise.resolve(answer);
    });

  beforeEach(() => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      delegatingDids: [serviceSigner.did()],
    });
    dials = [];
    failDial = undefined;
    failWatchAdd = undefined;
    answers = [];
    calls = [];
    planes = [];
    answerInTurn();
  });

  afterEach(async () => {
    for (const plane of planes) await plane.close();
    await server.close();
  });

  describe("scope()", () => {
    describe("append()", () => {
      it("returns the owner's verdict, numbering each append on the session, and throws on an answer with none", async () => {
        const scope = newPlane().scope();
        answers.push(
          { ok: { deduped: false, seq: 3 } },
          { ok: { deduped: true } },
          { ok: { seq: 4 } },
        );
        expect(await scope.append(space, appendEntry)).toEqual({
          deduped: false,
          seq: 3,
        });
        expect(await scope.append(space, appendEntry)).toEqual({
          deduped: true,
        });
        await expect(scope.append(space, appendEntry)).rejects.toThrow(
          `the owner of ${space} answered an append with no verdict`,
        );
        expect(calls.map(({ kind, body }) => [kind, body.localSeq])).toEqual([
          ["append", 1],
          ["append", 2],
          ["append", 3],
        ]);
        scope.dispose();
      });
    });

    describe("commit()", () => {
      it("returns the seq the owner committed at, and throws on an answer with none", async () => {
        const scope = newPlane().scope();
        answers.push({ ok: { seq: 9 } }, { ok: { deduped: false } });
        expect(await scope.commit(space, batch)).toEqual({ seq: 9 });
        await expect(scope.commit(space, batch)).rejects.toThrow(
          `the owner of ${space} answered a commit with no seq`,
        );
        expect(calls.map(({ kind }) => kind)).toEqual(["commit", "commit"]);
        expect(calls[0].body.batch).toBe(
          encodeMemoryBoundary(batch as unknown as FabricPlainObject),
        );
        scope.dispose();
      });
    });

    describe("dispose()", () => {
      it("returns without error for a scope whose session never opened, and the next use dials again", async () => {
        const plane = newPlane();
        const scope = plane.scope();
        failDial = new Error("the owner is unreachable");
        await expect(scope.append(space, appendEntry)).rejects.toThrow(
          "the owner is unreachable",
        );
        expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
        expect(() => scope.dispose()).not.toThrow();

        failDial = undefined;
        answers.push({ ok: { deduped: false } });
        const next = plane.scope();
        expect(await next.append(space, appendEntry)).toEqual({
          deduped: false,
        });
        expect(dials).toHaveLength(1);
        next.dispose();
      });
    });

    describe("watchDocument()", () => {
      it("holds no watch for a document whose watch the owner refused, so the next watcher adds it", async () => {
        const plane = newPlane();
        const scope = plane.scope();
        failWatchAdd = new Error("watch refused");
        await expect(scope.watchDocument(space, doc, () => {})).rejects
          .toThrow("watch refused");
        expect(await plane.accessForTestingOnly.watchedDocuments(space))
          .toEqual([]);

        failWatchAdd = undefined;
        const cancel = await scope.watchDocument(space, doc, () => {});
        expect(await plane.accessForTestingOnly.watchedDocuments(space))
          .toEqual([doc]);
        cancel();
        scope.dispose();
      });

      it("leaves the watch of a session another scope opened since in place when a disposed scope's watcher cancels", async () => {
        const plane = newPlane();
        const first = plane.scope();
        const cancelFirst = await first.watchDocument(space, doc, () => {});
        first.dispose();
        const second = plane.scope();
        const cancelSecond = await second.watchDocument(space, doc, () => {});

        cancelFirst();
        expect(await plane.accessForTestingOnly.watchedDocuments(space))
          .toEqual([doc]);
        cancelSecond();
        expect(await plane.accessForTestingOnly.watchedDocuments(space))
          .toEqual([]);
        second.dispose();
      });

      describe("a replacement session whose watch the owner refuses", () => {
        // The first session opens while the owner serves no requests, so the
        // crossing on it is refused as unsupported and the plane replaces it
        // with a session that carries the watch, whose add the owner refuses.

        const replaceRefusingWatch = async (plane: RoutedPlane) => {
          server.setServedRequestHandler(undefined);
          const scope = plane.scope();
          const cancel = await scope.watchDocument(space, doc, () => {});
          answerInTurn();
          failWatchAdd = new Error("watch refused");
          const unsupported = await scope.append(space, appendEntry).catch(
            (error) => error,
          );
          expect(isServedRefusal(unsupported, "served-unsupported")).toBe(
            true,
          );
          expect(await plane.accessForTestingOnly.watchedDocuments(space))
            .toEqual([]);
          failWatchAdd = undefined;
          return { scope, cancel };
        };

        it("closes the connection it dialed, and adds the watch on the session the next use opens", async () => {
          const plane = newPlane();
          const { scope, cancel } = await replaceRefusingWatch(plane);
          expect(dials).toHaveLength(2);
          expect(dials[1].closed).toBe(true);
          expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);

          answers.push({ ok: { deduped: false } });
          await scope.append(space, appendEntry);
          expect(dials).toHaveLength(3);
          expect(await plane.accessForTestingOnly.watchedDocuments(space))
            .toEqual([doc]);
          cancel();
          scope.dispose();
        });

        it("adds no watch on the session the next use opens once the watch's last watcher cancelled", async () => {
          const plane = newPlane();
          const { scope, cancel } = await replaceRefusingWatch(plane);
          cancel();

          answers.push({ ok: { deduped: false } });
          await scope.append(space, appendEntry);
          expect(dials).toHaveLength(3);
          expect(await plane.accessForTestingOnly.watchedDocuments(space))
            .toEqual([]);
          scope.dispose();
        });
      });
    });
  });

  describe("close()", () => {
    it("fails a call made afterwards without dialing", async () => {
      const plane = newPlane();
      const scope = plane.scope();
      await plane.close();
      await expect(scope.append(space, appendEntry)).rejects.toThrow(
        "the routed plane is closed",
      );
      expect(dials).toEqual([]);
      expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
    });
  });

  describe("session termination", () => {
    it("opens no replacement for a session the owner revokes after its last scope released it", async () => {
      const plane = newPlane();
      const scope = plane.scope();
      await scope.watchDocument(space, doc, () => {});
      const [opened] = server.sessionSnapshot(space);
      expect(opened?.kind).toBe("opened");

      // The revocation reaches the client in the same turn as the release,
      // ahead of the close the release starts.
      const [dial] = dials;
      dial.held = true;
      dial.connection.revokeSession(space, opened.sessionId, "unauthorized");
      expect(dial.heldFrames).toHaveLength(1);
      scope.dispose();
      for (const frame of dial.heldFrames) dial.receiver!(frame);

      expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
      await plane.close();
      expect(dials).toHaveLength(1);
    });
  });
});
