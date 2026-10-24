/**
 * What `observeAuthorship()` reports for a message whose author link has gone,
 * as FabriChat's obliteration leaves one, read by a real `RuntimeClient` over
 * a `MessageChannel` from a real processor serving a runtime over emulated
 * storage. What is at stake lies between the worker, which sends an update
 * holding nothing when the field goes, and the connection, which drops that
 * update and seeds a new handle on the field from one that heard the link.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { KeepAsCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { type CfcAuthorshipState, observeAuthorship } from "@/authorship.ts";
import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { CellHandle } from "@/cell-handle.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const signer = await Identity.fromPassphrase("authorship-absent-author", {
  implementation: "noble",
});
const space = signer.did();
const ada = (await Identity.fromPassphrase("authorship-absent-author ada", {
  implementation: "noble",
})).did();
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

/**
 * A runtime holding Ada's profile, whose label says it represents her, and a
 * message whose `body` she wrote and whose `authorProfile` links to that
 * profile, with a client attached to it over a channel. `open()` makes a
 * fresh handle on one of the message's fields, as a page opening a new view
 * of the message does, `obliterate()` rewrites the message without its
 * author, its body still Ada's, and `restore()` puts the author back.
 */
async function messageByAda() {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
  });
  const cause = `authorship-absent-author-${crypto.randomUUID()}`;
  const profile = runtime.getCell<{ name: string }>(space, `${cause}-profile`);
  const message = runtime.getCell<Record<string, unknown>>(
    space,
    `${cause}-message`,
  );
  /** Stores `value` in `cell`'s document with one root integrity atom. */
  const seed = (
    tx: ReturnType<Runtime["edit"]>,
    cell: typeof profile | typeof message,
    value: unknown,
    path: string[],
    atom: { kind: string; subject: string },
  ) =>
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path, label: { integrity: [atom] } }],
        },
      },
    } as FabricValue);
  const authoredByAda = { kind: "authored-by", subject: ada };
  const authorProfile = profile.getAsLink({
    includeSchema: true,
    keepAsCell: KeepAsCell.All,
  });
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
    writeSeedEnvelopeDoc(tx, space);
    seed(tx, profile, { name: "Ada" }, [], {
      kind: "represents-principal",
      subject: ada,
    });
    seed(
      tx,
      message,
      {
        body: "hello",
        authorProfile,
      },
      ["body"],
      authoredByAda,
    );
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
  const open = (field: "body" | "authorProfile"): CellHandle<unknown> =>
    client.getCellFromRef<Record<string, unknown>>(messageRef).key(field);

  return {
    open,
    idle: () => client.idle(),
    obliterate: () =>
      commit((tx) => {
        seed(tx, message, { body: { deleted: true } }, ["body"], authoredByAda);
      }),
    restore: () =>
      commit((tx) => {
        seed(
          tx,
          message,
          { body: { deleted: true }, authorProfile },
          ["body"],
          authoredByAda,
        );
      }),
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
    },
  };
}

/**
 * Observes a fresh view of the message's authorship, as a page opening one
 * does: `first` is the first verdict it reports, and `next(state)` resolves
 * when it next reports `state`.
 */
function observeView(fixture: Awaited<ReturnType<typeof messageByAda>>) {
  const first = Promise.withResolvers<CfcAuthorshipState>();
  const waiting: Array<{ state: CfcAuthorshipState; resolve: () => void }> = [];
  const cancel = observeAuthorship(
    fixture.open("body"),
    fixture.open("authorProfile"),
    (observation) => {
      first.resolve(observation.state);
      for (const waiter of waiting.splice(0)) {
        if (waiter.state === observation.state) waiter.resolve();
        else waiting.push(waiter);
      }
    },
  );
  const next = (state: CfcAuthorshipState) =>
    new Promise<void>((resolve) => waiting.push({ state, resolve }));
  return { first: first.promise, next, cancel };
}

describe("authorship-absent-author", () => {
  it("reports `unknown` for a message whose author link has gone, opened after a view that saw the link", async () => {
    await using fixture = await messageByAda();
    const live = observeView(fixture);
    expect(await live.first).toBe("verified");

    await fixture.obliterate();
    // The worker's update to the live view's `authorProfile` holds nothing,
    // which the connection drops. The answer to a request made now comes
    // back after it, so it has reached the live view's handles, which the
    // next view's handles are seeded from.
    await fixture.idle();
    const later = observeView(fixture);

    expect(await later.first).toBe("unknown");
    later.cancel();
    live.cancel();
  });

  it("reports `verified` again on a view open while the author link goes and comes back", async () => {
    // The worker's update restoring the link carries the value and label the
    // view's handle held before the link went, so only their currency has
    // changed.
    await using fixture = await messageByAda();
    const live = observeView(fixture);
    expect(await live.first).toBe("verified");
    const gone = live.next("unknown");
    await fixture.obliterate();
    await gone;

    const back = live.next("verified");
    await fixture.restore();
    await back;
    const later = observeView(fixture);

    expect(await later.first).toBe("verified");
    later.cancel();
    live.cancel();
  });
});
