/**
 * The sealed-position addressing walk: the positions the sanitizer reports
 * having sealed become the address `buildRef` states for their path, and
 * everything else — including a caller-provided opaque link the sanitizer
 * preserved, which `sealedPaths` never lists — passes through untouched.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { addressSealedPositions } from "../src/structured-result.ts";
import { sealedPositionLink } from "../src/tools/run-pattern.ts";

const SPACE =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" as Parameters<
    typeof sealedPositionLink
  >[2];

const seal = (fragment: string) => ({
  "@link": `opaque:run-1%3Arun_pattern%3A3${fragment}`,
});
const buildRef = (path: readonly (string | number)[]) =>
  `/of:fid1:result/${path.join("/")}`;

describe("structured-result", () => {
  it("addresses sealed positions without changing literal path keys", () => {
    const id = `of:fid1:${"a".repeat(43)}` as const;
    const path = ["", "..", "a#argument", "a/b", "title "];
    const sealed = sealedPositionLink(
      { id, space: SPACE, scope: "space", path: ["entries"] },
      path,
      SPACE,
    );
    expect(sealed).toBeDefined();
    const parsed = parseLLMFriendlyLink(sealed!["@link"], SPACE);
    expect(parsed.id).toBe(id);
    expect(parsed.path).toEqual(["entries", ...path]);
  });

  describe("addressSealedPositions()", () => {
    it("replaces each reported position with the address of its path", () => {
      const value = {
        count: 2,
        entries: [seal("#/entries/0"), seal("#/entries/1")],
        label: seal("#/label"),
      };
      const sealedPaths = [["entries", 0], ["entries", 1], ["label"]];
      expect(addressSealedPositions(value, sealedPaths, buildRef)).toEqual({
        count: 2,
        entries: ["/of:fid1:result/entries/0", "/of:fid1:result/entries/1"],
        label: "/of:fid1:result/label",
      });
    });

    it("addresses a sealed root as the reference itself", () => {
      expect(
        addressSealedPositions(seal(""), [[]], () => "/of:fid1:result"),
      ).toBe("/of:fid1:result");
    });

    it("replaces only the reported position, leaving a same-handle-id preserved link intact", () => {
      // A caller-provided opaque link the schema admits is preserved by the
      // sanitizer — even one spelled with the sanitization's own handle id —
      // and does not appear in sealedPaths. Only the minted sibling, which
      // does, becomes an address.
      const value = {
        evidence: seal("#/evidence"),
        note: seal("#/note"),
        n: 1,
      };
      expect(addressSealedPositions(value, [["note"]], buildRef)).toEqual({
        evidence: seal("#/evidence"),
        note: "/of:fid1:result/note",
        n: 1,
      });
    });

    it("keeps the seal when the position's link cannot be stated", () => {
      // sealedPositionLink answers undefined for a link the grammar cannot
      // state at all, not only one it round-trips wrongly.
      expect(sealedPositionLink(
        {
          id: "not-an-entity-address",
          path: [],
          space: SPACE,
        } as unknown as Parameters<typeof sealedPositionLink>[0],
        ["label"],
        SPACE,
      )).toBeUndefined();
    });

    it("keeps the seal where buildRef answers undefined", () => {
      // A path the link grammar cannot round-trip gets no address; the seal
      // stays, because no reference beats a reference to the wrong cell.
      const value = { a: seal("#/a"), b: seal("#/b") };
      expect(
        addressSealedPositions(
          value,
          [["a"], ["b"]],
          (path) => path[0] === "a" ? "/of:fid1:result/a" : undefined,
        ),
      ).toEqual({ a: "/of:fid1:result/a", b: seal("#/b") });
    });

    it("leaves the value unchanged for a path it does not hold", () => {
      const value = { list: [true], nested: { x: 1 }, n: 7 };
      expect(
        addressSealedPositions(value, [
          ["list", 5],
          ["nested", "y"],
          ["n", "x"],
        ], buildRef),
      ).toEqual(value);
    });
  });
});
