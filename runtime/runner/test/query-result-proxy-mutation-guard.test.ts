/**
 * A query-result proxy is a live, transaction-backed READ view. It carries no
 * write capability, so property assignment and the in-place array mutators
 * refuse; structural mutations (freeze/seal/defineProperty/delete) refuse for
 * a second reason, that they cannot be honored without either corrupting the
 * backing store or defeating live read-resolution. Writes reach a cell through
 * the `asCell` handle a `Writable<..>` field mints. These tests lock in both
 * refusals.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test proxy mutation guard");
const space = signer.did();

describe("query-result proxy mutation guard", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  function makeProxy(): Record<string, unknown> {
    const cell = runtime.getCell(space, "guarded", undefined, tx);
    cell.set({ a: 1, b: { c: 2 } });
    return cell.getAsQueryResult() as Record<string, unknown>;
  }

  function makeArrayProxy(): number[] {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "guarded-array",
      undefined,
      tx,
    );
    cell.set({ items: [1, 2, 3] });
    return (cell.getAsQueryResult() as { items: number[] }).items;
  }

  it("refuses a property assignment", () => {
    const proxy = makeProxy();
    expect(() => {
      proxy.a = 2;
    }).toThrow("read-only");
  });

  it("refuses `push`", () => {
    const items = makeArrayProxy();
    expect(() => items.push(4)).toThrow("read-only");
  });

  it("refuses `splice`", () => {
    const items = makeArrayProxy();
    expect(() => items.splice(0, 1)).toThrow("read-only");
  });

  it("refuses `sort`", () => {
    const items = makeArrayProxy();
    expect(() => items.sort()).toThrow("read-only");
  });

  it("refuses every in-place array mutator", () => {
    // Named in full rather than by a representative few: each is dispatched
    // from the same classifying map, so a name dropped from it is the way this
    // set stops refusing as a group.
    const mutate: Record<string, (items: number[]) => unknown> = {
      copyWithin: (items) => items.copyWithin(0, 1),
      fill: (items) => items.fill(0),
      pop: (items) => items.pop(),
      push: (items) => items.push(4),
      reverse: (items) => items.reverse(),
      shift: (items) => items.shift(),
      sort: (items) => items.sort(),
      splice: (items) => items.splice(0, 1),
      unshift: (items) => items.unshift(0),
    };
    for (const [name, call] of Object.entries(mutate)) {
      const items = makeArrayProxy();
      expect(() => call(items), `${name} must refuse`).toThrow("read-only");
    }
  });

  it("maps, filters and measures length through the view", () => {
    const items = makeArrayProxy();
    expect(items.map((n) => n * 2)).toEqual([2, 4, 6]);
    expect(items.filter((n) => n > 1)).toEqual([2, 3]);
    expect(items.length).toBe(3);
  });

  it("refuses Object.freeze", () => {
    const proxy = makeProxy();
    expect(() => Object.freeze(proxy)).toThrow("live cell-result proxy");
  });

  it("refuses Object.seal", () => {
    const proxy = makeProxy();
    expect(() => Object.seal(proxy)).toThrow("live cell-result proxy");
  });

  it("refuses Object.preventExtensions", () => {
    const proxy = makeProxy();
    expect(() => Object.preventExtensions(proxy)).toThrow(
      "live cell-result proxy",
    );
  });

  it("refuses Object.defineProperty", () => {
    const proxy = makeProxy();
    expect(() =>
      Object.defineProperty(proxy, "added", { value: 1, enumerable: true })
    ).toThrow("live cell-result proxy");
  });

  it("refuses delete", () => {
    const proxy = makeProxy();
    expect(() => {
      delete proxy.a;
    }).toThrow("live cell-result proxy");
  });

  it("still allows a snapshotted plain copy to be frozen", () => {
    const proxy = makeProxy();
    // The documented escape hatch: round-trip to a detached plain value, which
    // is freely freezable.
    const snapshot = JSON.parse(JSON.stringify(proxy));
    expect(() => Object.freeze(snapshot)).not.toThrow();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({ a: 1, b: { c: 2 } });
  });
});
