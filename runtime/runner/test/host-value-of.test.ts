/**
 * `hostValueOf()` over a schema-less read: what the worker hands a host for a
 * value read through a query-result view, and what a subscription projecting
 * through it depends on.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import { type Cell, hostValueOf, sinkProjected } from "../src/cell.ts";
import { isSigilLink } from "../src/link-types.ts";
import { parseLink } from "../src/link-utils.ts";
import { ViewDriftError } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("host-value-of");
const space = signer.did();

/** A runtime over its own store, with a writer of raw document values. */
function holder() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  const cell = (id: string): Cell<unknown> => runtime.getCell(space, id);
  /** Stores `value` as the document `id` holds, and waits for it to settle. */
  const write = async (id: string, value: unknown): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const written = cell(id);
    written.withTx(tx).setRawUntyped(value as never);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return written;
  };
  return {
    runtime,
    cell,
    write,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** Whether `value` and every container inside it is frozen. */
function deeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) &&
    Object.values(value).every((member) => deeplyFrozen(member));
}

describe("hostValueOf()", () => {
  it("returns a record read through a view as frozen plain data", async () => {
    await using docs = holder();
    const piece = await docs.write("piece", {
      title: "a title",
      count: 3,
      tags: ["one", "two"],
      meta: { nested: { deep: true } },
    });

    const value = hostValueOf(piece.get());

    expect(value).toEqual({
      title: "a title",
      count: 3,
      tags: ["one", "two"],
      meta: { nested: { deep: true } },
    });
    expect(deeplyFrozen(value)).toBe(true);
  });

  it("follows a link inside the value to the document it reaches", async () => {
    await using docs = holder();
    const profile = await docs.write("profile", { name: "an author" });
    const piece = await docs.write("piece", {
      title: "a title",
      author: profile.getAsLink(),
    });

    expect(hostValueOf(piece.get())).toEqual({
      title: "a title",
      author: { name: "an author" },
    });
  });

  it("follows a chain of links to the document at its end", async () => {
    await using docs = holder();
    const end = await docs.write("end", { reached: true });
    const middle = await docs.write("middle", end.getAsLink());
    const piece = await docs.write("piece", { via: middle.getAsLink() });

    expect(hostValueOf(piece.get())).toEqual({ via: { reached: true } });
  });

  it("returns `undefined` where a link reaches no document", async () => {
    await using docs = holder();
    const piece = await docs.write("piece", {
      missing: docs.cell("never-written").getAsLink(),
    });

    expect(hostValueOf(piece.get())).toEqual({ missing: undefined });
  });

  it("returns a back-link where a link returns to a position the walk is inside", async () => {
    await using docs = holder();
    const first = docs.cell("first");
    const second = docs.cell("second");
    await docs.write("second", { back: first.getAsLink() });
    await docs.write("first", { to: second.getAsLink() });

    const value = hostValueOf(first.get()) as { to: { back: unknown } };

    expect(value.to.back).toEqual(linkRefFrom({ path: [] }));
  });

  it("returns a back-link to a nested container a link inside it returns to", async () => {
    await using docs = holder();
    const piece = docs.cell("piece");
    await docs.write("piece", {
      nested: { name: "self", back: piece.key("nested").getAsLink() },
    });

    expect(hostValueOf(piece.get())).toEqual({
      nested: { name: "self", back: linkRefFrom({ path: ["nested"] }) },
    });
  });

  it("reads a document reached on two branches out at both", async () => {
    await using docs = holder();
    const shared = await docs.write("shared", { n: 1 });
    const piece = await docs.write("piece", {
      a: shared.getAsLink(),
      b: { inner: shared.getAsLink() },
    });

    expect(hostValueOf(piece.get())).toEqual({
      a: { n: 1 },
      b: { inner: { n: 1 } },
    });
  });

  it("refuses a held view whose document no longer holds the kind it was built over", async () => {
    await using docs = holder();
    const tx = docs.runtime.edit();
    const piece = docs.runtime.getCell<unknown>(space, "piece", undefined, tx);
    piece.set({ title: "a title" });
    const held = piece.get();
    piece.set(["a title"]);

    expect(() => hostValueOf(held)).toThrow(ViewDriftError);
  });

  it("returns a stream position as the link to the stream", async () => {
    await using docs = holder();
    const piece = await docs.write("piece", { events: { $stream: true } });

    const value = hostValueOf(piece.get()) as { events: unknown };

    expect(isSigilLink(value.events)).toBe(true);
    expect(parseLink(value.events as never, piece).path).toEqual(["events"]);
  });

  it("returns a stream position behind a link as the link to that stream", async () => {
    await using docs = holder();
    const target = await docs.write("target", { events: { $stream: true } });
    const piece = await docs.write("piece", { linked: target.getAsLink() });

    const value = hostValueOf(piece.get()) as { linked: { events: unknown } };

    expect(isSigilLink(value.linked.events)).toBe(true);
    const link = parseLink(value.linked.events as never, piece);
    expect(link.id).toBe(target.getAsNormalizedFullLink().id);
    expect(link.path).toEqual(["events"]);
  });

  describe("as a projection of a subscription", () => {
    /** Subscribes `cell` through `project`, keeping each value delivered. */
    function deliveries(
      cell: Cell<unknown>,
      project: (value: unknown) => unknown = hostValueOf,
    ) {
      const values: unknown[] = [];
      const cancel = sinkProjected(cell, project, (value) => {
        values.push(value);
      });
      return { values, cancel };
    }

    it("runs again when a value behind a link changes", async () => {
      await using docs = holder();
      const profile = await docs.write("profile", { name: "an author" });
      const piece = await docs.write("piece", { author: profile.getAsLink() });
      const { values, cancel } = deliveries(piece);
      try {
        await docs.write("profile", { name: "a renamed author" });

        expect(values).toEqual([
          { author: { name: "an author" } },
          { author: { name: "a renamed author" } },
        ]);
      } finally {
        cancel();
      }
    });

    it("runs again when a key is added to the record", async () => {
      await using docs = holder();
      const piece = await docs.write("piece", { title: "a title" });
      const { values, cancel } = deliveries(piece);
      try {
        await docs.write("piece", { title: "a title", added: 1 });

        expect(values.at(-1)).toEqual({ title: "a title", added: 1 });
      } finally {
        cancel();
      }
    });

    it("does not run again for a write to a document the value does not reach", async () => {
      await using docs = holder();
      const piece = await docs.write("piece", { title: "a title" });
      const { values, cancel } = deliveries(piece);
      try {
        await docs.write("elsewhere", { unrelated: true });

        expect(values).toHaveLength(1);
      } finally {
        cancel();
      }
    });

    it("runs again only for what the projection read", async () => {
      await using docs = holder();
      const piece = await docs.write("piece", { shown: 1, hidden: 1 });
      const { values, cancel } = deliveries(
        piece,
        (value) => (value as { shown: number }).shown,
      );
      try {
        await docs.write("piece", { shown: 1, hidden: 2 });
        expect(values).toEqual([1]);

        await docs.write("piece", { shown: 2, hidden: 2 });
        expect(values).toEqual([1, 2]);
      } finally {
        cancel();
      }
    });
  });
});
