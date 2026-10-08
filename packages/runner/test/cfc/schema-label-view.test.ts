/**
 * The labels a schema's `ifc` declarations put on a document, and which of
 * them a runtime persisting flow labels mints as store policy. A clause only
 * a producer's input join put in a schema (`ifc.inputConfidentiality`) stands
 * in for the measurement of what the producer writes, so where that
 * measurement persists, a position holding nothing else is left to it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "../../src/builder/types.ts";
import {
  cfcSchemaEntries,
  persistedSchemaEntryLabel,
} from "../../src/cfc/schema-label-view.ts";

const persistedAt = (
  schema: JSONSchema,
  path: readonly string[],
  measured: boolean,
) => {
  const entries = cfcSchemaEntries(schema);
  const entry = entries.find((candidate) =>
    candidate.path.join("/") === path.join("/")
  );
  expect(entry).toBeDefined();
  return persistedSchemaEntryLabel(entry!, entries, measured);
};

describe("schema-label-view", () => {
  describe("cfcSchemaEntries()", () => {
    it("names the clauses an entry holds only as an input join", () => {
      const [entry] = cfcSchemaEntries({
        type: "string",
        ifc: { confidentiality: ["x", "y"], inputConfidentiality: ["x"] },
      });
      expect(entry.label.confidentiality).toEqual(["x", "y"]);
      expect(entry.inputConfidentiality).toEqual(["x"]);
    });

    it("names no input join for an entry whose schema names none", () => {
      const [entry] = cfcSchemaEntries({
        type: "string",
        ifc: { confidentiality: ["x"] },
      });
      expect(entry.inputConfidentiality).toBeUndefined();
    });
  });

  describe("persistedSchemaEntryLabel()", () => {
    const joined: JSONSchema = {
      type: "string",
      ifc: { confidentiality: ["x", "y"], inputConfidentiality: ["x", "y"] },
    };

    it("leaves out a position that holds only an input join, where what the producer writes is measured", () => {
      expect(persistedAt(joined, [], true)).toEqual({});
    });

    it("keeps an input join where nothing measures what the producer writes", () => {
      expect(persistedAt(joined, [], false).confidentiality).toEqual([
        "x",
        "y",
      ]);
    });

    it("keeps the whole label of a position that declares a clause of its own", () => {
      const schema: JSONSchema = {
        type: "string",
        ifc: { confidentiality: ["x", "y"], inputConfidentiality: ["x"] },
      };
      expect(persistedAt(schema, [], true).confidentiality).toEqual([
        "x",
        "y",
      ]);
    });

    it("keeps the whole label of a position that declares integrity", () => {
      const schema: JSONSchema = {
        type: "string",
        ifc: {
          confidentiality: ["x"],
          inputConfidentiality: ["x"],
          integrity: ["z"],
        },
      };
      expect(persistedAt(schema, [], true)).toEqual({
        confidentiality: ["x"],
        integrity: ["z"],
      });
    });

    it("keeps a clause an ancestor declares, which the entry would otherwise replace", () => {
      const schema: JSONSchema = {
        type: "object",
        ifc: { confidentiality: ["x"] },
        properties: {
          a: {
            type: "string",
            ifc: { confidentiality: ["x"], inputConfidentiality: ["x"] },
          },
        },
      };
      expect(persistedAt(schema, ["a"], true).confidentiality).toEqual(["x"]);
    });

    it("keeps a clause an ancestor declares in another order of its alternatives", () => {
      const schema: JSONSchema = {
        type: "object",
        ifc: { confidentiality: [{ anyOf: ["a", "b"] }] },
        properties: {
          a: {
            type: "string",
            ifc: {
              confidentiality: [{ anyOf: ["b", "a"] }],
              inputConfidentiality: [{ anyOf: ["b", "a"] }],
            },
          },
        },
      };
      expect(persistedAt(schema, ["a"], true).confidentiality).toEqual([
        { anyOf: ["b", "a"] },
      ]);
    });

    it("keeps a clause a declaration at the same path declares", () => {
      const schema: JSONSchema = {
        allOf: [
          {
            type: "string",
            ifc: { confidentiality: ["x"], inputConfidentiality: ["x"] },
          },
          { type: "string", ifc: { confidentiality: ["x"] } },
        ],
      };
      const entries = cfcSchemaEntries(schema);
      const marked = entries.find((entry) =>
        entry.inputConfidentiality !== undefined
      );
      expect(marked).toBeDefined();
      expect(persistedSchemaEntryLabel(marked!, entries, true).confidentiality)
        .toEqual(["x"]);
    });

    it("leaves out a position whose clause only a descendant declares", () => {
      // A descendant's declaration labels the descendant, which its own entry
      // persists; it says nothing about the rest of the value.
      const schema: JSONSchema = {
        type: "object",
        ifc: { confidentiality: ["x"], inputConfidentiality: ["x"] },
        properties: {
          a: { type: "string", ifc: { confidentiality: ["x"] } },
        },
      };
      expect(persistedAt(schema, [], true).confidentiality).toBeUndefined();
      expect(persistedAt(schema, ["a"], true).confidentiality).toEqual(["x"]);
    });
  });
});
