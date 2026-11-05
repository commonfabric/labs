import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { JSONSchema } from "@commonfabric/api";
import { createFactoryShell } from "@commonfabric/data-model/fabric-factory";

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
      asFactory: {
        kind: "pattern",
        argumentSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
        resultSchema: true,
      },
    } as const satisfies JSONSchema;

    it("returns `tool` for a schema declaring a pattern factory", () => {
      expect(classifyCallableEntry(undefined, toolSchema)).toBe("tool");
      expect(classifyCallableEntry({ title: "plain" }, toolSchema)).toBe(
        "tool",
      );
    });

    it("returns `tool` for a direct pattern factory value", () => {
      const factory = createFactoryShell({
        kind: "pattern",
        ref: {
          identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          symbol: "search",
        },
        argumentSchema: toolSchema.asFactory.argumentSchema,
        resultSchema: true,
      });

      expect(classifyCallableEntry(factory)).toBe("tool");
    });

    it("returns `null` for an ordinary object schema", () => {
      expect(classifyCallableEntry(undefined, {
        type: "object",
        properties: { pattern: { type: "object" } },
      })).toBeNull();
    });
  });
});
