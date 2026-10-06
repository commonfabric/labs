/**
 * The seq a committed transaction reports is verified against storage rather
 * than against the code that recorded it: a second session reads the document
 * at that seq and one seq earlier, so the number has to be the commit's real
 * position in the space's log, not merely a number the replica remembered.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type { Server as MemoryV2Server } from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { testSessionOpenAuthFactory } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("v2-transaction committed seq");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("another space")).did();

describe("v2-transaction", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let remoteClient: MemoryV2Client.Client;
  let remoteSession: MemoryV2Client.SpaceSession;

  // A second session on the loopback server reads the space as storage holds
  // it, not as the runtime's own replica does.
  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const candidate = storageManager as unknown as {
      server?: () => MemoryV2Server;
    };
    if (typeof candidate.server !== "function") {
      throw new Error("the fixture needs an emulated storage manager");
    }
    remoteClient = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(candidate.server()),
    });
    remoteSession = await remoteClient.mount(
      space,
      {},
      testSessionOpenAuthFactory,
    );
  });

  afterEach(async () => {
    await runtime.dispose();
    await remoteClient.close();
    await storageManager.close();
  });

  it("reports the store seq its space accepted the commit at", async () => {
    // Known only once the verdict arrives, and then exactly the commit's
    // position in the space's log: read there, another session sees the
    // write; read one seq earlier, it sees nothing of it.

    const tx = runtime.edit();
    const cell = runtime.getCell(space, "committed seq", undefined, tx);
    cell.set({ title: "after" });
    expect(tx.committedSeq?.(space)).toBeUndefined();

    const committed = await tx.commit().settled;
    expect(committed.error).toBeUndefined();
    const seq = tx.committedSeq?.(space);
    if (seq === undefined) {
      throw new Error("the accepted commit reported no seq");
    }

    const id = cell.getAsNormalizedFullLink().id;
    const valueAt = async (atSeq: number) =>
      (await remoteSession.queryGraph({
        roots: [{ id, selector: { path: [], schema: false } }],
        atSeq,
      }))
        .entities.find((entity) => entity.id === id)?.document?.value;
    expect(await valueAt(seq)).toEqual({ title: "after" });
    expect(await valueAt(seq - 1)).toBeUndefined();
    expect(tx.committedSeq?.(otherSpace)).toBeUndefined();
  });

  it("reports no seq for a commit its space refused", async () => {
    const { replica } = storageManager.open(space);
    replica.commitNative = (() =>
      Promise.reject(
        new Error("simulated storage crash"),
      )) as NonNullable<typeof replica.commitNative>;

    const tx = runtime.edit();
    runtime.getCell(space, "refused seq", undefined, tx).set({
      title: "never",
    });
    const committed = await tx.commit().settled;

    expect(committed.error).toBeDefined();
    expect(tx.committedSeq?.(space)).toBeUndefined();
  });
});
