import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { pieceSourceMovedPast } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("piece source moved past");
const space = signer.did();

const from = { identity: "from-pattern", symbol: "default" };
const to = { identity: "to-pattern", symbol: "default" };

describe("pieceSourceMovedPast()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  // A piece whose `pieceSourceHistory` meta holds what `history` makes of a
  // revision builder.
  const pieceWithHistory = async (
    name: string,
    history: (
      revision: (
        pattern: { identity: string; symbol: string },
        timestamp: number,
      ) => FabricValue,
    ) => FabricValue,
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, name, undefined, tx);
    const revision = (
      pattern: { identity: string; symbol: string },
      timestamp: number,
    ) => ({
      revisionId: `${pattern.identity}-${timestamp}`,
      timestamp,
      pattern,
      source: runtime.getCell(
        space,
        `pattern:${pattern.identity}`,
        undefined,
        tx,
      ).getAsLink(),
      operation: "origin-update",
    });
    cell.setMetaRaw(
      "pieceSourceHistory",
      history(revision),
      rawMetaWriteAuthorization,
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    return runtime.getCell(space, name);
  };

  it("returns `true` for a history whose latest revision follows one naming the earlier pattern", async () => {
    const cell = await pieceWithHistory("moved", (revision) => [
      revision(from, 1),
      revision(to, 2),
    ]);
    expect(pieceSourceMovedPast(cell, from, to)).toBe(true);
  });

  it("returns `false` for a history whose latest revision names another pattern", async () => {
    const cell = await pieceWithHistory("moved back", (revision) => [
      revision(to, 1),
      revision(from, 2),
    ]);
    expect(pieceSourceMovedPast(cell, from, to)).toBe(false);
  });

  it("returns `false` for a history it cannot read", async () => {
    const cell = await pieceWithHistory("unreadable", (revision) => ({
      revisions: [revision(from, 1), revision(to, 2)],
    }));
    expect(pieceSourceMovedPast(cell, from, to)).toBe(false);
  });
});
