// What the one link traversal answers under the bounds its callers supply.
//
// These bounds were three walkers' hardcoded stop conditions; folding them
// left the bounds at the call sites and dropped the stop conditions that were
// not bounds at all. Each assertion here states a behaviour a caller can
// observe, so a later change to the traversal shows up as a failing test.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";

import { linksWithPaths } from "../decode.ts";

/** A link in the legacy at-rest sigil form. */
const linkTo = (id: string) => ({ "/": { "link@1": { id } } });

/** A value nested `depth` objects deep, holding `leaf` at the bottom. */
const nest = (depth: number, leaf: FabricValue): FabricValue =>
  depth === 0 ? leaf : { down: nest(depth - 1, leaf) };

/** A class instance carrying an enumerable own property. A restored
 * `FabricValue` instance carries its state in private fields instead, which
 * is why reading the enumerable ones is a partial read either way. */
class Instance {
  held: FabricValue;
  constructor(held: FabricValue) {
    this.held = held;
  }
}

/** The graph, space-signal and cross-space bounds: twelve deep, no node cap. */
const walk = (v: FabricValue, maxDepth = 12) =>
  linksWithPaths(v, { maxDepth, maxNodes: Number.POSITIVE_INFINITY });

/** The entity listing's link count: eight deep, no node cap. */
const count = (v: FabricValue) => walk(v, 8).links.length;

const ids = (v: FabricValue, maxDepth?: number) =>
  walk(v, maxDepth).links.map((f) => f.link.id);

describe("the link walk under its callers' bounds", () => {
  describe("what it finds", () => {
    it("returns a link that is the whole value", () => {
      expect(ids(linkTo("of:root"))).toEqual(["of:root"]);
    });

    it("descends objects and arrays, in the order it meets the links", () => {
      expect(
        ids({ a: linkTo("of:first"), b: ["skip", { c: linkTo("of:second") }] }),
      ).toEqual(["of:first", "of:second"]);
    });

    it("stops at a link, so a link inside a link's payload is not returned", () => {
      expect(
        ids({
          "/": { "link@1": { id: "of:outer", schema: linkTo("of:inner") } },
        }),
      ).toEqual(["of:outer"]);
    });

    it("reads a stream marker like any other object, so a link beside `$stream` is returned", () => {
      // The walkers this folds stopped here. A stream marker's canonical shape
      // is `{ $stream: true }` and holds no link, so the stop bought nothing;
      // where the value holds one too, stopping was a link dropped in silence.
      expect(ids({ $stream: true, held: linkTo("of:beside-the-marker") }))
        .toEqual(["of:beside-the-marker"]);
    });

    it("returns no link for an entity ref, whose one key holds a string", () => {
      // The walkers this folds stopped here too, and that stop changed no
      // answer: `{ "/": "of:…" }` has one key and a string under it.
      expect(ids({ "/": "of:referenced" })).toEqual([]);
    });

    it("returns a link on a class instance's own enumerable property", () => {
      // @ts-expect-error A class outside the data model is not a `FabricValue`.
      expect(ids(new Instance(linkTo("of:on-an-instance"))))
        .toEqual(["of:on-an-instance"]);
    });
  });

  describe("where it says it stopped", () => {
    it("names the path it refused as too deep, rather than returning silence", () => {
      // The CT-2113 complaint: a link the bound hid used to come back
      // indistinguishable from a value that holds no link.
      const hidden = walk(nest(13, linkTo("of:hidden")));
      const empty = walk({ nothing: "here" });
      expect(hidden.links).toEqual([]);
      expect(empty.links).toEqual([]);
      expect(hidden.tooDeep.length).toBe(1);
      expect(empty.tooDeep).toEqual([]);
    });

    it("names the path of a value it read only in part", () => {
      // @ts-expect-error A class outside the data model is not a `FabricValue`.
      const found = walk({ outer: new Instance(linkTo("of:on-an-instance")) });
      expect(found.opaque).toEqual([["outer"]]);
      // Read in part, not skipped: the enumerable property was walked.
      expect(found.links.map((f) => f.at)).toEqual([["outer", "held"]]);
    });

    it("names no partial read for a value of plain records and arrays", () => {
      expect(walk({ a: [{ b: linkTo("of:plain") }] }).opaque).toEqual([]);
    });
  });

  describe("the bounds the callers supply", () => {
    it("reaches a link at the graph and space-signal depth, and not one deeper", () => {
      expect(ids(nest(12, linkTo("of:deep")))).toEqual(["of:deep"]);
      expect(ids(nest(13, linkTo("of:deeper")))).toEqual([]);
    });

    it("reaches a link at the listing-count depth, and not one deeper", () => {
      expect(count(nest(8, linkTo("of:deep")))).toBe(1);
      expect(count(nest(9, linkTo("of:deeper")))).toBe(0);
    });

    it("counts every link it meets in objects and arrays", () => {
      expect(
        count({
          a: linkTo("of:first"),
          b: ["skip", { c: linkTo("of:second") }],
        }),
      ).toBe(2);
    });

    it("gives the two depths the same answer for a value inside both", () => {
      const value = { a: linkTo("of:one"), b: { c: linkTo("of:two") } };
      expect(count(value)).toBe(walk(value).links.length);
    });

    it("gives the two depths different answers between the bounds", () => {
      // Two bounds, one traversal: the answers differ where the bounds do and
      // nowhere else, which is the property the fold buys.
      const value = nest(10, linkTo("of:between-the-bounds"));
      expect(walk(value).links.length).toBe(1);
      expect(count(value)).toBe(0);
      expect(walk(value, 8).tooDeep.length).toBe(1);
    });
  });
});
