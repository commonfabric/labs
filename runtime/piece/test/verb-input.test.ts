import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/runner";
import {
  normalizeAbsentVerbPayload,
  undeclaredVerbFieldError,
  verbEventForDispatch,
  verbInputSchemaError,
} from "../src/verb-input.ts";

/** A real-shaped piece id, so the address parser judges the spelling and not
 * a malformed hash. */
const ID = "of:fid1:d2cuq3cMqJY3oaG3fkalMq4uO7BgLfBFkvI-Dm-Kk94";
const ADDRESS = `/${ID}`;
const ENVELOPE = { "/": { "link@1": { id: ID } } };

describe("verb-input", () => {
  describe("normalizeAbsentVerbPayload()", () => {
    const defaulted: JSONSchema = {
      type: "object",
      properties: { mode: { type: "string", default: "all" } },
    };

    it("returns `{}` for an absent payload under an object schema", () => {
      expect(normalizeAbsentVerbPayload(undefined, defaulted)).toEqual({});
    });

    it("returns an absent payload under a referenced object schema as `{}`", () => {
      expect(normalizeAbsentVerbPayload(undefined, {
        $ref: "#/$defs/Event",
        $defs: { Event: defaulted },
      })).toEqual({});
    });

    it("returns a payload that is present as it is", () => {
      expect(normalizeAbsentVerbPayload("x", defaulted)).toBe("x");
    });

    it("returns an absent payload as absent where no object is declared", () => {
      expect(normalizeAbsentVerbPayload(undefined, true)).toBeUndefined();
      expect(normalizeAbsentVerbPayload(undefined, { type: "string" }))
        .toBeUndefined();
      expect(normalizeAbsentVerbPayload(undefined, { $ref: "#/$defs/None" }))
        .toBeUndefined();
    });
  });

  describe("undeclaredVerbFieldError()", () => {
    it("returns `undefined` for a link envelope where an object is declared", () => {
      expect(undeclaredVerbFieldError({ on: ENVELOPE }, {
        type: "object",
        properties: { on: { type: "object", properties: { title: {} } } },
      })).toBeUndefined();
    });

    it("returns `undefined` for array elements that carry only declared fields", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          list: {
            type: "array",
            items: { type: "object", properties: { a: {} } },
          },
        },
      };

      expect(undeclaredVerbFieldError({ list: [{ a: 1 }] }, schema))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ list: [{ b: 1 }] }, schema))
        .toContain('"b" at <event>.list[0]');
    });

    it("returns `undefined` at a position whose shape the value does not have", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          record: { type: "object", properties: { a: {} } },
          name: { type: "string" },
        },
      };

      expect(undeclaredVerbFieldError({ record: [{ b: 1 }] }, schema))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ name: { b: 1 } }, schema))
        .toBeUndefined();
    });

    it("returns `undefined` below a boolean or unresolvable schema", () => {
      expect(undeclaredVerbFieldError({ list: [{ b: 1 }] }, {
        type: "object",
        properties: { list: { type: "array", items: true } },
      })).toBeUndefined();
      expect(undeclaredVerbFieldError({ x: { b: 1 } }, {
        type: "object",
        properties: { x: { $ref: "#/$defs/Missing" } },
      })).toBeUndefined();
    });
  });

  describe("verbInputSchemaError()", () => {
    it("returns `undefined` for an absent payload, or an unconstrained verb", () => {
      expect(verbInputSchemaError(undefined, { type: "object" }))
        .toBeUndefined();
      expect(verbInputSchemaError({ anything: 1 }, true)).toBeUndefined();
      expect(verbInputSchemaError({ anything: 1 }, undefined)).toBeUndefined();
    });
  });

  describe("verbEventForDispatch()", () => {
    // The published schema keeps a reference's shape and loses its marker,
    // which only the declared contract still carries.

    const published: JSONSchema = {
      type: "object",
      properties: {
        on: { type: "object" },
        targets: { type: "array", items: { type: "object" } },
        note: { type: "string" },
      },
    };
    const contract: JSONSchema = {
      type: "object",
      properties: {
        on: { type: "object", asCell: ["cell"] },
        targets: {
          type: "array",
          items: { type: "object", asCell: ["cell"] },
        },
        note: { type: "string" },
      },
    };

    /** The declared contract, counting how often the gate asks for it. */
    const consulted = () => {
      const calls = { count: 0 };
      const declaredEvent = () => {
        calls.count++;
        return Promise.resolve(contract);
      };
      return { calls, declaredEvent };
    };

    it("returns an address at a reference position converted to a link", async () => {
      const { declaredEvent } = consulted();

      expect(
        await verbEventForDispatch({ on: ADDRESS }, published, declaredEvent),
      ).toEqual({ value: { on: ENVELOPE } });
    });

    it("returns a refusal for a string at a reference position that is no address", async () => {
      const { declaredEvent } = consulted();

      const judged = await verbEventForDispatch(
        { on: "the first note" },
        published,
        declaredEvent,
      );

      expect("refusal" in judged && judged.refusal).toContain("<event>.on");
    });

    it("returns a refusal for an inline copy inside an array at a reference position", async () => {
      const { calls, declaredEvent } = consulted();

      const judged = await verbEventForDispatch(
        { targets: [{ title: "a copy" }] },
        published,
        declaredEvent,
      );

      expect(calls.count).toBe(1);
      expect("refusal" in judged && judged.refusal).toContain(
        "<event>.targets[0]",
      );
    });

    it("returns a payload of scalars and links as it is, without reading the contract", async () => {
      const { calls, declaredEvent } = consulted();
      const payload = { on: ENVELOPE, targets: [ENVELOPE], note: "hello" };

      expect(await verbEventForDispatch(payload, published, declaredEvent))
        .toEqual({ value: payload });
      expect(calls.count).toBe(0);
    });

    it("returns a refusal asking for a payload where an absent one cannot satisfy the schema", async () => {
      const judged = await verbEventForDispatch(undefined, {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
      });

      expect("refusal" in judged && judged.refusal).toContain(
        "no payload was supplied",
      );
    });
  });
});
