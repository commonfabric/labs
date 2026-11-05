/**
 * What a client's cell unsubscribe lets the worker's runtime release. Each case
 * drives real `RuntimeClient`s over `MessageChannel`s to a real processor
 * serving a runtime over emulated storage, with a second runtime writing the
 * documents the clients read, so that nothing in the serving runtime reads
 * them but the subscriptions under test. A client subscribes to a holder whose
 * value links to a counter in another space, as a list of rooms links to each
 * room, and the subscription reads the counter through that link. The counter
 * is loaded under a watch of its own, which nothing but the subscription keeps:
 * the worker's own cell for the subscription holds the holder alone
 * (`docs/features/document-release.md`).
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { CellHandle } from "@/cell-handle.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const signer = await Identity.fromPassphrase("cell-unsubscribe-release", {
  implementation: "noble",
});
const space = signer.did();
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

type Counter = { n: number };

type Holder = { counter: Counter };

const counterSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const;

const holderSchema = {
  type: "object",
  properties: { counter: counterSchema },
} as const;

/**
 * A served runtime with nothing loaded, a writer runtime sharing its memory
 * server that has stored a holder linking to a counter in a space of its own,
 * and `attach()` to connect another client to the served runtime. `passes`
 * holds each release the served runtime was asked for, as the promise that
 * call returned.
 */
async function servedCounter() {
  const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
  const writerStorage = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const readerStorage = EmulatedStorageManager.connectTo(server, {
    as: signer,
  });
  const writer = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: writerStorage,
  });
  const reader = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: readerStorage,
  });
  const passes: Promise<void>[] = [];
  const release = reader.releaseUnreadDocuments.bind(reader);
  reader.releaseUnreadDocuments = () => {
    const pass = release();
    passes.push(pass);
    return pass;
  };

  const cause = `cell-unsubscribe-release-${crypto.randomUUID()}`;
  const counterSpace = await writerStorage.createSpace({
    [signer.did()]: "OWNER",
  });
  const counter = writer.getCell<Counter>(
    counterSpace,
    `${cause}-counter`,
    counterSchema,
  );
  const holder = writer.getCell<Record<string, unknown>>(
    space,
    `${cause}-holder`,
  );
  const commit = async (edit: (tx: ReturnType<Runtime["edit"]>) => void) => {
    const tx = writer.edit();
    edit(tx);
    const { error } = await tx.commit().settled;
    if (error) throw new Error(`The commit failed: ${error.name}`);
    await writerStorage.synced();
    await server.flushSessions();
  };
  // A transaction writes to one space.
  await commit((tx) => counter.withTx(tx).set({ n: 1 }));
  await commit((tx) => holder.withTx(tx).set({ counter }));
  const write = (n: number) => commit((tx) => counter.withTx(tx).set({ n }));
  const counterId = counter.getAsNormalizedFullLink().id as URI;
  const holderRef = createCellRef(holder);

  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime: reader,
          identity: signer,
          space,
        }) as unknown as RuntimeProcessor,
      ),
  });
  await clients.handleMessage(
    clients.owner,
    new MessageEvent("message", {
      data: realmFromFabricValue({
        msgId: 1,
        data: {
          type: RequestType.Initialize,
          data: { apiUrl, identity: { placeholder: true }, spaceDid: space },
        },
      } as never),
    }),
  );
  const attached: RuntimeClient[] = [];
  const attach = async () => {
    const channel = new MessageChannel();
    clients.attach(channel.port2);
    const client = await RuntimeClient.attach(
      new MessagePortRuntimeTransport({ port: channel.port1 }),
      { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: space },
    );
    attached.push(client);
    return client;
  };

  /** A handle on the holder, as `client` opens it. */
  const open = (client: RuntimeClient): CellHandle<Holder> =>
    client.getCellFromRef<Holder>(holderRef).asSchema<Holder>(holderSchema);

  /** Whether the served runtime's replica holds the counter. */
  const loaded = () =>
    readerStorage.open(counterSpace).replica.hasLocalDocumentCoverage?.(
      counterId,
    ) === true;

  return {
    attach,
    open,
    loaded,
    passes,
    write,
    [Symbol.asyncDispose]: async () => {
      for (const client of attached) await client.dispose();
      await reader.dispose();
      await writer.dispose();
      await readerStorage.close();
      await writerStorage.close();
      await server.close();
    },
  };
}

/**
 * Subscribes to `handle` and resolves once its subscriber has been given a
 * value `holds` accepts. Returns that promise and the subscription's cancel.
 */
function heardWhen(
  handle: CellHandle<Holder>,
  holds: (value: Holder | undefined) => boolean,
): { heard: Promise<void>; cancel: () => void } {
  const heard = Promise.withResolvers<void>();
  const cancel = handle.subscribe((value) => {
    if (holds(value)) heard.resolve();
  }, { onRefused: (refused) => heard.reject(refused) });
  return { heard: heard.promise, cancel };
}

describe("cell-unsubscribe-release", () => {
  it("releases a linked document only the cancelled subscription read", async () => {
    await using fixture = await servedCounter();
    const client = await fixture.attach();
    const { heard, cancel } = heardWhen(
      fixture.open(client),
      (value) => value?.counter?.n === 1,
    );
    await heard;
    expect(fixture.loaded()).toBe(true);
    expect(fixture.passes).toEqual([]);

    cancel();
    // The worker answers requests in the order they arrive, so the
    // unsubscribe has been handled once this one is.
    await client.idle();

    expect(fixture.passes.length).toBe(1);
    await fixture.passes[0];
    expect(fixture.loaded()).toBe(false);
  });

  it("keeps a linked document another client's subscription still reads, and goes on updating it", async () => {
    await using fixture = await servedCounter();
    const leaving = await fixture.attach();
    const staying = await fixture.attach();
    const left = heardWhen(
      fixture.open(leaving),
      (value) => value?.counter?.n === 1,
    );
    const stays = heardWhen(
      fixture.open(staying),
      (value) => value?.counter?.n === 1,
    );
    await Promise.all([left.heard, stays.heard]);

    left.cancel();
    await leaving.idle();
    expect(fixture.passes.length).toBe(1);
    await fixture.passes[0];

    expect(fixture.loaded()).toBe(true);
    const updated = heardWhen(
      fixture.open(staying),
      (value) => value?.counter?.n === 2,
    );
    await fixture.write(2);
    await updated.heard;
    updated.cancel();
    stays.cancel();
  });
});
