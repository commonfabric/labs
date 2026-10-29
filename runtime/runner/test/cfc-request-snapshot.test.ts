import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isDeepFrozen } from "@commonfabric/data-model";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";

describe("CFC request snapshots", () => {
  it("creates a detached immutable snapshot", () => {
    const request = {
      url: "https://example.com/data",
      options: {
        method: "POST",
        headers: {
          "x-test": "initial",
        },
        body: {
          nested: ["a", "b"],
        },
      },
    };

    const snapshot = createFrozenRequestSnapshot(request);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.options)).toBe(true);
    expect(Object.isFrozen(snapshot.options.headers)).toBe(true);
    expect(Object.isFrozen(snapshot.options.body)).toBe(true);
    expect(snapshot).toEqual(request);

    request.options.headers["x-test"] = "changed";
    (request.options.body.nested as string[]).push("c");

    expect(snapshot.options.headers["x-test"]).toBe("initial");
    expect(snapshot.options.body.nested).toEqual(["a", "b"]);
  });

  it("preserves Fabric wrapper values rather than mangling them", () => {
    // A `structuredClone` would strip a `FabricHash` (state in private fields,
    // accessed via prototype getters) to an empty husk; the snapshot must keep
    // the class identity and content intact.
    const hash = FabricHash.fromString("sha256:abcd");
    const request = { url: "https://example.com", meta: { hash } };

    const snapshot = createFrozenRequestSnapshot(request);

    expect(isDeepFrozen(snapshot)).toBe(true);
    const out = snapshot.meta.hash;
    expect(out).toBeInstanceOf(FabricHash);
    expect(out.tag).toBe("sha256");
    expect(out.taggedHashString).toBe("sha256:abcd");
  });
});
