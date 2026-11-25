import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { inputsNeededToRun } from "../src/standalone.ts";

describe("standalone", () => {
  describe("inputsNeededToRun()", () => {
    it("returns the required inputs that carry no default, in schema order", () => {
      expect(inputsNeededToRun({
        type: "object",
        properties: {
          title: { type: "string", default: "" },
          items: { type: "array" },
          owner: { type: "string" },
        },
        required: ["title", "items", "owner"],
      })).toEqual(["items", "owner"]);
    });

    it("returns none for a schema whose inputs are all optional or defaulted", () => {
      expect(inputsNeededToRun({
        type: "object",
        properties: {
          count: { type: "number", default: 0 },
          loomId: { type: "string" },
        },
        required: ["count"],
      })).toEqual([]);
    });

    it("returns none for an input the object's own default fills in", () => {
      expect(inputsNeededToRun({
        type: "object",
        properties: { ids: { type: "array" } },
        required: ["ids"],
        default: { ids: [] },
      })).toEqual([]);
    });

    it("returns none for a boolean schema", () => {
      expect(inputsNeededToRun(true)).toEqual([]);
      expect(inputsNeededToRun(false)).toEqual([]);
    });

    it("returns a required input with no schema of its own, or a `true` one", () => {
      expect(inputsNeededToRun({
        type: "object",
        properties: { anything: true },
        required: ["anything", "unnamed"],
      })).toEqual(["anything", "unnamed"]);
    });

    it("reads a default through a `$ref` into `$defs`, on either side of it", () => {
      expect(inputsNeededToRun({
        type: "object",
        $defs: {
          Clock: { type: "number", default: 0 },
          Host: { type: "string" },
        },
        properties: {
          clock: { $ref: "#/$defs/Clock" },
          host: { $ref: "#/$defs/Host", default: "local" },
          guest: { $ref: "#/$defs/Host" },
          missing: { $ref: "#/$defs/Missing" },
        },
        required: ["clock", "host", "guest", "missing"],
      })).toEqual(["guest", "missing"]);
    });

    it("reads a root schema that is a `$ref` into its own `$defs`", () => {
      expect(inputsNeededToRun({
        $ref: "#/$defs/Input",
        $defs: {
          Input: {
            type: "object",
            properties: { ids: { type: "array" } },
            required: ["ids"],
          },
        },
      })).toEqual(["ids"]);
    });

    it("reads through a `$ref` to a definition that is itself a `$ref`", () => {
      expect(inputsNeededToRun({
        $ref: "#/$defs/Alias",
        $defs: {
          Alias: { $ref: "#/$defs/Input" },
          Input: {
            type: "object",
            properties: {
              ids: { type: "array" },
              clock: { $ref: "#/$defs/Clock" },
            },
            required: ["ids", "clock"],
          },
          Clock: { $ref: "#/$defs/Zero" },
          Zero: { type: "number", default: 0 },
        },
      })).toEqual(["ids"]);
    });

    it("returns from `$ref`s that name each other instead of hanging", () => {
      expect(inputsNeededToRun({
        type: "object",
        $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } },
        properties: { loop: { $ref: "#/$defs/A" } },
        required: ["loop"],
      })).toEqual(["loop"]);
    });

    it("returns a required input whose `$ref` points outside `$defs` or inside a definition", () => {
      expect(inputsNeededToRun({
        type: "object",
        $defs: {
          Clock: { type: "object", properties: { at: { default: 0 } } },
        },
        definitions: { Clock: { type: "number", default: 0 } },
        properties: {
          legacy: { $ref: "#/definitions/Clock" },
          nested: { $ref: "#/$defs/Clock/properties/at" },
        },
        required: ["legacy", "nested"],
      })).toEqual(["legacy", "nested"]);
    });

    it("reads a definition whose name the `$ref` escapes as a JSON Pointer", () => {
      expect(inputsNeededToRun({
        type: "object",
        $defs: { "Input/Value~1": { type: "number", default: 0 } },
        properties: { value: { $ref: "#/$defs/Input~1Value~01" } },
        required: ["value"],
      })).toEqual([]);
    });
  });
});
