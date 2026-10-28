import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { sameReactivityLog } from "../../src/scheduler/reactivity.ts";
import type { ReactivityLog } from "../../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../../src/storage/interface.ts";

const address = (
  overrides: Partial<IMemorySpaceAddress> = {},
): IMemorySpaceAddress => ({
  space: "did:key:z6MkSameReactivityLog" as MemorySpace,
  id: "of:same-reactivity-log" as URI,
  type: "application/json",
  scope: "user",
  path: ["value"],
  ...overrides,
});

const logOf = (read: IMemorySpaceAddress): ReactivityLog => ({
  reads: [read],
  shallowReads: [],
  writes: [],
});

describe("sameReactivityLog()", () => {
  it("returns `true` for two logs whose read names the same instance", () => {
    expect(
      sameReactivityLog(
        logOf(address({ scopeKey: "user:alice" })),
        logOf(address({ scopeKey: "user:alice" })),
      ),
    ).toBe(true);
  });

  it("returns `false` for two logs whose reads name two instances of one scope", () => {
    expect(
      sameReactivityLog(
        logOf(address({ scopeKey: "user:alice" })),
        logOf(address({ scopeKey: "user:bob" })),
      ),
    ).toBe(false);
  });

  it("returns `false` for two logs of which only one read names its instance", () => {
    expect(
      sameReactivityLog(
        logOf(address()),
        logOf(address({ scopeKey: "user:alice" })),
      ),
    ).toBe(false);
  });
});
