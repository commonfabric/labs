/**
 * `toURI()` and `fromURI()` are not a round trip in both directions: the
 * scheme carries the entity kind and `fromURI()` strips it, so a bare hash
 * re-minted through `toURI()` names the `of:` sibling of the `computed:` id it
 * came from rather than that id itself.
 *
 * What `toURI()` accepts also depends on the modern-cell-rep regime. A bare
 * `{ "/": … }` is a content-id reference in the legacy form and never one in
 * the modern form, where it is refused rather than mishandled, so the cases
 * that turn on the distinction set the flag rather than assuming a default.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { hashOf } from "@commonfabric/data-model";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import {
  entityRefFrom,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { fromURI, toURI } from "../src/uri-utils.ts";

const hash = hashOf({ causal: { test: "uri-utils" } });
const tagged = hash.taggedHashString;

describe("toURI", () => {
  afterEach(() => {
    resetModernCellRepConfig();
  });

  // The live id form (an `EntityId`/`createRef` result) is a `FabricHash` in
  // either regime, so it must convert the same way regardless of the flag.
  for (const modernCellRep of [false, true]) {
    it(`converts a FabricHash (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      expect(toURI(hash)).toBe(`of:${tagged}`);
    });

    it(`converts the active-regime serialized ref (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      // `entityRefFrom` yields the regime's serialized form: the `{ "/": … }`
      // object in legacy mode, the `FabricHash` itself in modern mode.
      expect(toURI(entityRefFrom(hash))).toBe(`of:${tagged}`);
    });
  }

  it('converts the legacy `{ "/": … }` object in legacy mode', () => {
    setModernCellRepConfig(false);
    expect(toURI({ "/": tagged })).toBe(`of:${tagged}`);
  });

  it('rejects a `{ "/": … }` object in modern mode', () => {
    // Per the modern-cell-rep invariant, every stored/wire content-id hash is a
    // `FabricHash`, so a bare `{ "/": … }` is never a content-id ref in modern
    // mode — it is not recognized, and so is rejected rather than mishandled.

    setModernCellRepConfig(true);
    expect(() => toURI({ "/": tagged })).toThrow();
  });

  it("passes through an already-prefixed `of:` URI", () => {
    expect(toURI(`of:${tagged}`)).toBe(`of:${tagged}`);
  });

  it("passes through a `data:` URI", () => {
    const uri = "data:application/vnd.common-fabric.data,e30";
    expect(toURI(uri)).toBe(uri);
  });

  it("prefixes a bare id string", () => {
    expect(toURI("bare-id")).toBe("of:bare-id");
  });

  it("rejects a non-`of:`/`data:` prefixed string", () => {
    expect(() => toURI("http:example")).toThrow();
  });

  it("rejects a value that is not an id", () => {
    expect(() => toURI({ not: "an id" })).toThrow();
  });
});

describe("toURI with an entity kind (computed: scheme)", () => {
  afterEach(() => {
    resetModernCellRepConfig();
  });

  it("prefixes a FabricHash with computed: for kind 'computed'", () => {
    expect(toURI(hash, "computed")).toBe(`computed:${tagged}`);
  });

  for (const modernCellRep of [false, true]) {
    it(`prefixes the serialized ref (modernCellRep=${modernCellRep})`, () => {
      setModernCellRepConfig(modernCellRep);
      expect(toURI(entityRefFrom(hash), "computed")).toBe(
        `computed:${tagged}`,
      );
    });
  }

  it("prefixes a bare id string with computed:", () => {
    expect(toURI("bare-id", "computed")).toBe("computed:bare-id");
  });

  it("passes through an already-prefixed computed: URI (no kind)", () => {
    expect(toURI(`computed:${tagged}`)).toBe(`computed:${tagged}`);
  });

  it("throws on kind + already-schemed string", () => {
    // `kind` is a minting-time argument; a schemed string is an already-minted
    // identity — never re-scheme it, even when the scheme matches.

    expect(() => toURI(`of:${tagged}`, "computed")).toThrow(
      /already-schemed/,
    );
    expect(() => toURI(`computed:${tagged}`, "computed")).toThrow(
      /already-schemed/,
    );
  });
});

describe("fromURI", () => {
  it("round-trips toURI for both entity schemes", () => {
    expect(fromURI(toURI(hash))).toBe(tagged);
    expect(fromURI(toURI(hash, "computed"))).toBe(tagged);
  });

  it("strips of: and computed: prefixes", () => {
    expect(fromURI(`of:${tagged}`)).toBe(tagged);
    expect(fromURI(`computed:${tagged}`)).toBe(tagged);
  });

  it("passes through a colon-free bare id", () => {
    expect(fromURI("bare-id")).toBe("bare-id");
  });

  it("rejects unknown schemes", () => {
    expect(() => fromURI(`future:${tagged}`)).toThrow(/Invalid URI/);
  });

  it("is one-way for computed: ids (bare hash re-mints as of:)", () => {
    // The scheme is part of the identity: stripping it loses the kind, so a
    // bare-hash round-trip through toURI renames a computed: id to its of:
    // sibling. Documented one-way — never rebuild a computed URI from its
    // bare hash (the salted preimage keeps the BYTES distinct, but the
    // resulting URI names the wrong-scheme entity).

    const bare = fromURI(`computed:${tagged}`);
    expect(toURI(FabricHash.fromString(bare))).toBe(`of:${tagged}`);
  });
});
