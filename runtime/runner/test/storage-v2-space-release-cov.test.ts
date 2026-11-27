/**
 * What keeps a space open through a release pass, and what a pass that
 * releases one does around it: the commits spanning several spaces it waits
 * for, the fork branch it keeps for the close, the pending loads that keep a
 * space, the crossings it forgets, a session close that fails, and an
 * observer of `subscribeSpacesReleased()` that throws.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { captureLogs } from "./support/captured-logs.ts";

const signer = await Identity.fromPassphrase("storage-v2 space release cov");
const home: MemorySpace = signer.did();

const counterSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const satisfies JSONSchema;

describe("storage/v2 space release", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: EmulatedStorageManager;
  let readerStorage: EmulatedStorageManager;
  let writer: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    writerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    readerStorage = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
  });

  afterEach(async () => {
    await writer.dispose();
    await writerStorage.close();
    await readerStorage.close();
    await server.close();
  });

  /** A new space holding the counter `{ n }`, and the counter's id. */
  const spaceWith = async (
    n: number,
  ): Promise<{ space: MemorySpace; id: URI }> => {
    const space = await writer.createSpace();
    const tx = writer.edit();
    const counter = writer.getCell(space, "counter", counterSchema, tx);
    counter.set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    await writerStorage.synced();
    await server.flushSessions();
    return { space, id: counter.getAsNormalizedFullLink().id as URI };
  };

  /** Loads the counter `id` of `space` into `storage` with no cell to hold it. */
  const load = async (
    space: MemorySpace,
    id: URI,
    storage: EmulatedStorageManager = readerStorage,
  ) => {
    expect(
      (await storage.open(space).sync(id, { path: [], schema: false })).error,
    ).toBeUndefined();
  };

  /** Runs two release passes, so a document loaded before the first goes. */
  const releaseTwice = async (
    storage: EmulatedStorageManager = readerStorage,
  ) => {
    await storage.releaseUnreadDocuments();
    await storage.releaseUnreadDocuments();
  };

  const isOpen = (
    space: MemorySpace,
    storage: EmulatedStorageManager = readerStorage,
  ) => storage.openedSpaces().includes(space);

  it("releases no space while a commit spanning several spaces is applying, and releases it once that commit has applied", async () => {
    const { space, id } = await spaceWith(1);
    await load(space, id);
    const applying = Promise.withResolvers<void>();
    readerStorage.trackMultiSpaceCommitApplying(applying.promise);

    await releaseTwice();

    expect(isOpen(space)).toBe(true);
    applying.resolve();
    await readerStorage.multiSpaceCommitsApplied();
    await releaseTwice();
    expect(isOpen(space)).toBe(false);
  });

  it("keeps a space a load is pending in, and releases it once the load settles", async () => {
    const { space, id } = await spaceWith(1);
    await load(space, id);
    const settle = readerStorage.accessForTestingOnly.registerPendingLoad({
      space,
      scope: "space",
      id: "of:storage-v2-space-release-pending" as URI,
    });

    await releaseTwice();

    expect(isOpen(space)).toBe(true);
    settle();
    await releaseTwice();
    expect(isOpen(space)).toBe(false);
  });

  it("keeps a space it opened on its fork branch, which its close deletes, and releases one its `branches` lists", async () => {
    const forked = await spaceWith(1);
    const listed = await spaceWith(2);
    const forking = EmulatedStorageManager.connectTo(server, {
      as: signer,
      branches: { [listed.space]: "" },
      forkBranch: "fork",
    });
    try {
      await load(forked.space, forked.id, forking);
      await load(listed.space, listed.id, forking);

      await releaseTwice(forking);

      expect(isOpen(forked.space, forking)).toBe(true);
      expect(isOpen(listed.space, forking)).toBe(false);
    } finally {
      await forking.close();
    }
    const branches = await writerStorage.open(forked.space).listBranches!();
    expect(
      branches.filter(({ name }) => name !== "").map(({ name, status }) => [
        name,
        status,
      ]),
    ).toEqual([["fork", "deleted"]]);
  });

  it("logs a released space whose session fails to close, and opens the space again on its next read", async () => {
    using logs = captureLogs("storage.v2");
    const { space, id } = await spaceWith(1);
    await load(space, id);
    const provider = readerStorage.open(space);
    const destroy = provider.destroy.bind(provider);
    const failure = new Error("the session close failed");
    using _destroy = stub(provider, "destroy", async () => {
      await destroy();
      throw failure;
    });

    await releaseTwice();

    expect(isOpen(space)).toBe(false);
    // The next open of the space waits for the released session's close.
    await load(space, id);
    expect(logs.messagesOf("release-space-failed")).toEqual([[
      `closing the session of the released space ${space}:`,
      failure,
    ]]);
    expect(readerStorage.open(space).replica.getDocument(id)?.value).toEqual({
      n: 1,
    });
  });

  it("tells every observer of `subscribeSpacesReleased()` the space it released when one of them throws", async () => {
    const { space, id } = await spaceWith(1);
    await load(space, id);
    const failure = new Error("the observer threw");
    const released: MemorySpace[] = [];
    const cancelThrowing = readerStorage.subscribeSpacesReleased(() => {
      throw failure;
    });
    const cancelRecording = readerStorage.subscribeSpacesReleased((each) => {
      released.push(each);
    });
    using consoleError = stub(console, "error");

    await releaseTwice();
    cancelThrowing();
    cancelRecording();

    expect(released).toEqual([space]);
    expect(consoleError.calls.map((call) => call.args)).toEqual([[
      "spaces-released subscriber threw:",
      failure,
    ]]);
  });

  it("announces no space released when its manager closes during the pass", async () => {
    const { space, id } = await spaceWith(1);
    await load(space, id);
    // Two passes release the document; the commit applying across spaces
    // keeps the space for the pass the close lands in.
    const applying = Promise.withResolvers<void>();
    readerStorage.trackMultiSpaceCommitApplying(applying.promise);
    await releaseTwice();
    expect(readerStorage.open(space).replica.getDocument(id)).toBeUndefined();
    applying.resolve();
    await readerStorage.multiSpaceCommitsApplied();
    const released: MemorySpace[] = [];
    const cancel = readerStorage.subscribeSpacesReleased((each) => {
      released.push(each);
    });

    const pass = readerStorage.releaseUnreadDocuments();
    const closing = readerStorage.close();
    await pass;
    await closing;
    cancel();

    expect(released).toEqual([]);
  });

  describe("on a serving manager", () => {
    let serving: EmulatedStorageManager;
    let servingRuntime: Runtime;

    beforeEach(() => {
      serving = EmulatedStorageManager.connectTo(server, {
        as: signer,
        servingHomeSpace: home,
      });
      servingRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: serving,
      });
    });

    afterEach(async () => {
      await servingRuntime.dispose();
      await serving.close();
    });

    it("loads a crossing's target again once the target's space has been released and opened again", async () => {
      // The target does not exist when the crossing is first followed, so
      // its load lands with nothing to release: what forgets the crossing
      // is the release of its space.
      const far = await writer.createSpace();
      const leaf = writer.getCell<{ name?: string }>(far, "crossing leaf");
      const leafLink = leaf.getAsNormalizedFullLink();
      const topTx = writer.edit();
      const top = writer.getCell<{ next?: unknown }>(
        home,
        "crossing top",
        undefined,
        topTx,
      );
      top.withTx(topTx).set({ next: leaf });
      expect((await topTx.commit().settled).error).toBeUndefined();
      await writerStorage.synced();
      const topSchema = {
        type: "object",
        properties: {
          next: { type: "object", properties: { name: { type: "string" } } },
        },
      } as const satisfies JSONSchema;
      const followTop = async () => {
        await serving.open(home).sync(
          top.getAsNormalizedFullLink().id,
          { path: [], schema: topSchema },
        );
        const pending = serving.pendingCrossingLoadAddresses?.() ?? [];
        await serving.loadsSettled(
          pending.map((address) =>
            entityKey(address, serving.scopeKeyIdentity())
          ),
        );
        return pending.map((address) => address.id);
      };

      expect(await followTop()).toEqual([leafLink.id]);
      expect(serving.open(far).replica.getDocument(leafLink.id))
        .toBeUndefined();
      await releaseTwice(serving);
      expect(isOpen(far, serving)).toBe(false);
      const leafTx = writer.edit();
      leaf.withTx(leafTx).set({ name: "Ada" });
      expect((await leafTx.commit().settled).error).toBeUndefined();
      await writerStorage.synced();

      expect(await followTop()).toEqual([leafLink.id]);
      expect(serving.open(far).replica.getDocument(leafLink.id)?.value)
        .toEqual({ name: "Ada" });
    });
  });
});
