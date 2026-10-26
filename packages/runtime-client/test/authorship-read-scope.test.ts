/**
 * What an authorship observation depends on in the worker: the author cell's
 * claim fields and its label, and nothing else the author's document holds or
 * links. Each case drives a real `RuntimeClient` over a `MessageChannel` to a
 * real processor serving a runtime over emulated storage, so the handles are
 * the ones a host binds, and the subscriptions the worker's own.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { type Cell, KeepAsCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type AuthorshipObservation, observeAuthorship } from "@/authorship.ts";
import type { RuntimeProcessor } from "@/backends/mod.ts";
import { RuntimeClients } from "@/backends/client-registry.ts";
import { createCellRef } from "@/backends/utils.ts";
import { MessagePortRuntimeTransport } from "@/client/transports/message-port/transport-message-port.ts";
import { RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";
import { buildProcessor } from "./backends/build-processor.ts";

const signer = await Identity.fromPassphrase("authorship-read-scope", {
  implementation: "noble",
});
const home = signer.did();
const profileSpace =
  (await Identity.fromPassphrase("authorship-read-scope profile", {
    implementation: "noble",
  })).did();
const room = (await Identity.fromPassphrase("authorship-read-scope room", {
  implementation: "noble",
})).did();
// What `buildProcessor()` runs the processor under, which the client asserts.
const apiUrl = "http://localhost/";

/** The part of a profile a room reads, as `fabrichat/schemas.tsx` types it. */
const chatProfileSchema = {
  type: "object",
  properties: { name: { type: "string" }, avatar: { type: "string" } },
} as const;

/**
 * A runtime holding, in three spaces, what a message's author link reaches:
 * the message, the author's profile, the profile's inbox in the author's
 * home, and the catalog that inbox links. A client is attached over a
 * channel.
 */
async function messageByAProfile() {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(apiUrl),
    storageManager: storage,
  });
  const write = async (
    space: string,
    id: string,
    value: unknown,
    schema?: unknown,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space as never, id, schema as never);
    cell.withTx(tx).setRawUntyped(value as never);
    const { error } = await tx.commit().settled;
    if (error) throw new Error(`The commit failed: ${error.name}`);
    await runtime.scheduler.idleWithPendingCommits();
    return runtime.getCell(space as never, id, schema as never);
  };
  const catalog = await write(home, "catalog", { entries: {} });
  const inbox = await write(home, "inbox", {
    name: "inbox",
    catalog: catalog.getAsLink(),
    offers: [],
  });
  const profile = await write(profileSpace, "profile", {
    name: "an author",
    avatar: "a",
    inbox: {
      piece: inbox.getAsLink({
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      }),
    },
  }, chatProfileSchema);
  const message = await write(room, "message", {
    authorProfile: profile.getAsLink({
      includeSchema: true,
      keepAsCell: KeepAsCell.All,
    }),
    body: "hello",
    sentAt: 1,
  });

  const clients = new RuntimeClients({
    setConsoleBridge: () => {},
    owner: { id: 0, post: () => true },
    initializeRuntime: () =>
      Promise.resolve(
        buildProcessor({
          runtime,
          identity: signer,
          space: home,
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
          data: { apiUrl, identity: { placeholder: true }, spaceDid: home },
        },
      } as never),
    }),
  );
  const channel = new MessageChannel();
  clients.attach(channel.port2);
  const client = await RuntimeClient.attach(
    new MessagePortRuntimeTransport({ port: channel.port1 }),
    { apiUrl: new URL(apiUrl), identity: signer.did(), spaceDid: home },
  );

  const idOf = (cell: Cell<unknown>) => cell.getAsNormalizedFullLink().id;
  return {
    runtime,
    write,
    /** The handles a host binds: the message's `body` and `authorProfile`. */
    handles: () => {
      const handle = client.getCellFromRef<
        { body: string; authorProfile: unknown }
      >(createCellRef(message));
      return { value: handle.key("body"), author: handle.key("authorProfile") };
    },
    ids: {
      message: idOf(message),
      profile: idOf(profile),
      inbox: idOf(inbox),
      catalog: idOf(catalog),
    },
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
    },
  };
}

describe("observeAuthorship() in the worker", () => {
  it("depends on the author's claim fields and label, not on what the author's document links", async () => {
    await using fixture = await messageByAProfile();
    const { runtime, ids } = fixture;
    const reports: AuthorshipObservation[] = [];
    // Resolved as reports arrive: `reported(n)` settles once the observation
    // has reported `n` times, at once when it already has.
    const watchers: (() => void)[] = [];
    const reported = (count: number): Promise<void> =>
      new Promise((resolve) => {
        const check = () => {
          if (reports.length >= count) resolve();
        };
        check();
        watchers.push(check);
      });
    const { value, author } = fixture.handles();
    const cancel = observeAuthorship(value, author, (observation) => {
      reports.push(observation);
      for (const watcher of watchers) watcher();
    });
    try {
      await reported(1);
      await runtime.scheduler.idleWithPendingCommits();

      // The worker's subscriptions that read the author's profile: the one
      // on the message's `authorProfile`, and any the observation opened on
      // the profile itself. None reaches past the profile's claim fields.
      const authorSinks = runtime.scheduler.getGraphSnapshot().nodes.filter((
        node,
      ) =>
        node.id.startsWith("sink:") &&
        [...(node.reads ?? []), ...(node.shallowReads ?? [])].some((read) =>
          read.includes(ids.profile)
        )
      );
      expect(authorSinks.length).toBeGreaterThan(0);
      for (const sink of authorSinks) {
        const addresses = [...(sink.reads ?? []), ...(sink.shallowReads ?? [])];
        expect(addresses.some((read) => read.includes(ids.inbox))).toBe(false);
        expect(addresses.some((read) => read.includes(ids.catalog))).toBe(
          false,
        );
        // The profile's own document is read at its claim fields, never
        // whole: a whole read is a recursive one of its `value`.
        expect(
          (sink.reads ?? []).some((read) =>
            read.includes(ids.profile) && /\/value$/.test(read)
          ),
        ).toBe(false);
      }
      expect(reports.at(-1)?.authorClaim).toEqual({ name: "an author" });

      // What the profile links changes: no subscription on the message is
      // woken. The trace is the check; a report could not show a re-run that
      // delivered the same value again, since the gate drops those.
      const before = reports.length;
      runtime.scheduler.setTriggerTraceEnabled(true);
      await fixture.write(home, "catalog", {
        entries: { added: runtime.getCell(home, "inbox").getAsLink() },
      });
      await fixture.write(home, "inbox", {
        name: "inbox",
        catalog: runtime.getCell(home, "catalog").getAsLink(),
        offers: [{ from: "someone" }],
      });
      await runtime.scheduler.idleWithPendingCommits();
      const woken = runtime.scheduler.getTriggerTrace().flatMap((entry) =>
        entry.triggered.filter((record) =>
          record.actionId.startsWith("sink:") &&
          record.actionId.includes(ids.message)
        )
      );
      expect(woken).toEqual([]);

      // The claim itself changes: the observation reports it. Its report
      // travels the channel the writes above would have reported on, in
      // order, so once it is here nothing of theirs is still to come.
      await fixture.write(profileSpace, "profile", {
        name: "a renamed author",
        avatar: "a",
        inbox: {
          piece: runtime.getCell(home, "inbox").getAsLink({
            includeSchema: true,
            keepAsCell: KeepAsCell.All,
          }),
        },
      }, chatProfileSchema);
      await reported(before + 1);
      expect(reports.length).toBe(before + 1);
      expect(reports.at(-1)?.authorClaim).toEqual({ name: "a renamed author" });
    } finally {
      cancel();
    }
  });
});
