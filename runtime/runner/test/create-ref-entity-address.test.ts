import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";

import { entityIdFrom, idStringForEntityAddress } from "../src/create-ref.ts";
import { toURI } from "../src/uri-utils.ts";

describe("idStringForEntityAddress()", () => {
  // What the function does is composed from `entityIdFrom` and `toURI` rather
  // than decided again, so these cases pin the contract a caller reads off the
  // name — which addresses become an id and which come back as they were —
  // rather than checking one implementation of a rule against another. There
  // is no second implementation left to disagree with.

  const hash = hashOf({ probe: "entity address" }).toString();

  it("returns the `of:` id over a bare tagged hash", () => {
    expect(idStringForEntityAddress(hash)).toBe(`of:${hash}`);
  });

  it("returns an `of:` id unchanged", () => {
    expect(idStringForEntityAddress(`of:${hash}`)).toBe(`of:${hash}`);
  });

  it("returns a kinded id unchanged", () => {
    // `computed:fid1:<hash>` names an entity of its own, and the bare hash
    // under it names that entity's `of:` sibling, so there is nothing here to
    // normalize toward.
    expect(idStringForEntityAddress(`computed:${hash}`)).toBe(
      `computed:${hash}`,
    );
  });

  it("returns an id under another subject's scheme unchanged", () => {
    // The schemes this runtime mints entity ids under are not every scheme an
    // id can carry. A `cid:` schema document and a `data:` URI are ids in
    // their own right, and scheming one builds an id nothing holds — so a
    // lookup keyed on the result would report a document that is there as
    // absent. `runtime/fuse` reads entity directory names into that lookup,
    // and the ids it reads are every kind the space holds.
    expect(idStringForEntityAddress(`cid:${hash}`)).toBe(`cid:${hash}`);
    expect(idStringForEntityAddress("data:application/json,{}")).toBe(
      "data:application/json,{}",
    );
    expect(idStringForEntityAddress("did:key:z6MkExample")).toBe(
      "did:key:z6MkExample",
    );
  });

  it("returns a string that addresses nothing unchanged", () => {
    expect(idStringForEntityAddress("my-board")).toBe("my-board");
    expect(idStringForEntityAddress("")).toBe("");
  });

  it("returns the id of the canonical spelling for a padded hash", () => {
    // A padded hash addresses the same entity its unpadded spelling does, and
    // the id that comes back is that entity's. This is the half of the
    // contract that only holds because the answer is composed from the read
    // path: a caller asking about `fid1:AA==` is asking about the document a
    // read of `fid1:AA==` would reach.
    expect(idStringForEntityAddress("fid1:AA==")).toBe("of:fid1:AA");
  });

  it("returns the id a read of the same address reaches", () => {
    // The property the function exists for, over the one address where both
    // sides can be built: what a lookup is asked about, and what a read
    // addresses, are one string. `Runtime.getCellFromEntityId` composes the
    // same pair, which is what carries this to the cells a read returns.
    expect(idStringForEntityAddress(hash)).toBe(toURI(entityIdFrom(hash)));
  });
});
