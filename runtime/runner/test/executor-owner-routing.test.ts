/**
 * Owner routing (docs/plans/serving-loop-owner-routing.md): a serving loop
 * reaches a space other than its home through that space's owner. Two memory
 * servers over one file store stand for two processes of a deployment, each
 * with its own ExecutorHost; the route maps a space to the server that owns
 * it, every space the test does not place being B's, and routed sessions
 * connect to that server over the loopback transport.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  insertExecutionOutboxRows,
  selectPendingExecutionOutboxRows,
} from "@commonfabric/memory/v2/execution-outbox";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  acquireServerExecutionEnabler,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import {
  applyCommit,
  read as readDoc,
  selectDocHead,
} from "@commonfabric/memory/v2/engine";
import type { AdmittedCommitNotice } from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { LoopbackStorageManager } from "../src/executor/loopback-storage.ts";
import { SpaceOutbox } from "../src/executor/outbox.ts";
import {
  isServedRefusal,
  RoutedPlane,
  type RoutedScope,
  type RouteOptions,
} from "../src/executor/routed-plane.ts";
import { routedWaveCommitSink } from "../src/executor/routed-wave-sink.ts";
import { servedRequestHandler } from "../src/executor/served-requests.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import {
  stampWaveRunContext,
  type WaveCommitSink,
  type WaveSpaceCommit,
} from "../src/executor/wave.ts";
import { parseLink } from "../src/link-utils.ts";
import { ArrivalLog, awaitAdmitted } from "./support/serving-waits.ts";
import {
  TEST_SESSION_OPEN_AUDIENCE,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

const serviceSigner = await Identity.fromPassphrase("owner routing service");
const aliceSigner = await Identity.fromPassphrase("owner routing alice");
const bobSigner = await Identity.fromPassphrase("owner routing bob");
const homeSigner = await Identity.fromPassphrase("owner routing home");
const homeSpace = homeSigner.did() as MemorySpace;
const targetSigner = await Identity.fromPassphrase("owner routing target");
const targetSpace = targetSigner.did() as MemorySpace;

type Label = "A" | "B";

describe("executor owner routing", () => {
  let directory: string;
  let servers: Record<Label, MemoryV2Server.Server>;
  let owners: Map<string, MemoryV2Server.Server>;
  let hosts: ExecutorHost[];
  let planes: RoutedPlane[];
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];
  let activations: ArrivalLog<{ host: Label; space: string; outcome: string }>;
  let servingRuntimes: Map<Label, Runtime>;
  let releaseServerExecution: () => void;

  /** The route of the deployment: each space's owner by the test's map,
   * and B's for a space the map does not place. */
  const route = (): RouteOptions => ({
    createTransport: (space) =>
      MemoryClient.loopback(owners.get(space) ?? servers.B),
    sessionOpenAuth: testPrincipalSessionOpenAuthFactory(serviceSigner),
  });

  /** A memory server over the shared store, with the service identity as
   * its delegating class, as every process of a deployment has. */
  const newServer = (): MemoryV2Server.Server =>
    new MemoryV2Server.Server({
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: TEST_SESSION_OPEN_AUDIENCE },
      subscriptionRefreshDelayMs: 0,
      store: toFileUrl(`${directory}/`),
      acl: { mode: "off", delegatingDids: [serviceSigner.did()] },
    });

  const newHost = (label: Label): ExecutorHost => {
    const server = servers[label];
    const host = new ExecutorHost({
      server,
      route: route(),
      serviceIdentity: serviceSigner.did(),
      // The serving runtime's own storage plane, with the route: a session
      // opened as a created space's own key, its genesis, dials the owner.
      createRuntime: (space, context) => {
        const manager = LoopbackStorageManager.connect(server, {
          as: serviceSigner,
          servingHomeSpace: space,
          ...(context.foreignScopedReadGrant === undefined
            ? {}
            : { foreignScopedReadGrant: context.foreignScopedReadGrant }),
          ...(context.route === undefined ? {} : { route: context.route }),
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntimes.set(label, runtime);
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      onActivationSettled: (space, outcome) =>
        activations.record({ host: label, space, outcome }),
    });
    hosts.push(host);
    return host;
  };

  /** Resolves once `space` has an ACTIVE tenure on `label`'s host. */
  const activated = (label: Label, space: MemorySpace): Promise<unknown> =>
    activations.matching((entry) =>
      entry.host === label && entry.space === space &&
      entry.outcome === "active"
    );

  /** The entries of `sidecarId` in `space` as `label`'s server reads them. */
  const entriesOn = async (
    label: Label,
    space: MemorySpace,
    sidecarId: string,
  ): Promise<NonNullable<StreamEventsDocValue["entries"]>> => {
    const engine = await servers[label].engineForSpace(space);
    const value = readDoc(engine, { id: sidecarId })?.value as
      | StreamEventsDocValue
      | undefined;
    return value?.entries ?? [];
  };

  /** Creates the target stream's document in `space` engine-direct, so no
   * session and no admission notice reaches either host for it. */
  const createStreamDoc = async (
    label: Label,
    space: MemorySpace,
    id: string,
  ): Promise<void> => {
    const engine = await servers[label].engineForSpace(space);
    applyCommit(engine, {
      sessionId: "owner-routing-setup",
      space,
      principal: aliceSigner.did(),
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id,
          value: { schema: { asCell: ["stream"] } } as never,
        }],
      },
    });
  };

  beforeEach(async () => {
    // The posture a host claims for its process; the outbox-level tests
    // below run without one.
    releaseServerExecution = acquireServerExecutionEnabler();
    directory = await Deno.makeTempDir({ prefix: "owner-routing-" });
    servers = { A: newServer(), B: newServer() };
    for (const server of Object.values(servers)) {
      server.setServedRequestHandler(servedRequestHandler({ server }));
    }
    owners = new Map([[homeSpace, servers.A], [targetSpace, servers.B]]);
    hosts = [];
    planes = [];
    managers = [];
    runtimes = [];
    activations = new ArrivalLog();
    servingRuntimes = new Map();
  });

  afterEach(async () => {
    for (const host of hosts) await host.close();
    for (const plane of planes) await plane.close();
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    for (const server of Object.values(servers)) await server.close();
    await Deno.remove(directory, { recursive: true });
    releaseServerExecution();
  });

  //
  // The host's crossing
  //

  it("delivers an event from a space served on one server into a space owned by another through the owner, which activates it; the sender's server admits nothing in it", async () => {
    const hostA = newHost("A");
    newHost("B");
    const admittedOnA: AdmittedCommitNotice[] = [];
    const stopWatching = servers.A.watchAdmittedCommits((notice) => {
      if (notice.space === targetSpace) admittedOnA.push(notice);
    });

    // Alice's client on A demands a home doc, so the HOME space activates
    // on A. The target stream doc is created engine-direct, so the target
    // space is inactive everywhere until the delivered append.
    const clientManager = EmulatedStorageManager.connectTo(servers.A, {
      as: aliceSigner,
    });
    managers.push(clientManager);
    const clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    runtimes.push(clientRuntime);
    const streamDocId = clientRuntime.getCell<unknown>(
      targetSpace,
      "routed-send-stream",
      undefined,
    ).getAsNormalizedFullLink().id;
    await createStreamDoc("B", targetSpace, streamDocId);
    const demandCell = clientRuntime.getCell<{ ping: number }>(
      homeSpace,
      "routed-send-demand",
      undefined,
    );
    const cancel = demandCell.sink(() => {});
    try {
      await activated("A", homeSpace);
      const serving = servingRuntimes.get("A")!;
      const servingStream = serving.getCell<unknown>(
        targetSpace,
        "routed-send-stream",
        { asCell: ["stream"] },
      );
      await servingStream.sync();
      const homeAnchor = serving.getCell<{ n: number }>(
        homeSpace,
        "routed-send-anchor",
        undefined,
      );
      expect(hostA.spaceServer(targetSpace)?.active ?? false).toBe(false);

      // A served event-handler run on A, home-anchored, sends to the
      // foreign stream: the outbox stages the cross-space append.
      const tx = serving.edit();
      stampWaveRunContext(tx, {
        actionId: "routed-send-handler",
        kind: "event-handler",
        eventId: "e-routed-send",
        acting: { user: aliceSigner.did(), session: "sess-routed" },
        capabilityRef: "event-consequence:e-routed-send",
      });
      homeAnchor.withTx(tx).set({ n: 1 });
      servingStream.withTx(tx).send({ hello: "across" });
      expect((await tx.commit().settled).error).toBeUndefined();

      // The owner admits the append, stamped from the carried actor.
      const sidecarId = streamEntriesDocId({ id: streamDocId, path: [] });
      const delivered = async () =>
        (await entriesOn("B", targetSpace, sidecarId)).filter((entry) =>
          entry.firedAt?.user === aliceSigner.did()
        );
      await awaitAdmitted(
        servers.B,
        async () => (await delivered()).length > 0,
      );
      expect((await delivered()).length).toBe(1);
      expect((await delivered())[0].firedAt?.session).toBe("sess-routed");

      // The delivered append activates the target on its OWNER, and
      // nowhere else: the sender's server never admitted anything in it.
      await activated("B", targetSpace);
      expect((await delivered()).length).toBe(1);
      expect(hostA.spaceServer(targetSpace)).toBeUndefined();
      expect(admittedOnA).toEqual([]);
      expect(
        activations.entries.filter((entry) =>
          entry.host === "A" && entry.space === targetSpace
        ),
      ).toEqual([]);
    } finally {
      cancel();
      stopWatching();
    }
  });

  //
  // The outbox's delivery through the route
  //
  // These drive one home space's outbox by hand against the owner, with the
  // rows inserted directly, as the outbox's own tests do.
  //

  const holder = executionLeaseHolder(serviceSigner.did());

  /** A home outbox on A, delivering through `plane`. */
  const newOutbox = async (plane: RoutedPlane) => {
    const engine = await servers.A.engineForSpace(homeSpace);
    const lease = new ExecutionLeaseCycle({
      engine,
      space: homeSpace,
      holder,
    });
    if (!lease.acquire()) throw new Error("test lease acquire failed");
    const stats = emptyServingLoopStats();
    const outbox = new SpaceOutbox({
      stats,
      server: servers.A,
      engine,
      space: homeSpace,
      sessionId: holder,
      localSeqRef: { value: 0 },
      route: plane.scope(),
    });
    return { engine, lease, stats, outbox };
  };

  const stream = { id: "of:routed-outbox-stream", path: [] as string[] };
  const sidecar = streamEntriesDocId(stream);

  it("dedupes a re-sent append at the owner's eventId horizon", async () => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    const { engine, lease, outbox } = await newOutbox(plane);
    await createStreamDoc("B", targetSpace, stream.id);
    const row = {
      targetSpace,
      targetStream: sidecar,
      targetStreamLink: stream,
      eventId: "evt-routed-dedupe",
      payload: { n: 1 },
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "cap-routed",
    };
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [row],
    });
    expect((await outbox.deliverPendingAppends()).remaining).toBe(0);
    expect((await entriesOn("B", targetSpace, sidecar)).length).toBe(1);

    // The same row again, as a crash before the row's retirement re-sends it.
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 2,
      rows: [row],
    });
    expect((await outbox.deliverPendingAppends()).remaining).toBe(0);
    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect((await entriesOn("B", targetSpace, sidecar)).length).toBe(1);
    lease.release();
  });

  it("takes the LT4 arm on the owner's deterministic refusal: the row retires, the failure counts, and the source entry carries the notice", async () => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    const { engine, lease, stats, outbox } = await newOutbox(plane);
    // The source event's entry in the home space, which the notice lands on.
    const sourceStream = {
      id: "of:routed-source-stream",
      path: [] as string[],
    };
    const sourceSidecar = streamEntriesDocId(sourceStream);
    await createStreamDoc("A", homeSpace, sourceStream.id);
    await servers.A.commitDelegatedAppend({
      targetSpace: homeSpace,
      targetStream: sourceSidecar,
      targetStreamLink: sourceStream,
      eventId: "evt-source",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "cap-source",
      sessionId: "owner-routing-source",
      localSeq: 1,
    });
    // A row with no stream link: the owner refuses it deterministically.
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 2,
      rows: [{
        targetSpace,
        targetStream: sidecar,
        eventId: "evt-routed-refused",
        payload: {},
        actingPrincipal: aliceSigner.did(),
        actingSession: "sess-1",
        capabilityRef: "cap-routed",
        sourceEvent: { sidecarId: sourceSidecar, eventId: "evt-source" },
      }],
    });

    expect((await outbox.deliverPendingAppends()).remaining).toBe(0);

    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(1);
    expect((await entriesOn("B", targetSpace, sidecar)).length).toBe(0);
    const [sourceEntry] = await entriesOn("A", homeSpace, sourceSidecar);
    expect(sourceEntry.deliveryFailures?.map((f) => f.eventId)).toEqual([
      "evt-routed-refused",
    ]);
    lease.release();
  });

  it("keeps the row and stops the drain when the owner is unreachable", async () => {
    const plane = new RoutedPlane({
      ...route(),
      createTransport: () => {
        throw new Error("the owner is unreachable");
      },
    });
    planes.push(plane);
    const { engine, lease, stats, outbox } = await newOutbox(plane);
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 1,
      rows: [{
        targetSpace,
        targetStream: sidecar,
        targetStreamLink: stream,
        eventId: "evt-routed-unreachable",
        payload: {},
        actingPrincipal: aliceSigner.did(),
        actingSession: "sess-1",
        capabilityRef: "cap-routed",
      }],
    });

    expect((await outbox.deliverPendingAppends()).remaining).toBe(1);

    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(1);
    expect(stats.outbox.failed).toBe(0);
    lease.release();
  });

  //
  // The routed plane's sessions
  //

  it("opens one session per target space when first needed and closes it once the last scope that needed it is disposed", async () => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    await createStreamDoc("B", targetSpace, stream.id);
    const entry = {
      targetStream: sidecar,
      targetStreamLink: stream,
      eventId: "evt-routed-scope",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "cap-routed",
    };
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);

    const first = plane.scope();
    const second = plane.scope();
    await first.append(targetSpace, entry);
    await second.append(targetSpace, { ...entry, eventId: "evt-routed-2" });
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([targetSpace]);
    // Two scopes, one session: the plane numbered the second append after
    // the first, and the owner admitted both.
    expect((await entriesOn("B", targetSpace, sidecar)).length).toBe(2);

    first.dispose();
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([targetSpace]);
    second.dispose();
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
  });

  it("wakes a routed document watch when the owner admits a commit to the document", async () => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    await createStreamDoc("B", targetSpace, stream.id);
    const scope = plane.scope();
    // The session's push carries every change the owner admits, so the
    // wake reads the document and settles once the entry is in it.
    const landed = Promise.withResolvers<void>();
    const cancel = await scope.watchDocument(targetSpace, sidecar, () => {
      void entriesOn("B", targetSpace, sidecar).then((entries) => {
        if (entries.some((entry) => entry.eventId === "evt-watched")) {
          landed.resolve();
        }
      });
    });
    // A commit the owner makes for itself, as a crossing from a third
    // process would reach it.
    await servers.B.commitDelegatedAppend({
      targetSpace,
      targetStream: sidecar,
      targetStreamLink: stream,
      eventId: "evt-watched",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "cap-routed",
      sessionId: "owner-direct",
      localSeq: 1,
    });
    await landed.promise;
    cancel();
    scope.dispose();
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
  });

  it("wakes every watcher on a session's shared push, and keeps a document's watch until its last watcher cancels", async () => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    await createStreamDoc("B", targetSpace, stream.id);
    const scope = plane.scope();
    let localSeq = 0;
    const append = (eventId: string) =>
      servers.B.commitDelegatedAppend({
        targetSpace,
        targetStream: sidecar,
        targetStreamLink: stream,
        eventId,
        payload: {},
        actingPrincipal: aliceSigner.did(),
        actingSession: "sess-1",
        capabilityRef: "cap-routed",
        sessionId: "owner-direct",
        localSeq: ++localSeq,
      });
    // Each watcher settles its own deferred once the entry it waits for is
    // in the document, whichever push woke it.
    const watcher = (eventId: string) => {
      const landed = Promise.withResolvers<void>();
      const wake = () => {
        void entriesOn("B", targetSpace, sidecar).then((entries) => {
          if (entries.some((entry) => entry.eventId === eventId)) {
            landed.resolve();
          }
        });
      };
      return { landed: landed.promise, wake };
    };
    const first = watcher("evt-shared-1");
    const second = watcher("evt-shared-1");
    const cancelFirst = await scope.watchDocument(
      targetSpace,
      sidecar,
      first.wake,
    );
    const cancelSecond = await scope.watchDocument(
      targetSpace,
      sidecar,
      second.wake,
    );
    await append("evt-shared-1");
    // One push on the shared session woke both watchers of the document.
    await Promise.all([first.landed, second.landed]);

    cancelFirst();
    const third = watcher("evt-shared-2");
    const cancelThird = await scope.watchDocument(
      targetSpace,
      sidecar,
      third.wake,
    );
    await append("evt-shared-2");
    // The first watcher's cancel left the document watched for the second
    // watcher, which a later watcher joined.
    await third.landed;
    cancelSecond();
    cancelThird();
    scope.dispose();
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
  });

  it("refuses a call on a disposed scope, so a user that outlives its close opens no session", async () => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    const scope = plane.scope();
    scope.dispose();
    await expect(scope.append(targetSpace, {
      targetStream: sidecar,
      targetStreamLink: stream,
      eventId: "evt-after-dispose",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "cap-routed",
    })).rejects.toThrow("the routed scope is disposed");
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
  });

  it("retires an append too large to send as a deterministic refusal, with the notice on the source entry", async () => {
    const engine = await servers.A.engineForSpace(homeSpace);
    const lease = new ExecutionLeaseCycle({
      engine,
      space: homeSpace,
      holder,
    });
    if (!lease.acquire()) throw new Error("test lease acquire failed");
    const stats = emptyServingLoopStats();
    // The route the client refuses before sending: an append past the
    // request's byte limit, as `SpaceSession.runServed` answers it.
    const tooLarge: RoutedScope = {
      append: () =>
        Promise.reject(Object.assign(new Error("the append is too large"), {
          name: "ServedRequestRefusal",
          code: "payload-too-large",
        })),
      commit: () => Promise.reject(new Error("not a commit")),
      acl: () => Promise.reject(new Error("not an acl change")),
      watchDocument: () => Promise.reject(new Error("not a watch")),
      dispose: () => {},
    };
    const outbox = new SpaceOutbox({
      stats,
      server: servers.A,
      engine,
      space: homeSpace,
      sessionId: holder,
      localSeqRef: { value: 0 },
      route: tooLarge,
    });
    const sourceStream = {
      id: "of:routed-large-source-stream",
      path: [] as string[],
    };
    const sourceSidecar = streamEntriesDocId(sourceStream);
    await createStreamDoc("A", homeSpace, sourceStream.id);
    await servers.A.commitDelegatedAppend({
      targetSpace: homeSpace,
      targetStream: sourceSidecar,
      targetStreamLink: sourceStream,
      eventId: "evt-large-source",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "cap-source",
      sessionId: "owner-routing-source",
      localSeq: 1,
    });
    insertExecutionOutboxRows(engine, {
      branch: "",
      createdSeq: 2,
      rows: [{
        targetSpace,
        targetStream: sidecar,
        targetStreamLink: stream,
        eventId: "evt-routed-large",
        payload: {},
        actingPrincipal: aliceSigner.did(),
        actingSession: "sess-1",
        capabilityRef: "cap-routed",
        sourceEvent: { sidecarId: sourceSidecar, eventId: "evt-large-source" },
      }],
    });

    expect((await outbox.deliverPendingAppends()).remaining).toBe(0);

    expect(selectPendingExecutionOutboxRows(engine, { branch: "" }).length)
      .toBe(0);
    expect(stats.outbox.failed).toBe(1);
    const [sourceEntry] = await entriesOn("A", homeSpace, sourceSidecar);
    expect(sourceEntry.deliveryFailures?.map((f) => f.eventId)).toEqual([
      "evt-routed-large",
    ]);
    lease.release();
  });

  //
  // Provisioning through the owner (R2)
  //
  // A served run's writes into another space: its genesis, the foreign wave
  // batch, and an access-list change, each admitted by that space's owner.
  //

  /** The notices `label`'s server admits in spaces other than the home. */
  const admittedElsewhereOn = (label: Label): {
    notices: AdmittedCommitNotice[];
    stop: () => void;
  } => {
    const notices: AdmittedCommitNotice[] = [];
    const stop = servers[label].watchAdmittedCommits((notice) => {
      if (notice.space !== homeSpace) notices.push(notice);
    });
    return { notices, stop };
  };

  /** Alice's client on A, demanding a home document so A serves the home. */
  const demandHomeOnA = (): { runtime: Runtime; cancel: () => void } => {
    const clientManager = EmulatedStorageManager.connectTo(servers.A, {
      as: aliceSigner,
    });
    managers.push(clientManager);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
    runtimes.push(runtime);
    const demandCell = runtime.getCell<{ ping: number }>(
      homeSpace,
      "routed-provision-demand",
      undefined,
    );
    return { runtime, cancel: demandCell.sink(() => {}) };
  };

  it("lands a provisioning write into a space the serving runtime created, genesis first, on the space's owner, which activates it; the sender's server admits nothing in it", async () => {
    const hostA = newHost("A");
    newHost("B");
    const onA = admittedElsewhereOn("A");
    const onB = admittedElsewhereOn("B");
    const { cancel } = demandHomeOnA();
    try {
      await activated("A", homeSpace);
      const serving = servingRuntimes.get("A")!;

      // The space's genesis is the first commit its owner admits.
      const pSpace = await serving.createSpace({ owner: aliceSigner.did() });
      expect(onB.notices.map((n) => [n.space, n.seq])).toEqual([[pSpace, 1]]);
      const acl = await servers.B.readDocument(pSpace, `of:${pSpace}`);
      expect(acl?.value).toEqual({ [aliceSigner.did()]: "OWNER" });

      // The provisioning-shaped crossing, as a served `.inSpace()` create
      // seals it: the acting user and grant, a foreign and a home write.
      const foreignCell = serving.getCell<{ value: number }>(
        pSpace,
        "routed-provisioned",
        undefined,
      );
      const homeCell = serving.getCell<{ value: number }>(
        homeSpace,
        "routed-provision-home-link",
        undefined,
      );
      const tx = serving.edit();
      stampWaveRunContext(tx, {
        actionId: "routed-provision",
        kind: "event-handler",
        eventId: "e-routed-provision",
        acting: { user: aliceSigner.did(), session: "sess-provision" },
        capabilityRef: "event-consequence:e-routed-provision",
      });
      tx.enableMultiSpaceWrites?.([pSpace, homeSpace]);
      foreignCell.withTx(tx).set({ value: 31 });
      homeCell.withTx(tx).set({ value: 32 });
      expect((await tx.commit().settled).error).toBeUndefined();

      // The owner commits the batch under the carried actor and reports it
      // warm, which activates the space there.
      const pEngine = await servers.B.engineForSpace(pSpace);
      const provisionedId = foreignCell.getAsNormalizedFullLink().id;
      const provisionedSeq = () =>
        selectDocHead(pEngine, { id: provisionedId, scopeKey: "space" });
      await awaitAdmitted(servers.B, () => provisionedSeq() > 0);
      const meta = pEngine.database.prepare(
        `SELECT class, acting_principal FROM "commit" WHERE seq = ?`,
      ).get(provisionedSeq()) as Record<string, string>;
      expect(meta.class).toBe("authored");
      expect(meta.acting_principal).toBe(aliceSigner.did());
      expect(
        onB.notices.find((n) => n.space === pSpace && n.seq > 1)?.warm,
      ).toBe(true);
      await activated("B", pSpace);

      // The home commit followed, on the sender's own server.
      const homeEngine = await servers.A.engineForSpace(homeSpace);
      const homeSeq = () =>
        selectDocHead(homeEngine, {
          id: homeCell.getAsNormalizedFullLink().id,
          scopeKey: "space",
        });
      await awaitAdmitted(servers.A, () => homeSeq() > 0);
      expect(hostA.spaceServer(pSpace)).toBeUndefined();
      expect(onA.notices).toEqual([]);
      expect(
        activations.entries.filter((entry) =>
          entry.host === "A" && entry.space === pSpace
        ),
      ).toEqual([]);
    } finally {
      cancel();
      onA.stop();
      onB.stop();
    }
  });

  it("withholds the home commit while the owner cannot serve the foreign batch, and lands both once it can, the event replaying", async () => {
    newHost("A");
    newHost("B");
    // Alice's client, with a home pattern whose handler places a room in
    // the space it names `lobby`: the first event creates that space, and
    // the second provisions into it.
    const clientManager = EmulatedStorageManager.connectTo(servers.A, {
      as: aliceSigner,
    });
    managers.push(clientManager);
    const clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    runtimes.push(clientRuntime);
    const compiled = await clientRuntime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { action, pattern, type Stream, type Writable } from "commonfabric";
const Room = pattern<{ title: string }, { title: string }>(
  ({ title }) => ({ title }),
);
export default pattern<
  { rooms: Writable<unknown[]> },
  { create: Stream<{ title: string }> }
>(({ rooms }) => ({
  create: action(({ title }: { title: string }) => {
    rooms.push(Room.inSpace("lobby")({ title }));
  }),
}));`,
      }],
    }, { space: homeSpace });
    const argument = clientRuntime.getCell<{ rooms: unknown[] }>(
      homeSpace,
      "routed-replay-argument",
    );
    const result = clientRuntime.getCell<{ create: unknown }>(
      homeSpace,
      "routed-replay-result",
      compiled.resultSchema,
    );
    await Promise.all([argument.sync(), result.sync()]);
    const seed = clientRuntime.edit();
    argument.withTx(seed).set({ rooms: [] });
    clientRuntime.run(seed, compiled, argument, result);
    expect((await seed.commit().settled).error).toBeUndefined();
    await clientManager.synced();
    await activated("A", homeSpace);

    const homeEngine = await servers.A.engineForSpace(homeSpace);
    const rooms = () =>
      (readDoc(homeEngine, { id: argument.getAsNormalizedFullLink().id })
        ?.value as { rooms?: unknown[] } | undefined)?.rooms ?? [];
    // The home's durable stream entries, which are the handler's events.
    const entries = (): NonNullable<StreamEventsDocValue["entries"]> =>
      (homeEngine.database.prepare(
        "SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'",
      ).all() as { id: string }[]).flatMap(({ id }) =>
        (readDoc(homeEngine, { id })?.value as StreamEventsDocValue)
          ?.entries ?? []
      );

    result.key("create").send({ title: "lobby" });
    await clientManager.synced();
    await awaitAdmitted(servers.A, () => rooms().length === 1);
    const lobby = parseLink(rooms()[0])!.space!;
    expect(lobby).not.toBe(homeSpace);
    await activated("B", lobby);

    // B's loop goes away: its server answers every crossing as unavailable.
    const refused = new ArrivalLog<string>();
    servers.B.setServedRequestHandler((call) => {
      refused.record(call.kind);
      return Promise.resolve({
        refusal: { code: "unavailable", message: "B runs no serving loop" },
      });
    });
    result.key("create").send({ title: "hall" });
    await clientManager.synced();
    await refused.matching((kind) => kind === "commit");
    // The foreign batch failed, so the home commit is withheld: the room
    // is not in the list, and the event is still to be consequenced.
    expect(rooms().length).toBe(1);
    expect(entries().length).toBe(2);
    expect(entries()[1].consequenced).not.toBe(true);

    // B's loop is back, and the event's replay lands on both servers.
    servers.B.setServedRequestHandler(
      servedRequestHandler({ server: servers.B }),
    );
    await awaitAdmitted(servers.A, () => rooms().length === 2);
    expect(parseLink(rooms()[1])!.space).toBe(lobby);
    await awaitAdmitted(servers.A, () => entries()[1].consequenced === true);
  });

  it("commits a served access-list change into a space owned by another server through its owner, and hands back the owner's refusal of one the actor may not make", async () => {
    const plane = new RoutedPlane(route());
    planes.push(plane);
    // The target, owned by Alice, and the event she fired in the home.
    const targetEngine = await servers.B.engineForSpace(targetSpace);
    applyCommit(targetEngine, {
      sessionId: "owner-routing-genesis",
      space: targetSpace,
      principal: targetSpace,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: `of:${targetSpace}`,
          value: { value: { [aliceSigner.did()]: "OWNER" } },
        }],
      },
    });
    const sourceStream = { id: "of:routed-acl-source", path: [] as string[] };
    const sourceSidecar = streamEntriesDocId(sourceStream);
    await createStreamDoc("A", homeSpace, sourceStream.id);
    await servers.A.commitDelegatedAppend({
      targetSpace: homeSpace,
      targetStream: sourceSidecar,
      targetStreamLink: sourceStream,
      eventId: "evt-acl-source",
      payload: {},
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "cap-source",
      sessionId: "owner-routing-acl-source",
      localSeq: 1,
    });
    const scope = plane.scope();
    const change = {
      space: targetSpace,
      actingPrincipal: aliceSigner.did(),
      actingSession: "sess-1",
      capabilityRef: "event-consequence:evt-acl-source",
      sourceEvent: {
        space: homeSpace,
        sidecarId: sourceSidecar,
        eventId: "evt-acl-source",
      },
    };

    const admitted = await scope.acl(targetSpace, {
      ...change,
      changes: [{
        principal: bobSigner.did(),
        level: "READ",
        actor: aliceSigner.did(),
      }],
    });
    expect(admitted.seq).toBe(2);
    const acl = await servers.B.readDocument(targetSpace, `of:${targetSpace}`);
    expect(acl?.value).toEqual({
      [aliceSigner.did()]: "OWNER",
      [bobSigner.did()]: "READ",
    });

    // Bob holds READ, so a change he makes is refused by the owner.
    const refused = await scope.acl(targetSpace, {
      ...change,
      actingPrincipal: bobSigner.did(),
      changes: [{
        principal: bobSigner.did(),
        level: "OWNER",
        actor: bobSigner.did(),
      }],
    }).catch((error) => error);
    expect(isServedRefusal(refused, "refused")).toBe(true);
    scope.dispose();
  });

  //
  // The routed wave commit sink
  //
  // The sink a tenure commits through with a route: a home batch and a home
  // access-list change go to the sink it wraps, every other to the owner.
  //

  const foreignBatch = (space: MemorySpace): WaveSpaceCommit => ({
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
  });

  /** A sink that records what reaches it and commits nothing. */
  const recordingSink = (): WaveCommitSink & { batches: WaveSpaceCommit[] } => {
    const batches: WaveSpaceCommit[] = [];
    return {
      batches,
      currentHeads: () => Promise.resolve(new Map()),
      concurrentWritePaths: () => Promise.resolve([]),
      staleReads: () => Promise.resolve([]),
      sessionOverwritePathsSince: () => Promise.resolve([]),
      commitWave: (batch) => {
        batches.push(batch);
        return Promise.resolve({ ok: { seq: 7 } });
      },
    };
  };

  it("fails a foreign batch, keeping the home one for the sink it wraps, when the owner is unreachable", async () => {
    const plane = new RoutedPlane({
      ...route(),
      createTransport: () => {
        throw new Error("the owner is unreachable");
      },
    });
    planes.push(plane);
    const inner = recordingSink();
    const sink = routedWaveCommitSink(inner, plane.scope(), homeSpace);

    const foreign = await sink.commitWave(foreignBatch(targetSpace));
    expect(foreign.error?.name).toBe("WaveCommitRejected");
    expect(foreign.error?.message).toContain("unreachable");
    expect(inner.batches).toEqual([]);

    const home = await sink.commitWave({
      ...foreignBatch(homeSpace),
      home: true,
    });
    expect(home.ok?.seq).toBe(7);
    expect(inner.batches.length).toBe(1);
  });

  it("sends a foreign batch and a foreign access-list change to the owner through the scope, and nothing to the sink it wraps", async () => {
    const sent: Array<{ kind: string; space: string }> = [];
    const scope: RoutedScope = {
      append: () => Promise.reject(new Error("not an append")),
      commit: (space) => {
        sent.push({ kind: "commit", space });
        return Promise.resolve({ seq: 11 });
      },
      acl: (space) => {
        sent.push({ kind: "acl", space });
        return Promise.resolve({ seq: 12 });
      },
      watchDocument: () => Promise.reject(new Error("not a watch")),
      dispose: () => {},
    };
    const inner = recordingSink();
    const sink = routedWaveCommitSink(inner, scope, homeSpace);

    expect((await sink.commitWave(foreignBatch(targetSpace))).ok?.seq).toBe(
      11,
    );
    const change = {
      space: targetSpace,
      actingPrincipal: aliceSigner.did(),
      capabilityRef: "event-consequence:evt",
      sourceEvent: { space: homeSpace, sidecarId: "sidecar", eventId: "evt" },
      changes: [],
      change: () => ({}),
    };
    expect((await sink.commitSpaceAccessChange!(change)).ok?.seq).toBe(12);
    expect(sent).toEqual([
      { kind: "commit", space: targetSpace },
      { kind: "acl", space: targetSpace },
    ]);
    expect(inner.batches).toEqual([]);
  });
});
