import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/index.ts";
import { spaceCellId, SpaceRootMissingError } from "../src/space-root-slot.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const user = await Identity.fromPassphrase("space root slot user");
const space = (await Identity.fromPassphrase("space root slot space"))
  .did() as MemorySpace;

describe("space-root-slot", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: user });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** The `defaultPattern` slot of the space cell of `space`. */
  function slot(): Cell<any> {
    return (runtime.getSpaceCell(space) as Cell<any>).key("defaultPattern");
  }

  it("names the space cell `getSpaceCell()` returns", () => {
    expect(spaceCellId(space)).toBe(
      runtime.getSpaceCell(space).getAsNormalizedFullLink().id,
    );
    expect(spaceCellId(space)).not.toBe(
      runtime.getSpaceCell(user.did() as MemorySpace).getAsNormalizedFullLink()
        .id,
    );
  });

  it("refuses a write beneath an empty `defaultPattern` slot, and leaves the slot empty", () => {
    const tx = runtime.edit();
    expect(() => slot().key("profiles").withTx(tx).set(["Ada"])).toThrow(
      SpaceRootMissingError,
    );
    tx.abort();

    expect(slot().getRaw()).toBeUndefined();
  });

  it("lets a write fill an empty slot together with what lies beneath it", async () => {
    const tx = runtime.edit();
    slot().withTx(tx).set({ profiles: ["Ada"] });
    expect((await tx.commit().settled).error).toBeUndefined();

    expect(slot().key("profiles").get()).toEqual(["Ada"]);
  });

  it("refuses a write beneath a slot the same transaction filled and then emptied", () => {
    const tx = runtime.edit();
    slot().withTx(tx).set({ profiles: [] });
    slot().withTx(tx).set(undefined);
    expect(() => slot().key("profiles").withTx(tx).set(["Ada"])).toThrow(
      SpaceRootMissingError,
    );
    tx.abort();
  });

  it("refuses a write beneath a slot the same transaction filled and then replaced the space cell without", () => {
    const tx = runtime.edit();
    slot().withTx(tx).set({ profiles: [] });
    (runtime.getSpaceCell(space) as Cell<any>).withTx(tx).set({});
    expect(() => slot().key("profiles").withTx(tx).set(["Ada"])).toThrow(
      SpaceRootMissingError,
    );
    tx.abort();
  });

  it("lets a write beneath a slot that links a root land in the root", async () => {
    const setup = runtime.edit();
    const root = runtime.getCell<Record<string, unknown>>(
      space,
      "space root slot root",
      undefined,
      setup,
    );
    root.set({});
    slot().withTx(setup).set(root);
    expect((await setup.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    slot().key("profiles").withTx(tx).set(["Ada"]);
    expect((await tx.commit().settled).error).toBeUndefined();

    expect(root.key("profiles").get()).toEqual(["Ada"]);
  });
});
