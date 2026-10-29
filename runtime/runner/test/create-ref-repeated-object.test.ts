import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { deepFreeze } from "@commonfabric/data-model";

import { createRef } from "../src/create-ref.ts";
import { toURI } from "../src/uri-utils.ts";

describe("create-ref-repeated-object", () => {
  // A derived id depends on which objects a cause shares as well as on what
  // the cause holds: the walk hashes an object it reaches a second time as
  // `null`. Stored documents are addressed by ids derived this way, so the
  // objects of a value that reaches a cause have to stay as shared, or as
  // separate, as they are.

  const schema = () => ({
    type: "object",
    properties: { title: { type: "string" } },
  });

  it("derives one id for two causes holding equal objects at the same places", () => {
    const first = createRef({}, { argument: schema(), result: schema() });
    const second = createRef({}, { argument: schema(), result: schema() });
    expect(toURI(second)).toBe(toURI(first));
  });

  it("derives another id for a cause holding one object at two places", () => {
    const shared = schema();
    const twice = createRef({}, { argument: shared, result: shared });
    const equal = createRef({}, { argument: schema(), result: schema() });
    expect(toURI(twice)).not.toBe(toURI(equal));
  });

  it("derives the id of a cause holding `null` where an object is reached again", () => {
    const shared = schema();
    const twice = createRef({}, { argument: shared, result: shared });
    const nulled = createRef({}, { argument: schema(), result: null });
    expect(toURI(twice)).toBe(toURI(nulled));
  });

  it("derives one id for a deep-frozen cause and an equal mutable one", () => {
    const frozen = createRef(
      {},
      deepFreeze({ argument: schema(), result: schema() }),
    );
    const mutable = createRef({}, { argument: schema(), result: schema() });
    expect(toURI(frozen)).toBe(toURI(mutable));
  });
});
