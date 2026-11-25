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
  for (const scope of ["user", "session"] as const) {
    for (const shallow of [false, true]) {
      it(`replaces mixed implicit and explicit ${scope} reads with shallow=${shallow}`, () => {
        const cache = new ViewReadCache<string>(identity);
        const scoped: IMemorySpaceAddress = { ...read, scope };
        const reads = [scoped, {
          ...scoped,
          scopeKey: resolveScopeKey(scope, identity),
        }];
        cache.set("first", {
          reads: shallow ? [] : reads,
          shallowReads: shallow ? reads : [],
        });
        cache.set("replacement", {
          reads: [{ ...read, id: "of:replacement" }],
          shallowReads: [],
        });
        cache.notify({
          type: "integrate",
          space,
          changes: [{
            address: scoped,
            before: { value: 1 },
            after: { value: 2 },
          }],
        });
        expect(cache.value).toBe("replacement");
        cache.notify({
          type: "integrate",
          space,
          changes: [{
            address: { ...read, id: "of:replacement" },
            before: { value: 1 },
            after: { value: 2 },
          }],
        });
        expect(cache.value).toBeUndefined();
      });
    }
  }

  it("keeps explicit sessions separate when replacing mixed reads", () => {
    const cache = new ViewReadCache<string>(identity);
    const scoped: IMemorySpaceAddress = { ...read, scope: "session" };
    const other = {
      ...scoped,
      scopeKey: resolveScopeKey("session", { ...identity, sessionId: "tab-b" }),
    };
    cache.set("first", {
      reads: [scoped, {
        ...scoped,
        scopeKey: resolveScopeKey("session", identity),
      }, other],
      shallowReads: [],
    });
    cache.set("other session", { reads: [other], shallowReads: [] });
    cache.notify({
      type: "integrate",
      space,
      changes: [{ address: scoped, before: { value: 1 }, after: { value: 2 } }],
    });
    expect(cache.value).toBe("other session");
    cache.notify({
      type: "integrate",
      space,
      changes: [{ address: other, before: { value: 1 }, after: { value: 2 } }],
    });
    expect(cache.value).toBeUndefined();
  });

  it("keeps shallow parents and children after canonical grouping", () => {
    const cache = new ViewReadCache<string>(identity);
    const parent: IMemorySpaceAddress = { ...read, scope: "session" };
    const child = {
      ...parent,
      scopeKey: resolveScopeKey("session", identity),
      path: ["value", "nested"],
    };
    cache.set("first", {
      reads: [],
      shallowReads: [parent, child, { ...child, scopeKey: undefined }],
    });
    cache.notify({
      type: "integrate",
      space,
      changes: [{
        address: { ...child, path: ["value", "nested", "count"] },
        before: { value: { nested: { count: 1 } } },
        after: { value: { nested: { count: 2 } } },
      }],
    });
    expect(cache.value).toBe("first");
    cache.notify({
      type: "integrate",
      space,
      changes: [{
        address: { ...child, path: ["value", "nested", "added"] },
        before: { value: { nested: { count: 2 } } },
        after: { value: { nested: { count: 2, added: 3 } } },
      }],
    });
    expect(cache.value).toBeUndefined();
    cache.set("second", { reads: [], shallowReads: [] });
    expect(cache.value).toBe("second");
  });

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
