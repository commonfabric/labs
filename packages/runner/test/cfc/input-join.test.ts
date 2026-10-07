/**
 * The input join a schema's confidentiality holds. Every function under test
 * keeps `ifc.inputConfidentiality` a subset of `ifc.confidentiality` holding
 * no clause any source declares, comparing clauses in their normal form.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  confidentialitySources,
  holdsClause,
  ifcConfidentialitySources,
  inputJoinOf,
  withInputJoin,
} from "../../src/cfc/input-join.ts";

describe("input-join", () => {
  describe("holdsClause()", () => {
    it("matches a disjunction whatever the order of its alternatives", () => {
      expect(holdsClause([{ anyOf: ["a", "b"] }], { anyOf: ["b", "a"] }))
        .toBe(true);
    });

    it("does not match a clause the list lacks", () => {
      expect(holdsClause(["a"], "b")).toBe(false);
    });
  });

  describe("ifcConfidentialitySources()", () => {
    it("splits the named clauses from the declared ones", () => {
      expect(
        ifcConfidentialitySources({
          confidentiality: ["x", "y"],
          inputConfidentiality: ["x"],
        }),
      ).toEqual({ inputJoin: ["x"], declared: ["y"] });
    });

    it("ignores a named clause the confidentiality does not hold", () => {
      expect(
        ifcConfidentialitySources({
          confidentiality: ["y"],
          inputConfidentiality: ["x"],
        }),
      ).toEqual({ inputJoin: [], declared: ["y"] });
    });

    it("treats an ifc that names nothing as declared throughout", () => {
      expect(ifcConfidentialitySources({ confidentiality: ["x"] })).toEqual({
        inputJoin: [],
        declared: ["x"],
      });
    });
  });

  describe("inputJoinOf()", () => {
    it("keeps a joined clause no source declares, once", () => {
      expect(
        inputJoinOf([
          confidentialitySources(["x", "y"], true),
          confidentialitySources(["x"], true),
        ]),
      ).toEqual(["x", "y"]);
    });

    it("drops a joined clause any source declares", () => {
      expect(
        inputJoinOf([
          confidentialitySources(["x", "y"], true),
          confidentialitySources([{ anyOf: ["b", "a"] }, "y"], false),
        ]),
      ).toEqual(["x"]);
    });
  });

  describe("withInputJoin()", () => {
    it("names the input join beside the confidentiality given", () => {
      expect(
        withInputJoin({ integrity: ["i"] }, ["x", "y"], [
          confidentialitySources(["x"], true),
          confidentialitySources(["y"], false),
        ]),
      ).toEqual({
        integrity: ["i"],
        confidentiality: ["x", "y"],
        inputConfidentiality: ["x"],
      });
    });

    it("names nothing the confidentiality does not hold", () => {
      expect(
        withInputJoin(undefined, ["y"], [confidentialitySources(["x"], true)]),
      ).toEqual({ confidentiality: ["y"] });
    });

    it("drops a name the ifc held once every clause is declared", () => {
      expect(
        withInputJoin(
          { confidentiality: ["x"], inputConfidentiality: ["x"] },
          ["x"],
          [confidentialitySources(["x"], false)],
        ),
      ).toEqual({ confidentiality: ["x"] });
    });
  });
});
