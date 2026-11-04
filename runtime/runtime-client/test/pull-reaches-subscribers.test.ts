/**
 * What a `CellHandle.pull()` finds against what that handle's subscribers, and
 * those of another handle on the same cell, were last given. Each case drives
 * a real `RuntimeClient` over a `MessageChannel` to a real processor serving a
 * runtime over emulated storage, since what is at stake lies between the
 * worker, which sends an update holding nothing when a field goes, and the
 * connection, which drops that update and seeds a new handle from another.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { CellHandle } from "@/cell-handle.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const signer = await Identity.fromPassphrase("pull-reaches-subscribers", {
  implementation: "noble",
});
const space = signer.did();
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

type Reaction = { emoji: string };

const reactionsSchema = {
  type: "array",
  items: { type: "object", properties: { emoji: { type: "string" } } },
} as const;

const messageSchema = {
  type: "object",
  properties: { body: { type: "string" }, reactions: reactionsSchema },
} as const;

/**
 * A runtime holding a message whose `reactions` field links to a list in a
 * document of its own, and a client attached to it over a channel. `open()`
 * makes a fresh handle on that field, each under the same schema, as a page
 * opening a new view of the message does.
 */
async function messageWithReactions() {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
  });
  const cause = `pull-reaches-subscribers-${crypto.randomUUID()}`;
  const list = runtime.getCell<Reaction[]>(space, `${cause}-list`);
  const message = runtime.getCell<Record<string, unknown>>(
    space,
    `${cause}-message`,
  );
  const commit = async (
    edit: (tx: ReturnType<Runtime["edit"]>) => void,
  ) => {
    const tx = runtime.edit();
    edit(tx);
    const { error } = await tx.commit().settled;
    if (error) throw new Error(`The commit failed: ${error.name}`);
    await runtime.scheduler.idleWithPendingCommits();
  };
  await commit((tx) => {
    list.withTx(tx).set([]);
    message.withTx(tx).set({ body: "hi", reactions: list });
  });

  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime,
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
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  const client = await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: space },
  );

  const messageRef = createCellRef(message);
  const open = (): CellHandle<Reaction[]> =>
    client.getCellFromRef<{ reactions: Reaction[] }>(messageRef)
      .asSchema<{ reactions: Reaction[] }>(messageSchema)
      .key("reactions")
      .asSchema<Reaction[]>(reactionsSchema);

  return {
    list,
    message,
    commit,
    open,
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
    },
  };
}

/**
 * Subscribes to `handle`, keeping every value its callback is given, and every
 * refusal, as `{ refused }`. What it keeps is compared with `toStrictEqual()`,
 * since `toEqual()` passes a list missing a trailing `undefined`.
 */
function heard(handle: CellHandle<Reaction[]>): unknown[] {
  const heard: unknown[] = [];
  handle.subscribe((value) => {
    heard.push(value);
  }, { onRefused: (refused) => heard.push({ refused }) });
  return heard;
}

describe("pull-reaches-subscribers", () => {
  it("tells the subscribers of every handle on the field that a pull found it gone", async () => {
    await using fixture = await messageWithReactions();
    const live = fixture.open();
    const liveHeard = heard(live);
    expect(await live.pull()).toEqual([]);

    // The message is rewritten without the field, as deleting a chat message
    // does. The worker's update to `live` holds nothing, which the connection
    // drops.
    await fixture.commit((tx) => {
      fixture.message.withTx(tx).set({ body: "deleted" });
    });
    const later = fixture.open();
    const laterHeard = heard(later);

    expect(await later.pull()).toBeUndefined();

    // `later` was seeded from `live` with the list it still held, and the pull
    // tells both handles' subscribers what it found.
    expect(laterHeard).toStrictEqual([[], undefined]);
    expect(later.get()).toBeUndefined();
    expect(liveHeard).toStrictEqual([undefined, [], undefined]);
    expect(live.get()).toBeUndefined();
  });

  it("publishes nothing when a pull finds what each handle holds", async () => {
    await using fixture = await messageWithReactions();
    const live = fixture.open();
    const liveHeard = heard(live);
    expect(await live.pull()).toEqual([]);

    // The list changes while the field stays, which reaches `live` as an
    // update.
    const delivered = Promise.withResolvers<void>();
    live.subscribe((value) => {
      if (value?.length === 1) delivered.resolve();
    }, { onRefused: () => {} });
    await fixture.commit((tx) => {
      fixture.list.withTx(tx).set([{ emoji: "y" }]);
    });
    await delivered.promise;
    const later = fixture.open();
    const laterHeard = heard(later);

    expect(await later.pull()).toEqual([{ emoji: "y" }]);

    expect(laterHeard).toStrictEqual([[{ emoji: "y" }]]);
    expect(later.get()).toEqual([{ emoji: "y" }]);
    expect(liveHeard).toStrictEqual([undefined, [], [{ emoji: "y" }]]);
    expect(live.get()).toEqual([{ emoji: "y" }]);
  });
});
