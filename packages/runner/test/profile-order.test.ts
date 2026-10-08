import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import { orderProfileCandidates } from "../src/profile-order.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-profile-order");

describe("orderProfileCandidates()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let profiles: Cell<unknown>[];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    profiles = [];
    for (const name of ["first", "second", "third"]) {
      const space = (await Identity.fromPassphrase(`profile ${name}`)).did();
      profiles.push(await documentIn(space, { name }));
    }
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** A document in `space` holding `value`. */
  async function documentIn(
    space: Cell<unknown>["space"],
    value: unknown,
  ): Promise<Cell<unknown>> {
    const cell = runtime.getCell<unknown>(space, crypto.randomUUID());
    await runtime.editWithRetry((tx) => cell.withTx(tx).set(value as never));
    return cell;
  }

  /** A home `defaultPattern` holding `value`, in the home space. */
  async function home(value: unknown): Promise<Cell<unknown>> {
    return await documentIn(signer.did(), value);
  }

  /** The names of `profiles` in the order `defaultPattern` gives them. */
  function namesInOrder(defaultPattern: Cell<unknown>): unknown[] {
    return orderProfileCandidates(
      runtime,
      defaultPattern,
      signer.did(),
      profiles,
    ).ordered.map((profile) => (profile.get() as { name: string }).name);
  }

  it("returns the candidates in list order when the home names no default and no MRU", async () => {
    expect(namesInOrder(await home({}))).toEqual(["first", "second", "third"]);
  });

  it("puts the profile the home's slot names first", async () => {
    const defaultPattern = await home({
      defaultProfile: { profile: profiles[2] },
    });

    expect(namesInOrder(defaultPattern)).toEqual(["third", "first", "second"]);
  });

  it("puts `legacyDefaultProfile` first while the slot names none", async () => {
    const defaultPattern = await home({
      defaultProfile: {},
      legacyDefaultProfile: profiles[1],
    });

    expect(namesInOrder(defaultPattern)).toEqual(["second", "first", "third"]);
  });

  it("puts the profile linked at the root of a slotless home's `defaultProfile` first", async () => {
    const defaultCell = await documentIn(signer.did(), profiles[2]);
    const defaultPattern = await home({ defaultProfile: defaultCell });

    expect(namesInOrder(defaultPattern)).toEqual(["third", "first", "second"]);
  });

  it("orders by MRU rank, after the default, then by list order", async () => {
    const defaultPattern = await home({
      defaultProfile: { profile: profiles[1] },
      mru: [profiles[2]],
    });

    expect(namesInOrder(defaultPattern)).toEqual(["second", "third", "first"]);
  });

  it("orders by MRU rank alone when the home names no default", async () => {
    const defaultPattern = await home({ mru: [profiles[2], profiles[1]] });

    expect(namesInOrder(defaultPattern)).toEqual(["third", "second", "first"]);
  });

  it("passes over a default that points into the home space", async () => {
    const inHome = await documentIn(signer.did(), { name: "home" });
    const defaultPattern = await home({
      defaultProfile: { profile: inHome },
      mru: [profiles[1]],
    });

    const order = orderProfileCandidates(
      runtime,
      defaultPattern,
      signer.did(),
      profiles,
    );

    expect(order.defaultValid).toBe(false);
    expect(namesInOrder(defaultPattern)).toEqual(["second", "first", "third"]);
  });
});
