import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import {
  cloneWithoutBoundToolKeys,
  isPatternToolSchema,
  isPatternToolValue,
  verbsFromCompiledPattern,
} from "../src/verb-listing.ts";

describe("verb-listing", () => {
  describe("isPatternToolValue()", () => {
    it("returns `true` for a pattern beside the parameters it binds", () => {
      expect(isPatternToolValue({
        pattern: { argumentSchema: { type: "object" } },
        extraParams: {},
      })).toBe(true);
    });

    it("returns `false` where the pattern is not an object", () => {
      expect(isPatternToolValue({ pattern: "main.tsx", extraParams: {} }))
        .toBe(false);
    });

    it("returns `false` for an object that is no pattern", () => {
      expect(isPatternToolValue({ pattern: { name: "x" }, extraParams: {} }))
        .toBe(false);
    });

    it("returns `false` without bound parameters", () => {
      expect(isPatternToolValue({ pattern: { nodes: [] } })).toBe(false);
    });
  });

  describe("isPatternToolSchema()", () => {
    it("returns `true` where the pattern is declared a cell", () => {
      expect(isPatternToolSchema({
        type: "object",
        properties: { pattern: { asCell: ["cell"] }, extraParams: {} },
      })).toBe(true);
    });

    it("returns `true` where the pattern is declared by its fields", () => {
      expect(isPatternToolSchema({
        type: "object",
        properties: {
          pattern: { type: "object", properties: { nodes: {} } },
          extraParams: {},
        },
      })).toBe(true);
    });

    it("returns `false` where the pattern's schema is a boolean", () => {
      expect(isPatternToolSchema({
        type: "object",
        properties: { pattern: true, extraParams: {} },
      })).toBe(false);
    });

    it("returns `false` where the pattern's schema declares no pattern", () => {
      expect(isPatternToolSchema({
        type: "object",
        properties: {
          pattern: { type: "object", properties: { name: {} } },
          extraParams: {},
        },
      })).toBe(false);
    });
  });

  describe("cloneWithoutBoundToolKeys()", () => {
    it("returns the schema less `result` and every bound parameter", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          result: { type: "string" },
        },
        required: ["query", "limit", "result"],
      };

      expect(cloneWithoutBoundToolKeys(schema, { limit: 5 })).toEqual({
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      });
      expect(Object.keys(schema.properties!)).toEqual([
        "query",
        "limit",
        "result",
      ]);
    });

    it("returns a schema that is no object schema unchanged", () => {
      const scalar: JSONSchema = { type: "string" };

      expect(cloneWithoutBoundToolKeys(true, { limit: 5 })).toBe(true);
      expect(cloneWithoutBoundToolKeys(scalar, { limit: 5 })).toBe(scalar);
    });

    it("returns an object schema that declares no properties unchanged", () => {
      const open: JSONSchema = { type: "object" };

      expect(cloneWithoutBoundToolKeys(open, { limit: 5 })).toBe(open);
    });
  });

  describe("verbsFromCompiledPattern()", () => {
    /** A link a compiled pattern writes, naming the cell `cause` makes. */
    const alias = (cause: string) => ({
      $alias: { partialCause: cause, path: [] },
    });

    /** A tool as `patternTool` builds one inline, binding `limit`. */
    const searchTool = {
      pattern: {
        argumentSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
            result: { type: "string" },
          },
          required: ["query", "limit"],
        },
        resultSchema: { type: "string" },
      },
      extraParams: { limit: 5 },
    };

    it("returns a tool the result graph holds, less the parameters it binds", () => {
      expect(verbsFromCompiledPattern({ result: { search: searchTool } }))
        .toEqual([{
          name: "search",
          kind: "tool",
          on: "result",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          outputSchema: { type: "string" },
        }]);
    });

    it("returns a tool only the declared result names as unconstrained, with its prose", () => {
      expect(verbsFromCompiledPattern({
        resultSchema: {
          type: "object",
          properties: {
            search: {
              type: "object",
              description: "Searches the notes.",
              properties: { pattern: { asCell: ["cell"] }, extraParams: {} },
            },
          },
        },
      })).toEqual([{
        name: "search",
        kind: "tool",
        on: "result",
        inputSchema: true,
        description: "Searches the notes.",
      }]);
    });

    it("returns a handler the result graph wires and the declared type omits, with the module's contract and result", () => {
      expect(verbsFromCompiledPattern({
        result: { increment: alias("increment"), count: alias("count") },
        nodes: [
          {
            inputs: { $event: alias("increment") },
            module: {
              resultSchema: { type: "number" },
              argumentSchema: {
                type: "object",
                properties: {
                  $event: {
                    type: "object",
                    properties: { by: { type: "number" } },
                  },
                },
              },
            },
          },
          { inputs: { value: alias("count") }, module: {} },
          "not a node",
        ],
      })).toEqual([{
        name: "increment",
        kind: "handler",
        on: "result",
        inputSchema: { type: "object", properties: { by: { type: "number" } } },
        outputSchema: { type: "number" },
      }]);
    });

    it("returns an unconstrained handler for a wired stream whose module declares no event", () => {
      expect(verbsFromCompiledPattern({
        result: { reset: alias("reset") },
        nodes: [{ inputs: { $event: alias("reset") }, module: {} }],
      })).toEqual([{
        name: "reset",
        kind: "handler",
        on: "result",
        inputSchema: true,
      }]);
    });

    it("returns the streams the declared argument marks, with their prose and marks", () => {
      expect(verbsFromCompiledPattern({
        argumentSchema: {
          type: "object",
          properties: {
            clear: {
              asCell: ["stream"],
              description: "Clears the list.",
              tier: "wrapper",
              deprecated: true,
            },
            items: { type: "array" },
          },
        },
      })).toEqual([{
        name: "clear",
        kind: "handler",
        on: "input",
        inputSchema: {},
        description: "Clears the list.",
        tier: "wrapper",
        deprecated: true,
      }]);
    });

    it("returns the result's row where the argument declares a stream of the same name", () => {
      const verbs = verbsFromCompiledPattern({
        resultSchema: {
          type: "object",
          properties: { clear: { asCell: ["stream"] } },
        },
        argumentSchema: {
          type: "object",
          properties: { clear: { asCell: ["stream"] }, open: true },
        },
      });

      expect(verbs.map(({ name, on }) => ({ name, on }))).toEqual([
        { name: "clear", on: "result" },
      ]);
    });

    it("returns an unconstrained event for a declared verb whose reference does not resolve", () => {
      expect(verbsFromCompiledPattern({
        resultSchema: {
          type: "object",
          properties: {
            send: { $ref: "#/$defs/Missing", asCell: ["stream"] },
          },
        },
      })).toEqual([{
        name: "send",
        kind: "handler",
        on: "result",
        inputSchema: true,
      }]);
    });

    it("returns rows in byte order of their names", () => {
      const stream = { asCell: ["stream"] };
      const verbs = verbsFromCompiledPattern({
        resultSchema: {
          type: "object",
          properties: { b: stream, a: stream, Z: stream },
        },
      });

      expect(verbs.map((verb) => verb.name)).toEqual(["Z", "a", "b"]);
    });

    it("returns no rows for a pattern that declares no object", () => {
      expect(verbsFromCompiledPattern({ resultSchema: true, result: "x" }))
        .toEqual([]);
      expect(verbsFromCompiledPattern({
        resultSchema: { $ref: "#/$defs/Label", $defs: { Label: true } },
      })).toEqual([]);
    });

    it("matches a wired handler by whole-link equality where the links are no aliases", () => {
      const verbs = verbsFromCompiledPattern({
        result: { ping: { cell: "ping" }, pong: { cell: "pong" } },
        nodes: [{
          inputs: { $event: { cell: "ping" } },
          module: { argumentSchema: { properties: { $event: true } } },
        }],
      });

      expect(verbs).toEqual([{
        name: "ping",
        kind: "handler",
        on: "result",
        inputSchema: true,
      }]);
    });

    it("returns no tool for a declared pattern whose schema has no properties", () => {
      expect(verbsFromCompiledPattern({
        resultSchema: {
          type: "object",
          properties: {
            search: {
              type: "object",
              properties: { pattern: { type: "object" }, extraParams: {} },
            },
          },
        },
      })).toEqual([]);
    });
  });
});
