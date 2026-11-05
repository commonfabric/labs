import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { JSONSchema } from "@commonfabric/api";
import {
  createFactoryShell,
  factoryStateOf,
} from "@commonfabric/data-model/fabric-factory";

import {
  classifyCallableEntry,
  decodeFactoryProjections,
  decodeHandlerWritePayload,
  encodeFactoryProjection,
  isHandlerCell,
} from "../callables.ts";

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

  describe("factory projection writes", () => {
    const state = {
      kind: "module" as const,
      ref: {
        identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        symbol: "projected",
      },
    };
    const encoded = encodeFactoryProjection(createFactoryShell(state))!;

    it("decodes factory leaves in handler and JSON payloads", () => {
      expect(factoryStateOf(decodeHandlerWritePayload(encoded))).toEqual(state);
      const decoded = decodeFactoryProjections({ nested: [encoded] }) as {
        nested: unknown[];
      };
      expect(factoryStateOf(decoded.nested[0])).toEqual(state);
    });

    it("rejects malformed tagged bare handler payloads", () => {
      expect(() => decodeHandlerWritePayload("fvj1:not-valid")).toThrow();
    });
  });
});
