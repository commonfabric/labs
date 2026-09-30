/**
 * A handler the serving loop runs cannot change a space's access list through
 * a cell, the only shape of write pattern code makes. Each case stands a piece
 * up on a client, warms the serving loop on it, and then replaces the piece's
 * handler on the serving runtime with a probe that performs the write.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { StreamEventsDocValue } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { awaitAdmitted } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("acl document write space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "acl document write service",
);
const aliceSigner = await Identity.fromPassphrase("acl document write alice");
const bobSigner = await Identity.fromPassphrase("acl document write bob");

const BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value }) => ({ value, bump: bump({ value }) }));",
].join("\n");

/** The ids of the stream sidecar documents `engine` holds. */
const sidecarIdsIn = (engine: Engine.Engine): string[] =>
  (engine.database.prepare(
    `SELECT id FROM head WHERE id LIKE 'of:stream-events:%' AND op != 'delete'`,
  ).all() as Array<{ id: string }>).map((row) => row.id);

/** The entries of the stream sidecar `sidecarId`. */
const entriesIn = (
  engine: Engine.Engine,
  sidecarId: string,
): NonNullable<StreamEventsDocValue["entries"]> =>
  (Engine.read(engine, { id: sidecarId })?.value as StreamEventsDocValue)
    .entries ?? [];

describe("executor-acl-document-write", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: EmulatedStorageManager | undefined;
  let clientRuntime: Runtime | undefined;
  let servingRuntime: Runtime | undefined;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    host = undefined;
    clientManager = undefined;
    clientRuntime = undefined;
    servingRuntime = undefined;
  });

  afterEach(async () => {
    await host?.close();
    await clientRuntime?.dispose();
    await clientManager?.close();
    await server.close();
  });

  /** A host whose serving runtimes act as the service identity. */
  const newHost = (): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
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

  /**
   * Stands the bump pattern up on alice's client, demands it, starts the
   * host, and fires one event to completion. A probe registered on the
   * returned stream afterward replaces the piece's own handler, so each later
   * entry runs exactly the probe.
   */
  const warmServedStream = async () => {
    clientManager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
      experimental: { serverExecution: true },
    });
    const runtime = clientRuntime;
    const engine = await server.engineForSpace(space);
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: BUMP_PATTERN }],
    }, { space });
    const argument = runtime.getCell<{ value: number }>(space, "acl-arg");
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      "acl-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const tx = runtime.edit();
      argument.withTx(tx).set({ value: 0 });
      expect((await tx.commit()).error).toBeUndefined();
    }
    {
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
    }
    const cancelDemand = result.sink(() => {});
    await runtime.idle();
    await runtime.storageManager.synced();
    host = newHost();
    result.key("bump").send({ kind: "warmup" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await awaitAdmitted(server, () => sidecarIdsIn(engine).length === 1);
    const sidecarId = sidecarIdsIn(engine)[0];
    await awaitAdmitted(
      server,
      () => entriesIn(engine, sidecarId)[0]?.consequenced === true,
    );
    const entry = entriesIn(engine, sidecarId)[0];
    const streamLink = {
      space,
      id: entry.stream.id as URI,
      path: [...entry.stream.path],
      scope: entry.stream.scope ?? "space",
    };
    return { engine, result, cancelDemand, sidecarId, streamLink };
  };

  it("refuses a served handler's cell write to the space's access list, which keeps its value", async () => {
    const { engine, result, cancelDemand, sidecarId, streamLink } =
      await warmServedStream();
    const aclId = `of:${space}`;
    const acl = { [aliceSigner.did()]: "OWNER" };
    Engine.applyCommit(engine, {
      sessionId: "acl-document-write-genesis",
      space,
      principal: space,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: aclId, value: { value: acl } }],
      },
    });
    expect(Engine.read(engine, { id: aclId })?.value).toEqual(acl);

    const serving = servingRuntime!;
    const cancelProbe = serving.scheduler.addEventHandler(
      (tx) => {
        serving.getCellFromLink({ space, id: aclId as URI, path: [] })
          .withTx(tx).set({ [bobSigner.did()]: "OWNER" });
      },
      streamLink,
    );
    try {
      result.key("bump").send({ kind: "probe" });
      await clientRuntime!.idle();
      await clientRuntime!.storageManager.synced();
      const probe = () =>
        entriesIn(engine, sidecarId).find((entry) =>
          (entry.payload as { kind?: string } | undefined)?.kind === "probe"
        );
      await awaitAdmitted(server, () => probe()?.consequenced === true);

      expect(probe()!.error).toContain("is the space ACL document");
      expect(Engine.read(engine, { id: aclId })?.value).toEqual(acl);
    } finally {
      cancelProbe();
      cancelDemand();
    }
  });
});
