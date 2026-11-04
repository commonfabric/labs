/**
 * Pins `requiredEventFieldsOwed` and `verbRunsWithoutPayload` directly.
 *
 * Both answer one question the flag door asks at three separate places — the
 * bare-invoke gate, the per-flag presence check, and the required-ness a help
 * page prints. Driving them through any one of those would pin the caller
 * rather than the answer, and the three would be free to drift apart again.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/api";
import {
  requiredEventFieldsOwed,
  verbRunsWithoutPayload,
} from "../lib/callable.ts";

describe("verb-required-fields-owed", () => {
  it("owes nothing for a schema that is not a fields position", () => {
    // Nothing to owe where nothing is named: an absent schema, an open one,
    // and a verb whose event is a single value.
    expect(requiredEventFieldsOwed(undefined)).toEqual(new Set());
    expect(requiredEventFieldsOwed(true)).toEqual(new Set());
    expect(requiredEventFieldsOwed({ type: "string" })).toEqual(new Set());
  });

  it("owes the fields a schema requires and no others", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { note: { type: "string" }, tag: { type: "string" } },
      required: ["note"],
    };
    expect(requiredEventFieldsOwed(schema)).toEqual(new Set(["note"]));

    // A fields position requiring none owes none.
    expect(
      requiredEventFieldsOwed({
        type: "object",
        properties: { note: { type: "string" } },
      }),
    ).toEqual(new Set());
  });

  it("stops owing a required field once a default answers for it", () => {
    // The runtime fills the default in, so demanding it from the caller would
    // refuse a call that was always going to succeed.
    const schema: JSONSchema = {
      type: "object",
      properties: {
        mode: { type: "string", default: "fast" },
        note: { type: "string" },
      },
      required: ["mode", "note"],
    };
    expect(requiredEventFieldsOwed(schema)).toEqual(new Set(["note"]));
  });

  it("reads what is owed through a top-level $ref", () => {
    const schema = {
      $ref: "#/$defs/RefreshEvent",
      asCell: ["stream"],
      $defs: {
        RefreshEvent: {
          type: "object",
          properties: {
            mode: { type: "string", default: "fast" },
            note: { type: "string" },
          },
          required: ["mode", "note"],
        },
      },
    } as unknown as JSONSchema;
    expect(requiredEventFieldsOwed(schema)).toEqual(new Set(["note"]));
  });

  it("runs without a payload exactly when nothing is owed", () => {
    const allDefaulted: JSONSchema = {
      type: "object",
      properties: { mode: { type: "string", default: "fast" } },
      required: ["mode"],
    };
    expect(verbRunsWithoutPayload(allDefaulted)).toBe(true);

    const owesOne: JSONSchema = {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    };
    expect(verbRunsWithoutPayload(owesOne)).toBe(false);

    // Not a fields position at all, which is a different answer from
    // "a fields position owing nothing" — there is no payload to normalize.
    expect(verbRunsWithoutPayload({ type: "string" })).toBe(false);
    expect(verbRunsWithoutPayload(undefined)).toBe(false);
  });
});
