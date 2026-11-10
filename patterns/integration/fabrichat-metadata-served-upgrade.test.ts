/**
 * Replays the pre-metadata FabriChat source from 4efa1c0882999a5052b134c91d70c364d7a91468
 * over persisted rooms, with enforced access lists and an actual serving loop.
 * Fresh worker clients and a new serving host reopen the same disk store.
 */

import { expect } from "@std/expect";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/js-values/types";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { idStringForEntityAddress } from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { servingRuntimeFactory } from "@commonfabric/runner/executor/serving-runtime";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import { namesInstancesByDefault } from "@commonfabric/runner/storage/cache.deno";
import { awaitAdmitted } from "../../runtime/runner/test/support/serving-waits.ts";
import {
  claimPatternEnvironment,
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
} from "./multi-runtime-harness.ts";

const patterns = fromFileUrl(new URL("..", import.meta.url));
const source = "system:system/fabrichat/room.tsx";
const gesture = (action: string) => ({ surface: `${action}Surface`, action });

/** Reads the message's actual record alongside its stable storage address. */
async function messageAt(
  session: MultiRuntimeSession,
  room: PieceAddress,
  index: number,
) {
  const path = ["messages", "latest", "messages", index];
  return {
    link: await session.link(path, { piece: room }),
    value: await session.readRaw(path, { piece: room }),
  };
}

/** Narrows a worker's value before inspecting its fields. */
function record(value: FabricValue): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError("Expected a record from the worker");
  }
  return value;
}

/** Allows read-only subscription callbacks, but no authored execution or writes. */
async function assertPassiveReader(reader: MultiRuntimeSession) {
  const diagnostics = await reader.diagnostics();
  expect(diagnostics.graph.nodes.filter((node) => node.type === "computation"))
    .toHaveLength(0);
  for (const entry of diagnostics.actionRunTrace) {
    const action = record(entry);
    expect(action.actionId).toMatch(/^sink:/);
    expect(action).toMatchObject({
      actionType: "effect",
      declaredWrites: [],
      actualWrites: [],
    });
  }
}

describe("FabriChat metadata served upgrade", () => {
  for (const update of [true, false]) {
    it(
      update
        ? "upgrades persisted rooms on server demand without backfill"
        : "keeps an unchanged old room usable after server restart",
      async () => {
        await using cleanup = new AsyncDisposableStack();
        const temporary = await Deno.makeTempDir({
          prefix: "chat-served-upgrade-",
        });
        cleanup.defer(() => Deno.remove(temporary, { recursive: true }));
        const vintage = join(temporary, "patterns");
        await Deno.mkdir(join(vintage, "system/fabrichat"), {
          recursive: true,
        });
        for await (const entry of Deno.readDir(patterns)) {
          if (entry.name !== "system") {
            await Deno.symlink(
              join(patterns, entry.name),
              join(vintage, entry.name),
            );
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
        for await (
          const entry of Deno.readDir(join(patterns, "system/fabrichat"))
        ) {
          const destination = join(vintage, "system/fabrichat", entry.name);
          if (entry.name === "room.tsx" || entry.name === "schemas.tsx") {
            await Deno.copyFile(
              new URL(
                `./fixtures/fabrichat-metadata-upgrade/${
                  entry.name.replace(".tsx", "-before.tsx.txt")
                }`,
                import.meta.url,
              ),
              destination,
            );
          } else {await Deno.symlink(
              join(patterns, "system/fabrichat", entry.name),
              destination,
            );}
        }
        let route = new PatternsRoute(patterns, [{
          routePrefix: "system/",
          directory: join(vintage, "system"),
        }]);
        const service = await Identity.fromPassphrase(
          `served metadata service ${update}`,
        );
        const ownerIdentity = await Identity.fromPassphrase(
          `served metadata owner ${update}`,
        );
        const startServer = () => {
          const server = StandaloneMemoryServer.start({
            store: toFileUrl(`${temporary}/store/`),
            acl: { mode: "enforce", delegatingDids: [service.did()] },
            namesInstances: namesInstancesByDefault,
            serve: (request) => route.serve(request),
          });
          const release = claimPatternEnvironment(server.url);
          const host = new ExecutorHost({
            server: server.server,
            serviceIdentity: service.did(),
            ensureSpaceRoots: false,
            createRuntime: servingRuntimeFactory({
              server: server.server,
              identity: service,
              apiUrl: server.url,
            }),
          });
          return {
            server,
            host,
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
        let served = startServer();
        cleanup.defer(() => served.close());
        const programPath = join(
          patterns,
          "integration/fixtures/fabrichat-add-offer/main.tsx",
        );
        let harness = await MultiRuntimeHarness.create({
          apiUrl: served.server.url,
          programPath,
          rootPath: patterns,
          watchPaths: [],
          diagnostics: true,
          sourceSnapshots: ["room", "schemas"].map((name) => ({
            name: `/system/fabrichat/${name}.tsx`,
            filePath: fromFileUrl(
              new URL(
                `./fixtures/fabrichat-metadata-upgrade/${name}-before.tsx.txt`,
                import.meta.url,
              ),
            ),
          })),
          sessions: [{
            label: "old-owner",
            identity: ownerIdentity,
            cfc: { experimental: { serverExecution: true } },
          }],
        });
        cleanup.defer(() => harness.dispose());
        let owner = harness.sessions[0];
        await owner.send("createProfile", { name: "Ada" });
        await harness.settle();
        await owner.client().call("linkHomeRoot", {});
        await owner.send("createGroup", {
          requestId: "old",
          title: "Stored title",
          members: [],
        }, gesture("ChatStart"));
        await awaitAdmitted(served.server.server, async () => {
          await harness.settle();
          return await owner.read(["requests", "old", "status"]) === "done";
        });
        const room = await owner.link(["requests", "old", "entry", "room"]);
        expect(await owner.read(["metadata"], { piece: room })).toBeUndefined();
        const follow = record(
          await owner.client().call("repointPiece", {
            piece: room,
            url: source,
          }),
        );
        expect(follow.status).toBe("applied");
        await harness.settle();
        expect(await owner.read(["metadata"], { piece: room })).toBeUndefined();
        const beforeSource = record(
          await owner.client().call("pieceSource", { piece: room }),
        );
        expect(beforeSource.source).toBe(source);
        expect(beforeSource.pattern).toMatchObject({
          identity: await route.identity("system/fabrichat/room.tsx"),
        });
        for (const body of ["Original message", "Second message"]) {
          await owner.send("sendMessage", { body }, gesture("ChatSend"), {
            piece: room,
          });
          await harness.settle();
        }
        expect(await owner.read(["messages", "count"], { piece: room })).toBe(
          2,
        );
        const messages = await Promise.all([
          messageAt(owner, room, 0),
          messageAt(owner, room, 1),
        ]);
        const roster = await owner.readRaw(["roster"], { piece: room });
        const about = await owner.readRaw(["about"], { piece: room });
        const spaceDid = harness.spaceDid;
        const pieceId = harness.pieceId;
        await harness.dispose();
        await served.close();
        if (update) route = new PatternsRoute(patterns);
        served = startServer();
        harness = await MultiRuntimeHarness.create({
          apiUrl: served.server.url,
          programPath,
          rootPath: patterns,
          pieceId,
          spaceDid,
          watchPaths: [],
          diagnostics: true,
          sessions: [{
            label: "cold-reader",
            identity: ownerIdentity,
            unattached: true,
            cfc: { experimental: { serverExecution: true } },
          }],
        });
        const reader = harness.sessions[0];
        // This client holds a raw root query only. Its demand asks the serving
        // host to follow the origin and initialize the new summary.
        await reader.client().call("watchAddress", {
          link: {
            "/": {
              "link@1": {
                ...room,
                schema: {
                  type: "object",
                  properties: {
                    $NAME: { type: "string" },
                    metadata: {
                      type: "object",
                      properties: {
                        kind: { type: "string" },
                        title: { type: "string" },
                        room: {
                          type: "object",
                          properties: {
                            space: { type: "string" },
                            id: { type: "string" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        await harness.settle();
        await served.host.whenQuiescent();
        await harness.settle();
        const coldSource = record(
          await reader.client().call("pieceSource", {
            piece: room,
            start: false,
          }),
        );
        console.log("Cold serving source", {
          update,
          previous: beforeSource.pattern,
          current: coldSource.pattern,
          offered: await route.identity("system/fabrichat/room.tsx"),
          originFollows: served.host.stats().originFollows,
        });
        expect(coldSource.pattern).toMatchObject({
          identity: await route.identity("system/fabrichat/room.tsx"),
        });
        await awaitAdmitted(served.server.server, async () => {
          await harness.settle();
          const value = await reader.client().call("watchedAddress", {});
          if (!isPlainObject(value)) return false;
          return update
            ? isPlainObject(value.metadata) &&
              value.metadata.title === "Stored title"
            : value.$NAME === "Stored title";
        });
        const observed = record(
          await reader.client().call("watchedAddress", {}),
        );
        if (update) {
          expect(observed.metadata).toMatchObject({
            kind: "group",
            title: "Stored title",
          });
          const navigation = record(observed.metadata as FabricValue).room;
          expect(navigation).toMatchObject({ space: room.space });
          expect(
            idStringForEntityAddress(
              record(navigation as FabricValue).id as string,
            ),
          ).toBe(room.id);
        } else expect(observed.metadata).toBeUndefined();
        const servedSource = record(
          await reader.client().call("pieceSource", {
            piece: room,
            start: false,
          }),
        );
        expect(servedSource.pattern).toMatchObject({
          identity: await route.identity("system/fabrichat/room.tsx"),
        });
        await assertPassiveReader(reader);
        expect(served.host.stats().originFollows).toBeGreaterThan(0);
        expect(served.host.stats().derivedCommits).toBeGreaterThan(0);
        owner = await harness.addSession({
          label: "reopened-owner",
          identity: ownerIdentity,
          cfc: { experimental: { serverExecution: true } },
        });
        const afterSource = record(
          await owner.client().call("pieceSource", { piece: room }),
        );
        expect(afterSource.source).toBe(source);
        expect(afterSource.pattern).toMatchObject({
          identity: await route.identity("system/fabrichat/room.tsx"),
        });
        expect(await owner.link([], { piece: room })).toEqual(room);
        expect(await messageAt(owner, room, 0)).toEqual(messages[0]);
        expect(await messageAt(owner, room, 1)).toEqual(messages[1]);
        expect(await owner.readRaw(["roster"], { piece: room })).toEqual(
          roster,
        );
        expect(await owner.readRaw(["about"], { piece: room })).toEqual(about);
        const eventsBefore = served.host.stats().events.processed;
        const derivedBefore =
          served.host.stats().derivedCommitsBySpace[room.space] ?? 0;
        await owner.send(
          "editMessage",
          {
            message: { "/": { "link@1": messages[0].link } },
            body: "Edited original",
          },
          gesture("ChatEdit"),
          { piece: room },
        );
        await harness.settle();
        expect(
          await owner.read(["messages", "latest", "messages", 0, "body"], {
            piece: room,
          }),
        ).toBe("Edited original");
        await owner.send(
          "setTitle",
          { requestId: "new-title", title: "Updated title" },
          gesture("ChatRetitle"),
          { piece: room },
        );
        await harness.settle();
        await owner.send(
          "sendMessage",
          { body: "After restart" },
          gesture("ChatSend"),
          { piece: room },
        );
        await harness.settle();
        await awaitAdmitted(served.server.server, async () => {
          await harness.settle();
          const value = await reader.client().call("watchedAddress", {});
          if (!isPlainObject(value)) return false;
          return update
            ? isPlainObject(value.metadata) &&
              value.metadata.kind === "group" &&
              value.metadata.title === "Updated title"
            : value.$NAME === "Updated title";
        });
        expect(await owner.read(["messages", "count"], { piece: room })).toBe(
          3,
        );
        expect(served.host.stats().events.processed).toBeGreaterThanOrEqual(
          eventsBefore + 3,
        );
        expect(served.host.stats().derivedCommitsBySpace[room.space])
          .toBeGreaterThan(derivedBefore);
        // A second raw subscription proves the edit of the old authored record
        // reached storage; an owner's speculative value alone cannot prove it.
        await reader.client().call("watchAddress", {
          link: {
            "/": {
              "link@1": {
                ...messages[0].link,
                schema: {
                  type: "object",
                  properties: { body: { type: "string" } },
                },
              },
            },
          },
        });
        await awaitAdmitted(served.server.server, async () => {
          await harness.settle();
          const value = await reader.client().call("watchedAddress", {});
          return isPlainObject(value) && value.body === "Edited original";
        });
        expect((await reader.rawRead(messages[0].link)).value).toMatchObject({
          value: { body: "Edited original" },
        });
        await assertPassiveReader(reader);
        console.log("Served room upgrade", {
          update,
          eventsProcessed: served.host.stats().events.processed - eventsBefore,
          roomDerivedCommits:
            (served.host.stats().derivedCommitsBySpace[room.space] ?? 0) -
            derivedBefore,
          originFollows: served.host.stats().originFollows,
        });
      },
    );
  }
});
