// Owner routing (docs/plans/serving-loop-owner-routing.md, R1): a serving
// loop reaches a space other than its home through that space's owner. Two
// memory servers over one file store stand for two processes of a
// deployment, each with its own ExecutorHost; the route maps a space to the
// server that owns it, and routed sessions connect to that server over the
// loopback transport.

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
import { acquireServerExecutionEnabler } from "@commonfabric/memory/v2";
import { applyCommit, read as readDoc } from "@commonfabric/memory/v2/engine";
import type { AdmittedCommitNotice } from "@commonfabric/memory/v2/server";
import {
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { SpaceOutbox } from "../src/executor/outbox.ts";
import {
  RoutedPlane,
  type RouteOptions,
} from "../src/executor/routed-plane.ts";
import { servedRequestHandler } from "../src/executor/served-requests.ts";
import { emptyServingLoopStats } from "../src/executor/stats.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { ArrivalLog, awaitAdmitted } from "./support/serving-waits.ts";
import {
  TEST_SESSION_OPEN_AUDIENCE,
  testPrincipalSessionOpenAuthFactory,
} from "./memory-v2-test-utils.ts";

const serviceSigner = await Identity.fromPassphrase("owner routing service");
const aliceSigner = await Identity.fromPassphrase("owner routing alice");
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

  /** The route of the deployment: each space's owner by the test's map. */
  const route = (): RouteOptions => ({
    createTransport: (space) => {
      const owner = owners.get(space);
      if (owner === undefined) throw new Error(`no owner for ${space}`);
      return MemoryClient.loopback(owner);
    },
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
      createRuntime: (space) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
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
      localSeq: 1,
    };
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);

    const first = plane.scope();
    const second = plane.scope();
    await first.append(targetSpace, entry);
    await second.append(targetSpace, { ...entry, localSeq: 2 });
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([targetSpace]);

    first.dispose();
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([targetSpace]);
    second.dispose();
    expect(plane.accessForTestingOnly.sessionSpaces).toEqual([]);
  });
});
