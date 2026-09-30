/**
 * No handler the serving loop runs changes a space's access list, whichever
 * shape of write it makes and whatever the memory server's ACL mode. Each
 * case stands a piece up on a client, warms the serving loop on it, and then
 * replaces the piece's handler on the serving runtime with a probe that
 * performs the write. The serving runtime acts as a delegating service
 * identity over the loopback plane, as it does in production.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { StreamEventsDocValue } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";

import { ExecutorHost } from "../src/executor/host.ts";
import { LoopbackStorageManager } from "../src/executor/loopback-storage.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { awaitAdmitted } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("acl document write space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "acl document write service",
);
const aliceSigner = await Identity.fromPassphrase("acl document write alice");
const bobSigner = await Identity.fromPassphrase("acl document write bob");
const aclId = `of:${space}`;

/** The list the space starts with: alice owns it, and bob may write. */
const genesisAcl = {
  [aliceSigner.did()]: "OWNER",
  [bobSigner.did()]: "WRITE",
};

const PIECE_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const Room = pattern<{ value: number }, { value: number }>(",
  "  ({ value }) => ({ value }),",
  ");",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "const open = handler<unknown, { rooms: Writable<unknown[]> }>(",
  "  (_ev, { rooms }) => {",
  "    rooms.push(Room.inSpace('acl-document-write-room')({ value: 7 }));",
  "  },",
  ");",
  "export default pattern<",
  "  { value: Writable<number>; rooms: Writable<unknown[]> },",
  "  { value: number; rooms: unknown[]; bump: Stream<unknown>;",
  "    open: Stream<unknown> }",
  ">(({ value, rooms }) => ({",
  "  value, rooms, bump: bump({ value }), open: open({ rooms }),",
  "}));",
].join("\n");

/** The ids of the stream sidecar documents `engine` holds. */
const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

/** Every entry of every stream sidecar `engine` holds. */
const allEntriesIn = (
  engine: Engine.Engine,
): NonNullable<StreamEventsDocValue["entries"]> =>
  sidecarIdsIn(engine).flatMap((sidecarId) =>
    (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
      .entries ?? []
  );

/** The entry whose payload has `kind`, in any stream sidecar of `engine`. */
const entryOfKind = (engine: Engine.Engine, kind: string) =>
  allEntriesIn(engine).find((entry) =>
    (entry.payload as { kind?: string } | undefined)?.kind === kind
  );

describe("executor-acl-document-write", () => {
  for (const mode of ["off", "enforce"] as const) {
    describe(`under memory ACL mode \`${mode}\``, () => {
      let storeSeq = 0;
      let server: MemoryV2Server.Server;
      let cleanups: Array<() => Promise<void>>;
      let servingRuntime: Runtime | undefined;

      beforeEach(async () => {
        storeSeq += 1;
        server = new MemoryV2Server.Server({
          store: new URL(`memory://acl-document-write-${mode}-${storeSeq}`),
          subscriptionRefreshDelayMs: 0,
          authorizeSessionOpen: authorizeLoopbackSessionOpen,
          sessionOpenAuth: { audience: "did:key:z6Mk-runner-emulated-memory" },
          acl: { mode, delegatingDids: [serviceSigner.did()] },
        });
        cleanups = [];
        servingRuntime = undefined;
        Engine.applyCommit(await server.engineForSpace(space), {
          sessionId: "acl-document-write-genesis",
          space,
          principal: space,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id: aclId,
              value: { value: genesisAcl },
            }],
          },
        });
      });

      afterEach(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        await server.close();
      });

      /** A client runtime acting as `signer`, with server execution on. */
      const newClient = (signer: Identity): Runtime => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: true },
        });
        cleanups.push(async () => {
          await runtime.dispose();
          await manager.close();
        });
        return runtime;
      };

      /**
       * Stands the piece up on alice's client, demands it, starts the host,
       * and fires one event to completion. A probe registered on the
       * returned stream afterward replaces the piece's own `bump` handler, so
       * each later entry on it runs exactly the probe. `fire()` sends an
       * event of `kind` on `stream` from alice's client, or from bob's, and
       * resolves with its entry once it is consequenced.
       */
      const warmServedStream = async () => {
        const client = newClient(aliceSigner);
        const engine = await server.engineForSpace(space);
        const compiled = await client.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: PIECE_PATTERN }],
        }, { space });
        const argument = client.getCell<{ value: number; rooms: unknown[] }>(
          space,
          "acl-arg",
        );
        const result = client.getCell<Record<string, unknown>>(
          space,
          "acl-result",
          compiled.resultSchema,
        );
        await argument.sync();
        await result.sync();
        {
          const tx = client.edit();
          argument.withTx(tx).set({ value: 0, rooms: [] });
          expect((await tx.commit()).error).toBeUndefined();
        }
        {
          const tx = client.edit();
          client.run(tx, compiled, argument, result);
          expect((await tx.commit()).error).toBeUndefined();
        }
        const cancelDemand = result.sink(() => {});
        cleanups.push(() => Promise.resolve(cancelDemand()));
        await client.idle();
        await client.storageManager.synced();
        const host = new ExecutorHost({
          server,
          serviceIdentity: serviceSigner.did(),
          ensureSpaceRoots: false,
          // deno-lint-ignore require-await
          createRuntime: async (servedSpace) => {
            const manager = LoopbackStorageManager.connect(server, {
              as: serviceSigner,
              servingHomeSpace: servedSpace,
            });
            const runtime = new Runtime({
              apiUrl: new URL(import.meta.url),
              storageManager: manager,
              servingPosture: true,
              experimental: { serverExecution: true },
            });
            servingRuntime = runtime;
            return {
              runtime,
              dispose: async () => {
                await runtime.dispose();
                await manager.close();
              },
            };
          },
          policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
        });
        cleanups.push(() => host.close());
        const warmup = await sendAndSettle(client, result, "bump", "warmup");
        const streamLink = {
          space,
          id: warmup.stream.id as URI,
          path: [...warmup.stream.path],
          scope: warmup.stream.scope ?? "space",
        };
        let bobClient: Runtime | undefined;
        const fire = async (kind: string, as: "alice" | "bob" = "alice") => {
          if (as === "alice") {
            return await sendAndSettle(client, result, "bump", kind);
          }
          bobClient ??= newClient(bobSigner);
          const bobResult = bobClient.getCell<Record<string, unknown>>(
            space,
            "acl-result",
            compiled.resultSchema,
          );
          await bobResult.sync();
          return await sendAndSettle(bobClient, bobResult, "bump", kind);
        };
        return { client, engine, argument, result, streamLink, fire };
      };

      /**
       * Sends an event of `kind` on the stream `key` of `result` from
       * `client`, and resolves with its entry once it is consequenced.
       */
      const sendAndSettle = async (
        client: Runtime,
        result: ReturnType<Runtime["getCell"]>,
        key: string,
        kind: string,
      ) => {
        const engine = await server.engineForSpace(space);
        result.key(key).send({ kind });
        await client.idle();
        await client.storageManager.synced();
        await awaitAdmitted(
          server,
          () => entryOfKind(engine, kind)?.consequenced === true,
        );
        return entryOfKind(engine, kind)!;
      };

      it("refuses a served handler's cell write to the space's access list, which keeps its value", async () => {
        const { engine, streamLink, fire } = await warmServedStream();
        const serving = servingRuntime!;
        const cancelProbe = serving.scheduler.addEventHandler(
          (tx) => {
            serving.getCellFromLink({ space, id: aclId as URI, path: [] })
              .withTx(tx).set({ [bobSigner.did()]: "OWNER" });
          },
          streamLink,
        );
        try {
          const entry = await fire("probe");

          expect(entry.error).toContain("is the space ACL document");
          expect(Engine.read(engine, { id: aclId })?.value).toEqual(
            genesisAcl,
          );
        } finally {
          cancelProbe();
        }
      });

      it("refuses a whole-document write naming a WRITE member its OWNER, fired by that member, and fails that run's entry", async () => {
        const { engine, streamLink, fire } = await warmServedStream();
        const serving = servingRuntime!;
        let actor: string | undefined;
        const cancelProbe = serving.scheduler.addEventHandler(
          (tx) => {
            actor = serving.actingPrincipalFor(tx);
            tx.writeOrThrow(
              { space, id: aclId as URI, type: "application/json", path: [] },
              { value: { [bobSigner.did()]: "OWNER" } },
            );
          },
          streamLink,
        );
        try {
          const entry = await fire("takeover", "bob");

          expect(actor).toBe(bobSigner.did());
          expect(entry.error).toContain(
            `${aclId} is the space ACL document, and no run on the served ` +
              "plane may write it",
          );
          expect(Engine.read(engine, { id: aclId })?.value).toEqual(
            genesisAcl,
          );
        } finally {
          cancelProbe();
        }
      });

      it("refuses a run's data write along with its whole-document write to the access list", async () => {
        const { engine, argument, streamLink, fire } = await warmServedStream();
        const serving = servingRuntime!;
        const argumentLink = argument.getAsNormalizedFullLink();
        const valueBefore = Engine.read(engine, { id: argumentLink.id })?.value;
        expect(valueBefore).toEqual({ value: 1, rooms: [] });
        const cancelProbe = serving.scheduler.addEventHandler(
          (tx) => {
            tx.writeOrThrow(
              { space, id: aclId as URI, type: "application/json", path: [] },
              { value: { [aliceSigner.did()]: "OWNER" } },
            );
            serving.getCellFromLink(argumentLink).withTx(tx).key("value")
              .set(42);
          },
          streamLink,
        );
        try {
          const entry = await fire("mixed");

          expect(entry.error).toContain("is the space ACL document");
          expect(Engine.read(engine, { id: aclId })?.value).toEqual(
            genesisAcl,
          );
          expect(Engine.read(engine, { id: argumentLink.id })?.value)
            .toEqual(valueBefore);
        } finally {
          cancelProbe();
        }
      });

      it("commits the stream's next event's data write after refusing a write to the access list", async () => {
        const { engine, argument, streamLink, fire } = await warmServedStream();
        const serving = servingRuntime!;
        const argumentLink = argument.getAsNormalizedFullLink();
        const cancelRefused = serving.scheduler.addEventHandler(
          (tx) => {
            tx.writeOrThrow(
              { space, id: aclId as URI, type: "application/json", path: [] },
              { value: { [aliceSigner.did()]: "OWNER" } },
            );
          },
          streamLink,
        );
        const refused = await fire("refused");
        cancelRefused();
        const cancelServed = serving.scheduler.addEventHandler(
          (tx) => {
            serving.getCellFromLink(argumentLink).withTx(tx).key("value")
              .set(42);
          },
          streamLink,
        );
        try {
          const served = await fire("served");

          expect(refused.error).toContain("is the space ACL document");
          expect(served.error).toBeUndefined();
          expect(Engine.read(engine, { id: argumentLink.id })?.value).toEqual({
            value: 42,
            rooms: [],
          });
        } finally {
          cancelServed();
        }
      });

      it("creates a served `inSpace` target whose access list names the acting user its only OWNER", async () => {
        const { client, engine, result } = await warmServedStream();
        const entry = await sendAndSettle(client, result, "open", "open");

        expect(entry.error).toBeUndefined();
        const rooms = result.key("rooms");
        await rooms.sync();
        const room = rooms.key(0).resolveAsCell();
        const roomSpace = room.getAsNormalizedFullLink().space;
        expect(roomSpace).not.toBe(space);
        const roomEngine = await server.engineForSpace(roomSpace);
        expect(
          Engine.selectDocHead(roomEngine, {
            id: `of:${roomSpace}`,
            scopeKey: "space",
          }),
        ).toBe(1);
        expect(Engine.read(roomEngine, { id: `of:${roomSpace}` })?.value)
          .toEqual({ [aliceSigner.did()]: "OWNER" });
        // The served run, acting for alice, wrote the room's data into it.
        const provisioning = roomEngine.database.prepare(
          `SELECT COUNT(*) AS n FROM "commit" ` +
            `WHERE class = 'authored' AND acting_principal = ?`,
        ).get(aliceSigner.did()) as { n: number };
        expect(provisioning.n).toBeGreaterThan(0);
        expect(Engine.read(engine, { id: aclId })?.value).toEqual(genesisAcl);
      });
    });
  }
});
