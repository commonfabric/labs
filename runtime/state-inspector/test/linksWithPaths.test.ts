// The generic link traversal: what it finds, where it says the link sat, and
// where the caller's bounds stop it.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { linksWithPaths } from "../decode.ts";

/** A link in the legacy at-rest sigil form. */
const linkTo = (id: string) => ({ "/": { "link@1": { id } } });

/** Bounds that reach every value in these fixtures, so a test that pins a
 * bound sets only the one it is about. */
const unbounded = {
  maxDepth: Number.POSITIVE_INFINITY,
  maxNodes: Number.POSITIVE_INFINITY,
};

describe("linksWithPaths()", () => {
  it("returns the empty path for a link that is the whole value", () => {
    expect(linksWithPaths(linkTo("of:root"), unbounded).links).toEqual([
      { link: { id: "of:root" }, at: [] },
    ]);
  });

  it("returns one segment per key for a link nested in objects", () => {
    const found = linksWithPaths(
      { outer: { inner: linkTo("of:nested") } },
      unbounded,
    ).links;
    expect(found.map(({ link, at }) => [link.id, at])).toEqual([
      ["of:nested", ["outer", "inner"]],
    ]);
  });

  it("returns the index as a segment for a link nested in an array", () => {
    const found = linksWithPaths(
      { items: ["first", linkTo("of:second"), { deep: linkTo("of:third") }] },
      unbounded,
    ).links;
    expect(found.map(({ link, at }) => [link.id, at])).toEqual([
      ["of:second", ["items", "1"]],
      ["of:third", ["items", "2", "deep"]],
    ]);
  });

  it("returns a key containing `/` and `~` as a single segment", () => {
    const key = "a/b~c";
    const found = linksWithPaths({ [key]: linkTo("of:awkward") }, unbounded)
      .links;
    expect(found).toEqual([{ link: { id: "of:awkward" }, at: [key] }]);
    // The whole point of segment arrays: joined, this key is indistinguishable
    // from the two-segment path `["a", "b~c"]`.
    expect(found[0].at.length).toBe(1);
  });

  it("stops at `maxDepth`, so a link deeper than it is not returned", () => {
    const value = {
      a: { b: linkTo("of:at-two"), c: { d: linkTo("of:at-three") } },
    };
    const found = linksWithPaths(value, { ...unbounded, maxDepth: 2 });
    expect(found.links.map(({ link }) => link.id)).toEqual(["of:at-two"]);
  });

  it("reports the path it refused to descend to as too deep", () => {
    const value = {
      a: { b: linkTo("of:at-two"), c: { d: linkTo("of:at-three") } },
    };
    const found = linksWithPaths(value, { ...unbounded, maxDepth: 2 });
    // The path of the value it declined to visit, not of the container it
    // declined from: the container was read, and reported as holding no link.
    expect(found.tooDeep).toEqual([["a", "c", "d"]]);
    expect(found.budgetExhausted).toBe(false);
  });

  it("reports nothing stopped early for a walk that reached every value", () => {
    const found = linksWithPaths(
      { a: { b: linkTo("of:reached") } },
      unbounded,
    );
    expect(found.tooDeep).toEqual([]);
    expect(found.budgetExhausted).toBe(false);
  });

  it("stops at `maxNodes`, so a link past the budget is not returned", () => {
    const value = { a: linkTo("of:first"), b: linkTo("of:second") };
    // The root object is one node, and each of its two children is another.
    expect(
      linksWithPaths(value, { ...unbounded, maxNodes: 2 }).links.map((f) =>
        f.link.id
      ),
    ).toEqual(["of:first"]);
    expect(
      linksWithPaths(value, { ...unbounded, maxNodes: 3 }).links.map((f) =>
        f.link.id
      ),
    ).toEqual(["of:first", "of:second"]);
  });

  it("reports the budget as exhausted when a link is left past it", () => {
    const value = { a: linkTo("of:first"), b: linkTo("of:second") };
    const found = linksWithPaths(value, { ...unbounded, maxNodes: 2 });
    expect(found.budgetExhausted).toBe(true);
    // No path for what it missed: the walk stopped before enumerating what
    // was left, so `b` is not a path it can claim to have declined.
    expect(found.tooDeep).toEqual([]);
  });

  it("reports the budget as intact for a walk that spent all of it and finished", () => {
    const value = { a: linkTo("of:first"), b: linkTo("of:second") };
    expect(
      linksWithPaths(value, { ...unbounded, maxNodes: 3 }).budgetExhausted,
    ).toBe(false);
  });

  it("reports an exhausted budget rather than a depth stop when both bounds bite", () => {
    const value = { a: { b: { c: linkTo("of:deep") } } };
    const found = linksWithPaths(value, { maxDepth: 1, maxNodes: 2 });
    expect(found.links).toEqual([]);
    expect(found.budgetExhausted).toBe(true);
    expect(found.tooDeep).toEqual([]);
  });

  it("stops at each link, so a link-shaped value inside a link is not walked", () => {
    const found = linksWithPaths(
      { "/": { "link@1": { id: "of:outer", schema: linkTo("of:inner") } } },
      unbounded,
    );
    expect(found.links.map(({ link }) => link.id)).toEqual(["of:outer"]);
  });
});
