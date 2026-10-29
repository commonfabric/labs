import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shouldRecreateRuntime } from "../src/lib/runtime-lifecycle.ts";

describe("shouldRecreateRuntime", () => {
  // One runtime per (identity, host). A space/view change must NOT recreate the
  // runtime — that is the load-bearing lifecycle rule behind "space is just
  // part of the address". (apiUrl/identity compare by reference, matching the
  // AppState lifecycle this guards.)

  const identity = { did: () => "did:key:z6Mk-lifecycle" } as never;
  const otherIdentity = { did: () => "did:key:z6Mk-other" } as never;
  const hostA = new URL("http://host-a.test/");
  const base = {
    apiUrl: hostA,
    identity,
  } as unknown as Parameters<typeof shouldRecreateRuntime>[0];

  it("does not recreate on a view/space change alone", () => {
    expect(shouldRecreateRuntime(base, { ...base })).toBe(false);
  });

  it("recreates on identity change", () => {
    expect(
      shouldRecreateRuntime(base, { ...base, identity: otherIdentity }),
    ).toBe(true);
  });

  it("recreates on host change", () => {
    expect(
      shouldRecreateRuntime(base, {
        ...base,
        apiUrl: new URL("http://host-b.test/"),
      }),
    ).toBe(true);
  });
});
