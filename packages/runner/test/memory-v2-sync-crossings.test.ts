import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { Cell } from "../src/cell.ts";
import { entityKey } from "../src/scheduler/keys.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("memory v2 sync crossings");
const space = signer.did();
const farSpace = (await Identity.fromPassphrase("memory v2 sync crossings far"))
  .did();

const leafSchema = {
  type: "object",
  properties: { name: { type: "string" } },
} as const;
const topSchema = {
  type: "object",
  properties: { next: leafSchema },
} as const;

describe("memory-v2-sync-crossings", () => {
  let server: MemoryV2Server.Server;
  let managerA: EmulatedStorageManager;
  let managerB: EmulatedStorageManager;
  let rt1: Runtime;
  let rt2: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    managerA = EmulatedStorageManager.connectTo(server, { as: signer });
    managerB = EmulatedStorageManager.connectTo(server, { as: signer });
    rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerA,
    });
    rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: managerB,
    });
  });

  afterEach(async () => {
    await rt1.dispose();
    await rt2.dispose();
    await managerA.close();
    await managerB.close();
    await server.close();
  });

  /** Whether replica B holds the document `cell` names, in `inSpace`. */
  function localOnB(cell: Cell<unknown>, inSpace: MemorySpace): boolean {
    const link = cell.getAsNormalizedFullLink();
    const replica = managerB.open(inSpace) as unknown as {
      get?: (uri: string, scope?: unknown) => unknown;
    };
    return replica.get?.(link.id, link.scope) !== undefined;
  }

  /** Writes a leaf in the far space and a document here whose `next` links to it. */
  async function writeCrossing(cause: string) {
    const txFar = rt1.edit();
    const leaf = rt1.getCell<{ name?: string }>(
      farSpace,
      `${cause} leaf`,
      undefined,
      txFar,
    );
    leaf.withTx(txFar).set({ name: "Ada" });
    rt1.prepareTxForCommit(txFar);
    expect((await txFar.commit().settled).error).toBeUndefined();
    const tx = rt1.edit();
    const top = rt1.getCell<{ next?: unknown }>(
      space,
      `${cause} top`,
      undefined,
      tx,
    );
    top.withTx(tx).set({ next: leaf });
    rt1.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt1.storageManager.synced();
    return { leaf, top };
  }

  it("kicks the far document's load from the crossing a sync's frame carries", async () => {
    const { leaf, top } = await writeCrossing("resolved sync");
    const top2 = rt2.getCellFromLink<{ next?: { name?: string } }>({
      ...top.getAsNormalizedFullLink(),
      schema: topSchema,
    });
    expect(localOnB(leaf, farSpace)).toBe(false);
    await top2.sync();
    // Nothing read through the link: the frame's crossing kicked the far
    // load, which the manager lists until it lands, and reports following
    // once its session has negotiated the capability.
    expect(managerB.followsCrossings?.(space)).toBe(true);
    const leafLink = leaf.getAsNormalizedFullLink();
    const pending = managerB.pendingCrossingLoadAddresses?.() ?? [];
    expect(pending.map((address) => [address.space, address.id])).toEqual([
      [farSpace, leafLink.id],
    ]);
    await managerB.loadsSettled(
      pending.map((address) => entityKey(address, managerB.scopeKeyIdentity())),
    );
    expect(managerB.pendingCrossingLoadAddresses?.()).toEqual([]);
    expect(localOnB(leaf, farSpace)).toBe(true);
    expect(top2.get()).toEqual({ next: { name: "Ada" } });
  });

  it("leaves a link the schema does not follow unloaded", async () => {
    const { leaf, top } = await writeCrossing("unfollowed link");
    const top2 = rt2.getCellFromLink<{ next?: unknown }>({
      ...top.getAsNormalizedFullLink(),
      schema: { type: "object", properties: {} },
    });
    await top2.sync();
    expect(localOnB(top, space)).toBe(true);
    expect(localOnB(leaf, farSpace)).toBe(false);
  });
});
