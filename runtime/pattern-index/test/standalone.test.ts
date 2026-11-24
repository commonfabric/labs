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
  });
});
