import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { JSONSchema } from "@commonfabric/api";

import { classifyCallableEntry, isHandlerCell } from "../callables.ts";

describe("callables", () => {
  describe("isHandlerCell()", () => {
    it("returns what the value's `isStream()` returns", () => {
      expect(isHandlerCell({ isStream: () => true })).toBe(true);
      expect(isHandlerCell({ isStream: () => false })).toBe(false);
    });

    it("returns `false` when the value's `isStream()` throws", () => {
      expect(isHandlerCell({
        isStream: () => {
          throw new Error("not a cell");
        },
      })).toBe(false);
    });
  });

  describe("classifyCallableEntry()", () => {
    const toolSchema = {
      type: "object",
      properties: {
        pattern: {
          type: "object",
          properties: { argumentSchema: { type: "object" } },
        },
        extraParams: { type: "object" },
      },
    } as const satisfies JSONSchema;

    it("returns `tool` for a schema declaring a pattern and its bound parameters", () => {
      expect(classifyCallableEntry(undefined, toolSchema)).toBe("tool");
      expect(classifyCallableEntry({ title: "plain" }, toolSchema)).toBe(
        "tool",
      );
    });

    it("returns `null` for a schema declaring a pattern without bound parameters", () => {
      const { extraParams: _, ...properties } = toolSchema.properties;

      expect(
        classifyCallableEntry(undefined, { type: "object", properties }),
      ).toBeNull();
    });
  });
});
