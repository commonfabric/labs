import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { resolveScopeKey } from "@commonfabric/memory/v2";

import {
  ViewReadCache,
  type ViewReadPart,
} from "../src/executor/view-read-cache.ts";
import type {
  IMemoryChange,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";

const space = "did:key:view-cache";
const read: IMemorySpaceAddress = {
  space,
  id: "of:input",
  path: ["value"],
};
const identity = { principal: "did:key:alice", sessionId: "tab-a" };

describe("view read cache", () => {
  it("retains equal and sibling values but invalidates a previously missing read", () => {
    const cache = new ViewReadCache<string>(identity);
    cache.set("cached", { reads: [read], shallowReads: [] });
    const notify = (change: IMemoryChange) =>
      cache.notify({ type: "integrate", space, changes: [change] });
    notify({
      address: read,
      before: { value: { nested: 1 } },
      after: { value: { nested: 1 } },
    });
    notify({ address: { ...read, path: ["other"] }, before: 1, after: 2 });
    expect(cache.value).toBe("cached");
    notify({ address: read, before: {}, after: { value: 1 } });
    expect(cache.value).toBeUndefined();
  });

  it("matches scoped notifications to the viewing instance", () => {
    const cache = new ViewReadCache<string>(identity);
    const scoped = { ...read, scope: "session" as const };
    cache.set("cached", { reads: [scoped], shallowReads: [] });
    cache.notify({
      type: "integrate",
      space,
      changes: [{
        address: {
          ...scoped,
          scopeKey: resolveScopeKey("session", {
            ...identity,
            sessionId: "tab-b",
          }),
        },
        before: { value: 1 },
        after: { value: 2 },
      }],
    });
    expect(cache.value).toBe("cached");
    cache.notify({
      type: "integrate",
      space,
      changes: [{
        address: { ...scoped, scopeKey: resolveScopeKey("session", identity) },
        before: { value: 1 },
        after: { value: 2 },
      }],
    });
    expect(cache.value).toBeUndefined();
  });

  it("ignores deep edits under shallow reads but observes structural changes", () => {
    const cache = new ViewReadCache<string>(identity);
    cache.set("cached", { reads: [], shallowReads: [read] });
    cache.notify({
      type: "commit",
      space,
      changes: [{
        address: { ...read, path: ["value", "nested", "count"] },
        before: { value: { nested: { count: 1 } } },
        after: { value: { nested: { count: 2 } } },
      }],
    });
    expect(cache.value).toBe("cached");
    cache.notify({
      type: "commit",
      space,
      changes: [{
        address: read,
        before: { value: { nested: {} } },
        after: { value: { nested: {}, added: {} } },
      }],
    });
    expect(cache.value).toBeUndefined();
  });

  it("retains shallow child reads alongside their shallow parents", () => {
    const cache = new ViewReadCache<string>(identity);
    cache.set("cached", {
      reads: [],
      shallowReads: [
        { ...read, path: ["value", "nested"] },
        read,
      ],
    });
    cache.notify({
      type: "integrate",
      space,
      changes: [{
        address: { ...read, path: ["value", "nested", "count"] },
        before: { value: { nested: { count: 1 } } },
        after: { value: { nested: { count: 1, added: 2 } } },
      }],
    });
    expect(cache.value).toBeUndefined();
  });

  it("replaces dependencies and invalidates on replica reset", () => {
    const cache = new ViewReadCache<string>(identity);
    cache.set("first", { reads: [read], shallowReads: [] });
    cache.set("second", {
      reads: [{ ...read, id: "of:replacement" }],
      shallowReads: [],
    });
    cache.notify({
      type: "integrate",
      space,
      changes: [{ address: read, before: 2, after: 1 }],
    });
    expect(cache.value).toBe("second");
    cache.notify({ type: "reset", space });
    expect(cache.value).toBeUndefined();
  });

  it("invalidates through a part kept from the result before", () => {
    const cache = new ViewReadCache<string>(identity);
    const kept = [read];
    const added: IMemorySpaceAddress = { ...read, id: "of:added" };
    cache.setParts(
      "first",
      new Map<string, ViewReadPart>([["kept", {
        reads: [kept],
        shallowReads: [],
      }]]),
    );
    cache.setParts(
      "second",
      new Map<string, ViewReadPart>([
        ["kept", { reads: [kept], shallowReads: [] }],
        ["added", { reads: [[added]], shallowReads: [] }],
      ]),
    );
    cache.notify({
      type: "integrate",
      space,
      changes: [{ address: read, before: { value: 1 }, after: { value: 2 } }],
    });
    expect(cache.value).toBeUndefined();
  });

  it("stops observing a part a later result leaves out or replaces", () => {
    const cache = new ViewReadCache<string>(identity);
    const replaced: IMemorySpaceAddress = { ...read, id: "of:replaced" };
    const replacement: IMemorySpaceAddress = { ...read, id: "of:replacement" };
    cache.setParts(
      "first",
      new Map<string, ViewReadPart>([
        ["dropped", { reads: [[read]], shallowReads: [] }],
        ["changed", { reads: [[replaced]], shallowReads: [] }],
      ]),
    );
    cache.setParts(
      "second",
      new Map<string, ViewReadPart>([["changed", {
        reads: [[replacement]],
        shallowReads: [],
      }]]),
    );
    cache.notify({
      type: "integrate",
      space,
      changes: [
        { address: read, before: { value: 1 }, after: { value: 2 } },
        { address: replaced, before: { value: 1 }, after: { value: 2 } },
      ],
    });
    expect(cache.value).toBe("second");
    cache.notify({
      type: "integrate",
      space,
      changes: [{
        address: replacement,
        before: { value: 1 },
        after: { value: 2 },
      }],
    });
    expect(cache.value).toBeUndefined();
  });
});
