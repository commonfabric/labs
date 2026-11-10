/** Measures cold manager demand on the serving side as well as the reader. */
import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/js-values/types";
import { getTimingStatsBreakdown } from "@commonfabric/logger";
import {
  adoptProcessInstanceId,
  processInstanceId,
} from "@commonfabric/memory/v2/execution-lease";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import type { Runtime } from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { servingRuntimeFactory } from "@commonfabric/runner/executor/serving-runtime";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import { namesInstancesByDefault } from "@commonfabric/runner/storage/cache.deno";
import {
  claimPatternEnvironment,
  MultiRuntimeHarness,
  type PieceAddress,
} from "./multi-runtime-harness.ts";

const patterns = fromFileUrl(new URL("..", import.meta.url));
const fixture = join(
  patterns,
  "integration/fixtures/fabrichat-add-offer/main.tsx",
);
const snapshots = ["room", "schemas"].map((name) => ({
  name: `/system/fabrichat/${name}.tsx`,
  filePath: join(
    patterns,
    `integration/fixtures/fabrichat-metadata-upgrade/${name}-before.tsx.txt`,
  ),
}));
const listSchema = {
  type: "object",
  properties: {
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          room: { type: "object", properties: {}, asCell: ["cell"] },
          kind: { type: "string" },
          since: { type: "FabricEpochNsec" },
        },
      },
    },
  },
};

/** The fixed pre-descriptor room sources, with their ordinary dependencies. */
async function baselineTree(temporary: string): Promise<string> {
  const vintage = join(temporary, "patterns");
  await Deno.mkdir(join(vintage, "system/fabrichat"), { recursive: true });
  for await (const entry of Deno.readDir(join(patterns, "system"))) {
    if (entry.name !== "fabrichat") {
      await Deno.symlink(
        join(patterns, "system", entry.name),
        join(vintage, "system", entry.name),
      );
    }
  }
  for await (const entry of Deno.readDir(join(patterns, "system/fabrichat"))) {
    const snapshot = snapshots.find((item) =>
      item.name.endsWith(`/${entry.name}`)
    );
    const destination = join(vintage, "system/fabrichat", entry.name);
    if (snapshot) await Deno.copyFile(snapshot.filePath, destination);
    else {await Deno.symlink(
        join(patterns, "system/fabrichat", entry.name),
        destination,
      );}
  }
  return vintage;
}

async function measure(
  candidate: boolean,
  roomCount: number,
  messageCount: number,
) {
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => adoptProcessInstanceId(processInstanceId));
  const temporary = await Deno.makeTempDir({ prefix: "chat-cold-demand-" });
  cleanup.defer(() => Deno.remove(temporary, { recursive: true }));
  const vintage = await baselineTree(temporary);
  const route = candidate
    ? new PatternsRoute(patterns)
    : new PatternsRoute(patterns, [{
      routePrefix: "system/",
      directory: join(vintage, "system"),
    }]);
  const service = await Identity.fromPassphrase("chat demand service");
  const identity = await Identity.fromPassphrase("chat demand owner");
  const start = () => {
    // Each fully stopped host is followed by a simulated fresh process.
    adoptProcessInstanceId(crypto.randomUUID());
    const server = StandaloneMemoryServer.start({
      store: toFileUrl(`${temporary}/store/`),
      acl: { mode: "enforce", delegatingDids: [service.did()] },
      namesInstances: namesInstancesByDefault,
      serve: (request) => route.serve(request),
    });
    const release = claimPatternEnvironment(server.url);
    const loaded = new Map<string, Set<string>>();
    const runtimes = new Map<string, Runtime>();
    const factory = servingRuntimeFactory({
      server: server.server,
      identity: service,
      apiUrl: server.url,
      prepareStorageManager: (manager) => {
        manager.subscribe({
          next: (notification) => {
            if (
              notification.type === "load" || notification.type === "pull" ||
              notification.type === "integrate"
            ) {
              const ids = loaded.get(notification.space) ?? new Set<string>();
              for (const change of notification.changes) {
                ids.add(change.address.id);
              }
              loaded.set(notification.space, ids);
            }
            return undefined;
          },
        });
      },
    });
    const host = new ExecutorHost({
      server: server.server,
      serviceIdentity: service.did(),
      ensureSpaceRoots: false,
      createRuntime: async (space, context) => {
        const result = await factory(space, context);
        runtimes.set(space, result.runtime);
        return result;
      },
    });
    return {
      server,
      host,
      loaded,
      runtimes,
      close: async () => {
        try {
          await host.close();
        } finally {
          await server.close();
          release();
        }
      },
    };
  };
  let serving = start();
  cleanup.defer(() => serving.close());
  let harness = await MultiRuntimeHarness.create({
    apiUrl: serving.server.url,
    programPath: fixture,
    rootPath: patterns,
    watchPaths: [],
    ...(candidate ? {} : { sourceSnapshots: snapshots }),
    sessions: [{
      label: "owner",
      identity,
      cfc: { experimental: { serverExecution: true } },
    }],
  });
  cleanup.defer(() => harness.dispose());
  const owner = harness.sessions[0];
  await owner.send("createProfile", { name: "Ada" });
  await harness.settle();
  await owner.client().call("linkHomeRoot", {});
  const rooms: PieceAddress[] = [];
  for (let index = 0; index < roomCount; index++) {
    const requestId = `room-${index}`;
    await owner.send("createGroup", {
      requestId,
      title: requestId,
      members: [],
    }, { surface: "ChatStartSurface", action: "ChatStart" });
    await owner.client().call("waitForAddressValue", {
      link: { "/": { "link@1": await owner.link([]) } },
      path: ["requests", requestId, "status"],
      expected: "done",
    });
    rooms.push(await owner.link(["requests", requestId, "entry", "room"]));
  }
  for (let index = 0; index < messageCount; index++) {
    await owner.send("sendMessage", { body: `Message ${index}` }, {
      surface: "ChatSendSurface",
      action: "ChatSend",
    }, { piece: rooms[0] });
    await harness.settle();
  }
  expect(await owner.read(["messages", "count"], { piece: rooms[0] })).toBe(
    messageCount,
  );
  const messages = await Promise.all(
    Array.from(
      { length: messageCount },
      (_, index) =>
        owner.link(["messages", "latest", "messages", index], {
          piece: rooms[0],
        }),
    ),
  );
  expect(isPlainObject(await owner.read(["metadata"], { piece: rooms[0] })))
    .toBe(candidate);
  const manager = await owner.link(["chatManager"]);
  const spaceDid = harness.spaceDid;
  const pieceId = harness.pieceId;
  await harness.dispose();
  await serving.close();

  // Every serving runtime and reader is cold; the disk store alone survives.
  const actionsBefore =
    getTimingStatsBreakdown().scheduler?.["scheduler/run/action"]?.count ?? 0;
  serving = start();
  harness = await MultiRuntimeHarness.create({
    apiUrl: serving.server.url,
    programPath: fixture,
    rootPath: patterns,
    spaceDid,
    pieceId,
    watchPaths: [],
    sessions: [{
      label: "reader",
      identity,
      unattached: true,
      cfc: { experimental: { serverExecution: true } },
    }],
  });
  const reader = harness.sessions[0];
  await reader.client().call("watchAddress", {
    link: { "/": { "link@1": { ...manager, schema: listSchema } } },
  });
  await reader.client().call("waitForAddressValue", {
    path: ["rooms", "length"],
    expected: roomCount,
  });
  await serving.host.whenQuiescent();
  await harness.settle();
  expect(
    (await reader.diagnostics()).graph.nodes.filter((node) =>
      node.type === "computation"
    ),
  )
    .toHaveLength(0);
  const distinctLoadedMessages =
    messages.filter((message) =>
      serving.loaded.get(message.space)?.has(message.id)
    ).length;
  const held = [...serving.runtimes].map(([space, runtime]) => {
    const storage = runtime.getSizes().storage;
    if (storage === null) {
      throw new TypeError("Serving runtime has no storage sizes.");
    }
    return { space, storage, scheduler: runtime.scheduler.getStats() };
  });
  let clientMessageDocuments = 0;
  for (const message of messages) {
    if ((await reader.rawRead(message)).value !== undefined) {
      clientMessageDocuments++;
    }
  }
  const result = {
    candidate,
    roomCount,
    messageCount,
    distinctLoadedMessages,
    clientMessageDocuments,
    serverRooms: rooms.map((room) => ({
      loadedDocuments: serving.loaded.get(room.space)?.size ?? 0,
      retainedDocuments: held.reduce((sum, runtime) =>
        sum +
        (runtime.storage.bySpace.find((entry) => entry.space === room.space)
          ?.documents ?? 0), 0),
    })),
    serverComputations: held.reduce(
      (sum, entry) => sum + entry.scheduler.computations,
      0,
    ),
    serverActionRuns:
      (getTimingStatsBreakdown().scheduler?.["scheduler/run/action"]?.count ??
        0) -
      actionsBefore,
    serverStats: serving.host.stats(),
    clientSizes: await reader.client().call("memorySizes", {}),
  };
  expect(result.serverActionRuns).toBeGreaterThan(0);
  console.log("Cold manager demand", JSON.stringify(result));

  // Opening the conversation controls the load observer after measurement.
  await reader.readAs(["messages"], {
    type: "object",
    properties: {
      latest: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: { body: { type: "string" } },
            },
          },
        },
      },
    },
  }, { piece: rooms[0] });
  await serving.host.whenQuiescent();
  await harness.settle();
  for (const message of messages) {
    expect(serving.loaded.get(message.space)?.has(message.id)).toBe(true);
  }
  return result;
}

describe("FabriChat descriptor manager demand", () => {
  it("bounds descriptor overhead during cold manager discovery", async () => {
    for (const [rooms, messages] of [[1, 1], [1, 20]]) {
      const baseline = await measure(false, rooms, messages);
      const candidate = await measure(true, rooms, messages);
      expect(candidate.distinctLoadedMessages).toBeLessThanOrEqual(
        baseline.distinctLoadedMessages,
      );
      expect(candidate.clientMessageDocuments).toBeLessThanOrEqual(
        baseline.clientMessageDocuments,
      );
      // The projection's computation allowance is per room and stays fixed
      // as history grows. Document totals also retain startup/replay records,
      // so those observations remain diagnostics rather than a graph bound.
      expect(candidate.serverComputations).toBeLessThanOrEqual(
        baseline.serverComputations + 6 * rooms,
      );
    }
  });
});
