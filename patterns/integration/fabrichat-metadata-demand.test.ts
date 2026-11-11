/** Measures the complete native manager read against identical persisted data. */

import { expect } from "@std/expect";
import { copy } from "@std/fs";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getLogger, getLoggerCountsBreakdown } from "@commonfabric/logger";
import { type FabricValue } from "@commonfabric/data-model";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  adoptProcessInstanceId,
  processInstanceId,
} from "@commonfabric/memory/v2/execution-lease";
import { readState } from "@commonfabric/memory/v2/engine";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import {
  ContextualFlowControl,
  parseLink,
  type Runtime,
} from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { servingRuntimeFactory } from "@commonfabric/runner/executor/serving-runtime";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import { namesInstancesByDefault } from "@commonfabric/runner/storage/cache.deno";
import {
  claimPatternEnvironment,
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
} from "./multi-runtime-harness.ts";

const patterns = fromFileUrl(new URL("..", import.meta.url));
const fixturePath = "integration/fixtures/fabrichat-add-offer/main.tsx";
const fixture = join(patterns, fixturePath);
const source = `system:${fixturePath}`;
/** The shipped room handle adopts its stored schema; the bounded arm does not. */
function managerListSchema(bounded: boolean, compact = false) {
  const entrySchema = {
    type: "object",
    properties: {
      room: {
        type: "object",
        asCell: ["cell"],
        ...(bounded ? { properties: {} } : {}),
      },
      kind: { type: "string" },
      counterpart: { type: "string" },
      since: { type: "FabricEpochNsec" },
      ...(compact
        ? {
          title: { type: "string" },
          revision: { type: "string" },
          metadata: {
            type: "object",
            asCell: ["cell"],
            ...(bounded ? { properties: {} } : {}),
          },
        }
        : {}),
    },
  };
  // Native clients retain request outcomes and the catalog alongside rooms.
  // Completed requests are deliberately seeded: their room links also matter.
  return {
    type: "object",
    properties: {
      rooms: { type: "array", items: entrySchema },
      requests: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            status: { type: "string" },
            reason: { type: "string" },
            code: { type: "string" },
            entry: entrySchema,
          },
        },
      },
      sharedSpaceCatalog: {
        type: "object",
        properties: {
          entries: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                kind: { type: "string" },
                title: { type: "string" },
              },
            },
          },
        },
      },
    },
  };
}

function record(value: FabricValue): Record<string, FabricValue> {
  if (!isPlainObject(value)) throw new TypeError("Expected a worker record");
  return value;
}

/** Standalone Memory has no deployment-meta endpoint; all other errors fail. */
function executionErrorCount(breakdown: unknown): number {
  if (!isPlainObject(breakdown)) throw new TypeError("Expected logger counts");
  return Object.entries(breakdown).reduce((sum, [logger, counts]) => {
    if (!isPlainObject(counts)) return sum;
    return sum +
      Object.entries(counts).reduce<number>(
        (total, [key, levels]) =>
          total +
          (logger === "deployment-meta" && key === "posture-unread"
            ? 0
            : isPlainObject(levels) && typeof levels.error === "number"
            ? levels.error
            : 0),
        0,
      );
  }, 0);
}

function assertNoExecutionErrors(errors: Record<string, number>): void {
  expect(errors).toEqual(
    Object.fromEntries(Object.keys(errors).map((key) => [key, 0])),
  );
}

/** Pins either the exact 27d9003f4a producer or the candidate at test start. */
async function sourceTree(
  temporary: string,
  candidateSources?: ReadonlyMap<string, string>,
): Promise<string> {
  const vintage = join(
    temporary,
    candidateSources ? "candidate-patterns" : "baseline-patterns",
  );
  await Deno.mkdir(join(vintage, "system/fabrichat"), { recursive: true });
  for await (const entry of Deno.readDir(patterns)) {
    if (entry.name !== "system" && entry.name !== "integration") {
      await Deno.symlink(join(patterns, entry.name), join(vintage, entry.name));
    }
  }
  for await (const entry of Deno.readDir(join(patterns, "system"))) {
    if (entry.name !== "fabrichat") {
      await Deno.symlink(
        join(patterns, "system", entry.name),
        join(vintage, "system", entry.name),
      );
    }
  }
  for await (const entry of Deno.readDir(join(patterns, "system/fabrichat"))) {
    const destination = join(vintage, "system/fabrichat", entry.name);
    const name = entry.name.replace(/\.tsx$/, "");
    if (["manager", "room", "schemas"].includes(name)) {
      const candidateSource = candidateSources?.get(name);
      if (candidateSource !== undefined) {
        await Deno.writeTextFile(destination, candidateSource);
      } else {
        await Deno.copyFile(
          join(
            patterns,
            `integration/fixtures/fabrichat-manager-demand/${name}-before.tsx.txt`,
          ),
          destination,
        );
      }
    } else {
      await Deno.symlink(
        join(patterns, "system/fabrichat", entry.name),
        destination,
      );
    }
  }
  await Deno.mkdir(join(vintage, "integration/fixtures/fabrichat-add-offer"), {
    recursive: true,
  });
  await Deno.copyFile(fixture, join(vintage, fixturePath));
  return vintage;
}

function startServing(store: string, route: PatternsRoute, service: Identity) {
  // All predecessor hosts are closed before simulating the next process.
  adoptProcessInstanceId(crypto.randomUUID());
  const server = StandaloneMemoryServer.start({
    store: toFileUrl(`${store}/`),
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
          if (["load", "pull", "integrate"].includes(notification.type)) {
            if (!("changes" in notification)) return undefined;
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
}

interface DemandArm {
  name: string;
  candidate: boolean;
  bounded: boolean;
  compact?: boolean;
}

async function compare(
  messageCount: number,
  candidateSources: ReadonlyMap<string, string>,
  arms: readonly DemandArm[] = [
    { name: "baseline-shipped", candidate: false, bounded: false },
    { name: "baseline-bounded", candidate: false, bounded: true },
    { name: "candidate-shipped", candidate: true, bounded: false },
    { name: "candidate-bounded", candidate: true, bounded: true },
  ],
) {
  const initialServingErrors = executionErrorCount(getLoggerCountsBreakdown());
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => adoptProcessInstanceId(processInstanceId));
  const temporary = await Deno.makeTempDir({ prefix: "chat-manager-demand-" });
  cleanup.defer(() => Deno.remove(temporary, { recursive: true }));
  const vintage = await sourceTree(temporary);
  const candidateTree = await sourceTree(temporary, candidateSources);
  const candidateRoute = new PatternsRoute(patterns, [{
    routePrefix: "system/",
    directory: join(candidateTree, "system"),
  }]);
  const baselineRoute = new PatternsRoute(patterns, [{
    routePrefix: "system/",
    directory: join(vintage, "system"),
  }]);
  const service = await Identity.fromPassphrase("chat demand service");
  const identity = await Identity.fromPassphrase("chat demand owner");
  const seedStore = join(temporary, "seed");
  let serving = startServing(seedStore, baselineRoute, service);
  cleanup.defer(() => serving.close());
  let harness = await MultiRuntimeHarness.create({
    apiUrl: serving.server.url,
    programPath: fixture,
    rootPath: patterns,
    sourceSnapshots: ["manager", "room", "schemas"].map((name) => ({
      name: `/system/fabrichat/${name}.tsx`,
      filePath: join(
        patterns,
        `integration/fixtures/fabrichat-manager-demand/${name}-before.tsx.txt`,
      ),
    })),
    watchPaths: [],
    sessions: [{
      label: "owner",
      identity,
      cfc: { experimental: { serverExecution: true } },
    }],
  });
  cleanup.defer(() => harness.dispose());
  const owner = harness.sessions[0];
  const home = await owner.link([]);
  expect(
    await owner.client().call("repointPiece", { piece: home, url: source }),
  )
    .toMatchObject({ status: "applied" });
  await owner.send("createProfile", { name: "Ada" });
  await harness.settle();
  await owner.client().call("linkHomeRoot", {});
  await owner.send("createGroup", {
    requestId: "created",
    title: "Stored room",
    members: [],
  }, {
    surface: "ChatStartSurface",
    action: "ChatStart",
  });
  await owner.client().call("waitForAddressValue", {
    link: { "/": { "link@1": home } },
    path: ["requests", "created", "status"],
    expected: "done",
  });
  const room = await owner.link(["requests", "created", "entry", "room"]);
  const manager = await owner.link(["chatManager"]);
  expect(
    await owner.client().call("repointPiece", {
      piece: room,
      url: "system:system/fabrichat/room.tsx",
    }),
  ).toMatchObject({ status: "applied" });
  await owner.send(
    "joinRoom",
    {
      requestId: "joined",
      room: { "/": { "link@1": room } },
    },
    undefined,
    { piece: manager },
  );
  await owner.client().call("waitForAddressValue", {
    link: { "/": { "link@1": manager } },
    path: ["requests", "joined", "status"],
    expected: "done",
  });
  for (let index = 0; index < messageCount; index++) {
    await owner.send("sendMessage", { body: `Message ${index}` }, {
      surface: "ChatSendSurface",
      action: "ChatSend",
    }, { piece: room });
    await harness.settle();
  }
  expect(await owner.read(["messages", "count"], { piece: room })).toBe(
    messageCount,
  );
  const messages = await Promise.all(
    Array.from({ length: messageCount }, async (_, index) => ({
      link: await owner.link(["messages", "latest", "messages", index], {
        piece: room,
      }),
      body: await owner.read(
        ["messages", "latest", "messages", index, "body"],
        { piece: room },
      ),
    })),
  );
  const seedClientErrors = executionErrorCount(
    await owner.client().call("loggerCounts", {}),
  );
  const spaceDid = harness.spaceDid;
  const pieceId = harness.pieceId;
  await harness.dispose();
  await serving.close();

  const results = [];
  for (
    const { name, candidate, bounded, compact = false } of arms
  ) {
    const store = join(temporary, name);
    // The seed's server and every writer are closed: all arms start with
    // precisely the same SQLite files, identities, records and request history.
    await copy(seedStore, store);
    const route = candidate ? candidateRoute : baselineRoute;
    serving = startServing(store, route, service);
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
    let reader = harness.sessions[0];
    let listAddress: ReturnType<typeof parseLink>;
    let clientExecutionErrors = 0;
    const tracePhase = async (reader: MultiRuntimeSession, phase: string) => {
      const arrivals = await reader.client().call("observedDocuments", {});
      if (!Array.isArray(arrivals)) {
        throw new TypeError("Expected observed docs");
      }
      const client = new Map(arrivals.map((item) => {
        const row = record(item);
        if (typeof row.space !== "string" || !Array.isArray(row.ids)) {
          throw new TypeError("Expected observed document ids");
        }
        return [row.space, new Set(row.ids)] as const;
      }));
      const result = {
        name,
        phase,
        clientDocuments: [...client.values()].reduce(
          (sum, ids) => sum + ids.size,
          0,
        ),
        serverDocuments: [...serving.loaded.values()].reduce(
          (sum, ids) => sum + ids.size,
          0,
        ),
        clientMessages: messages.filter(({ link }) =>
          client.get(link.space)?.has(link.id)
        ).length,
        serverMessages: messages.filter(({ link }) =>
          serving.loaded.get(link.space)?.has(link.id)
        ).length,
      };
      console.log("Native manager phase", JSON.stringify(result));
      return result;
    };
    const subscribe = async (reader: MultiRuntimeSession, phase: string) => {
      await reader.client().call("observeDocuments", {});
      // Home owns the embedded manager's source. Demand its narrow projection
      // so normal source following updates that closure before reading its list.
      await reader.client().call("watchAddress", {
        link: {
          "/": {
            "link@1": {
              ...home,
              schema: {
                type: "object",
                properties: { $NAME: { type: "string" } },
              },
            },
          },
        },
      });
      await reader.client().call("waitForAddressValue", {
        path: ["$NAME"],
        expected: "FabriChat add offer fixture",
      });
      await serving.host.whenQuiescent();
      await harness.settle();
      const currentSource = record(
        await reader.client().call("pieceSource", {
          piece: home,
          start: false,
        }),
      );
      expect(currentSource.pattern).toMatchObject({
        identity: await route.identity(fixturePath),
      });
      await tracePhase(reader, `${phase}.home`);
      if (compact) {
        const address = await reader.client().call("addressLink", {
          link: {
            "/": {
              "link@1": {
                ...manager,
                schema: {
                  type: "object",
                  properties: {
                    list: { type: "object", properties: {} },
                  },
                },
              },
            },
          },
          path: ["list"],
        });
        listAddress = parseLink({ "/": { "link@1": address } });
        expect(listAddress?.scope).toBe("user");
        expect(listAddress?.id).not.toBe(manager.id);
        expect(listAddress?.path).toEqual([]);
        await tracePhase(reader, `${phase}.list-discovery`);
      }
      const subscription = await reader.client().call("watchAddress", {
        link: {
          "/": {
            "link@1": {
              ...(compact ? listAddress : manager),
              schema: managerListSchema(bounded, compact),
            },
          },
        },
        fields: ["rooms", "requests", "sharedSpaceCatalog"],
        observedAddresses: messages.map(({ link }) =>
          link
        ),
      });
      console.log(
        "Native manager field phases",
        JSON.stringify({
          name,
          phase,
          stages: record(subscription).stages,
        }),
      );
      const list = record(
        await reader.client().call("waitForAddressValue", {
          path: ["rooms", "length"],
          expected: 1,
        }),
      );
      await serving.host.whenQuiescent();
      await harness.settle();
      const requests = record(list.requests);
      for (const id of ["created", "joined"]) {
        expect(record(requests[id]).status).toBe("done");
        expect(parseLink(record(record(requests[id]).entry).room))
          .toMatchObject({ space: room.space, id: room.id });
      }
      expect(isPlainObject(list.sharedSpaceCatalog)).toBe(true);
      const entries = list.rooms;
      if (!Array.isArray(entries)) throw new TypeError("Expected manager rows");
      const listed = parseLink(record(entries[0]).room);
      expect(listed).toMatchObject({ space: room.space, id: room.id });
      if (compact) expect(record(entries[0]).title).toBe("Stored room");
      expect(
        (await reader.diagnostics()).graph.nodes.filter((node) =>
          node.type === "computation"
        ),
      ).toHaveLength(0);
    };
    const measure = async (phase: string) => {
      const arrivals = await reader.client().call("observedDocuments", {});
      if (!Array.isArray(arrivals)) {
        throw new TypeError("Expected document observations");
      }
      const client = new Map(arrivals.map((item) => {
        const row = record(item);
        if (typeof row.space !== "string" || !Array.isArray(row.ids)) {
          throw new TypeError("Expected observed document ids");
        }
        return [row.space, new Set(row.ids)];
      }));
      const count = (
        loaded: ReadonlyMap<string, ReadonlySet<unknown>>,
        addresses: readonly PieceAddress[],
      ) =>
        addresses.filter((address) =>
          loaded.get(address.space)?.has(address.id)
        ).length;
      const graph = [...serving.runtimes.values()].map((runtime) =>
        runtime.scheduler.getStats()
      );
      const clientErrors = executionErrorCount(
        await reader.client().call("loggerCounts", {}),
      );
      clientExecutionErrors += clientErrors;
      const result = {
        clientErrors,
        servingErrors: executionErrorCount(getLoggerCountsBreakdown()) -
          initialServingErrors,
        candidate,
        queryShape: compact ? "compact" : bounded ? "bounded" : "shipped",
        phase,
        messageCount,
        serverExecution: true,
        serverRoomRoots: count(serving.loaded, [room]),
        clientRoomRoots: count(client, [room]),
        serverMessageDocuments: count(
          serving.loaded,
          messages.map((message) => message.link),
        ),
        clientMessageDocuments: count(
          client,
          messages.map((message) => message.link),
        ),
        serverLoadedDocuments: [...serving.loaded.values()].reduce(
          (sum, ids) => sum + ids.size,
          0,
        ),
        clientLoadedDocuments: [...client.values()].reduce(
          (sum, ids) => sum + ids.size,
          0,
        ),
        serverComputations: graph.reduce(
          (sum, stats) => sum + stats.computations,
          0,
        ),
        serverStorage: [...serving.runtimes.values()].map((runtime) =>
          runtime.getSizes().storage
        ),
        clientSizes: await reader.client().call("memorySizes", {}),
        serverStats: serving.host.stats(),
      };
      console.log("Native manager demand", JSON.stringify(result));
      return result;
    };
    await subscribe(reader, "cold");
    const cold = await measure("cold");
    if (bounded || compact) {
      console.log(
        "Native manager graph",
        JSON.stringify({
          candidate,
          messageCount,
          room,
          manager,
          messages: messages.map((message) => message.link),
          graphs: [...serving.runtimes].map(([space, runtime]) => ({
            space,
            readers: runtime.scheduler.getGraphSnapshot().nodes.filter((node) =>
              [...(node.reads ?? []), ...(node.shallowReads ?? [])].some((
                read,
              ) => messages.some((message) => read.includes(message.link.id)))
            ),
          })),
        }),
      );
    }
    await reader.client().call("waitForAddressValue", {
      path: ["rooms", "length"],
      expected: 1,
    });
    await serving.host.whenQuiescent();
    const warm = await measure("warm");
    expect(warm.serverMessageDocuments).toBe(cold.serverMessageDocuments);
    await harness.closeSession("reader");
    reader = await harness.addSession({
      label: "reopened",
      identity,
      unattached: true,
      cfc: { experimental: { serverExecution: true } },
    });
    await subscribe(reader, "reopened");
    const reopened = await measure("reopened");
    expect(reopened.serverMessageDocuments).toBe(cold.serverMessageDocuments);
    const upgradeServerStats = serving.host.stats();
    if (compact) {
      if (listAddress?.id === undefined || listAddress.space === undefined) {
        throw new Error("The compact list has no resolved document address");
      }
      const engine = await serving.server.server.engineForSpace(
        listAddress.space,
      );
      const stored = readState(engine, {
        id: listAddress.id,
        scope: "user",
        principal: identity.did(),
      });
      expect(stored?.scope).toBe("user");
      expect(readState(engine, { id: listAddress.id })).toBeNull();
      const storedValue = record(stored?.document?.value);
      const storedRooms = storedValue.rooms;
      if (!Array.isArray(storedRooms)) {
        throw new TypeError("Expected stored list rows");
      }
      const stamps = [];
      const entries = [
        { location: "rooms[0]", entry: record(storedRooms[0]) },
        ...["created", "joined"].map((id) => ({
          location: `requests.${id}.entry`,
          entry: record(record(record(storedValue.requests)[id]).entry),
        })),
      ];
      for (const { location, entry } of entries) {
        for (const field of ["room", "metadata"]) {
          if (field === "metadata" && entry[field] === undefined) continue;
          const handle = parseLink(entry[field]);
          expect(handle).toBeDefined();
          const schema = handle?.schema;
          const resolved = isPlainObject(schema)
            ? ContextualFlowControl.resolveSchemaRefs(schema)
            : schema;
          const alternatives =
            isPlainObject(resolved) && Array.isArray(resolved.anyOf)
              ? resolved.anyOf.map((item) =>
                isPlainObject(item)
                  ? ContextualFlowControl.resolveSchemaRefs(item, resolved)
                  : item
              )
              : [resolved];
          const object = alternatives.find((item) =>
            isPlainObject(item) && item.type === "object"
          );
          stamps.push({ location, field, handle, resolved });
          console.log("Native compact handle", JSON.stringify(stamps.at(-1)));
          expect(object).toMatchObject({ type: "object", properties: {} });
          if (!isPlainObject(object)) {
            throw new TypeError("Expected an object schema");
          }
          expect(object.properties).toEqual({});
          expect(object.additionalProperties).not.toBe(true);
        }
      }
      console.log(
        "Native compact storage",
        JSON.stringify({
          listAddress,
          manager,
          scope: stored?.scope,
          scopeKey: stored?.scopeKey,
          valueFvj1: jsonFromFabricValue(storedValue),
          stamps,
        }),
      );
      await harness.dispose();
      await serving.close();
      serving = startServing(store, route, service);
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
      reader = harness.sessions[0];
      await subscribe(reader, "server-restarted");
      await measure("server-restarted");
    }
    const roomSource = record(
      await reader.client().call("pieceSource", {
        piece: room,
        start: false,
      }),
    );
    expect(roomSource.pattern).toMatchObject({
      identity: await route.identity("system/fabrichat/room.tsx"),
    });
    // The navigation control reads every original message, proving both the
    // identity/data preservation and the load observer's sensitivity.
    for (let index = 0; index < messages.length; index++) {
      expect(
        await reader.link(["messages", "latest", "messages", index], {
          piece: room,
        }),
      ).toEqual(messages[index].link);
      expect(
        await reader.read(["messages", "latest", "messages", index, "body"], {
          piece: room,
        }),
      ).toEqual(messages[index].body);
    }
    await serving.host.whenQuiescent();
    await harness.settle();
    const navigation = await tracePhase(reader, "navigation");
    expect(navigation.clientMessages).toBe(messageCount);
    expect(navigation.serverMessages).toBe(messageCount);
    clientExecutionErrors += executionErrorCount(
      await reader.client().call("loggerCounts", {}),
    );
    const executionErrors = {
      seedClient: seedClientErrors,
      clients: clientExecutionErrors,
      serving: executionErrorCount(getLoggerCountsBreakdown()) -
        initialServingErrors,
    };
    const finalServerStats = serving.host.stats();
    console.log(
      "Native manager navigation",
      JSON.stringify({
        candidate,
        queryShape: compact ? "compact" : bounded ? "bounded" : "shipped",
        messageCount,
        executionErrors,
        serverStats: finalServerStats,
      }),
    );
    results.push({
      ...cold,
      finalServerStats,
      upgradeServerStats,
      executionErrors,
    });
    await harness.dispose();
    await serving.close();
  }
  return results;
}

describe("FabriChat demand diagnostic guard", () => {
  it("rejects a recorded scheduler retry exhaustion", () => {
    const initial = executionErrorCount(getLoggerCountsBreakdown());
    const silence = stub(console, "error", () => {});
    try {
      getLogger("scheduler").error(
        "schedule-error",
        "Action raw:map:negative-control exhausted retries resolving inSpace names",
      );
      const seedClient = executionErrorCount(getLoggerCountsBreakdown()) -
        initial;
      expect(seedClient).toBe(1);
      expect(() => assertNoExecutionErrors({ seedClient })).toThrow();
    } finally {
      silence.restore();
    }
  });
});

describe("FabriChat compact native list demand", () => {
  it("serves a compact native list from its own per-user document", async () => {
    const candidateSources = new Map(
      await Promise.all(
        ["manager", "room", "schemas"].map(async (name) =>
          [
            name,
            await Deno.readTextFile(
              join(patterns, `system/fabrichat/${name}.tsx`),
            ),
          ] as const
        ),
      ),
    );
    const [baseline, baselineBounded, compact] = await compare(
      20,
      candidateSources,
      [
        { name: "baseline-shipped", candidate: false, bounded: false },
        { name: "baseline-bounded", candidate: false, bounded: true },
        {
          name: "candidate-compact",
          candidate: true,
          bounded: true,
          compact: true,
        },
      ],
    );
    for (const result of [baseline, baselineBounded, compact]) {
      assertNoExecutionErrors(result.executionErrors);
      for (
        const stats of [result.upgradeServerStats, result.finalServerStats]
      ) {
        expect(stats.structureLoadFailures).toBe(0);
        expect(stats.servedIntentSealFailures).toBe(0);
        expect(stats.foreignEngineFailures).toBe(0);
      }
    }
    expect(compact.clientMessageDocuments).toBe(0);
    expect(compact.clientLoadedDocuments).toBeLessThan(
      baselineBounded.clientLoadedDocuments,
    );
    const compactStorage = record(record(compact.clientSizes).storage);
    const boundedStorage = record(record(baselineBounded.clientSizes).storage);
    for (const field of ["documents", "approxBytes"]) {
      const actual = compactStorage[field];
      const baseline = boundedStorage[field];
      if (typeof actual !== "number" || typeof baseline !== "number") {
        throw new TypeError(`Expected numeric storage ${field}`);
      }
      expect(actual).toBeLessThan(baseline);
    }
  });
});

describe("FabriChat descriptor manager demand", () => {
  it("bounds descriptor overhead during cold manager discovery", async () => {
    const candidateSources = new Map(
      await Promise.all(
        ["manager", "room", "schemas"].map(async (name) =>
          [
            name,
            await Deno.readTextFile(
              join(patterns, `system/fabrichat/${name}.tsx`),
            ),
          ] as const
        ),
      ),
    );
    for (const messages of [1, 20]) {
      const [baseline, baselineBounded, candidate, bounded] = await compare(
        messages,
        candidateSources,
      );
      for (const result of [baseline, baselineBounded, candidate, bounded]) {
        assertNoExecutionErrors(result.executionErrors);
        expect(result.finalServerStats.structureLoadFailures).toBe(0);
        expect(result.finalServerStats.servedIntentSealFailures).toBe(0);
        expect(result.finalServerStats.foreignEngineFailures).toBe(0);
      }
      expect(candidate.serverMessageDocuments).toBeLessThanOrEqual(
        baseline.serverMessageDocuments,
      );
      expect(candidate.clientMessageDocuments).toBeLessThanOrEqual(
        baseline.clientMessageDocuments,
      );
      expect(bounded.clientMessageDocuments).toBeLessThanOrEqual(
        baselineBounded.clientMessageDocuments,
      );
      expect(bounded.serverMessageDocuments).toBeLessThanOrEqual(
        candidate.serverMessageDocuments,
      );
      expect(bounded.clientMessageDocuments).toBeLessThanOrEqual(
        candidate.clientMessageDocuments,
      );
    }
  });
});
