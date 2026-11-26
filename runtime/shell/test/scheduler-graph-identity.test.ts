import { expect } from "@std/expect";
import { entityUriFromActionId } from "../src/lib/scheduler-graph-identity.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("entityUriFromActionId()", () => {
  it("returns `undefined` when the entity segment carries no scheme", () => {
    const actionId = "sink:did:key:test/fid1:same-hash-bytes/value";

    expect(entityUriFromActionId(actionId)).toBeUndefined();
  });
});
