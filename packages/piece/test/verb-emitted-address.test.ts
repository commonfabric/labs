/**
 * Pins the round-trip spelling at the dispatch gate in its two pure layers:
 * `resolveEmittedAddressArguments` decides which positions take a reference
 * and which spellings convert to the link envelope dispatch accepts, refusing
 * a string that is no address and an inline copy that would store a detached
 * document (#5560); `handlerVerbEvents` recovers the contract that decision
 * reads from the handler module of a compiled pattern.
 * `packages/cli/test/verb-emitted-address.test.ts` drives a compiled, running
 * pattern through `cf piece call` against the same gate.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/runner";
import { resolveEmittedAddressArguments } from "../src/verb-input.ts";
import { handlerVerbEvents } from "../src/verb-listing.ts";

/** A real-shaped piece id, so the address parser judges the spelling and not
 * a malformed hash. */
const ID = "of:fid1:d2cuq3cMqJY3oaG3fkalMq4uO7BgLfBFkvI-Dm-Kk94";

const ADDRESS = `/${ID}`;
const ENVELOPE = { "/": { "link@1": { id: ID } } };

describe("verb-emitted-address", () => {
  describe("resolveEmittedAddressArguments()", () => {
    /** A contract whose one field is a declared reference, marker inline. */
    const inlineMarker: JSONSchema = {
      type: "object",
      properties: {
        on: { type: "object", asCell: ["cell"] },
      },
    };

    it("converts an address string at a reference position into the link envelope", () => {
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, inlineMarker))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("converts the `$link` object a marked read renders, alone or beside projected contents", () => {
      // A read renders a marked position as `{"$link": "/of:…"}`, and joins
      // the contents it also projected into the same object. Either way the
      // address is what the position takes; the contents are the target's
      // own fields, which a reference never stores.

      expect(
        resolveEmittedAddressArguments(
          { on: { $link: ADDRESS } },
          inlineMarker,
        ),
      ).toEqual({ value: { on: ENVELOPE } });
      expect(
        resolveEmittedAddressArguments(
          { on: { $link: ADDRESS, title: "First note" } },
          inlineMarker,
        ),
      ).toEqual({ value: { on: ENVELOPE } });
      const listed: JSONSchema = {
        type: "object",
        properties: {
          them: { type: "array", items: { type: "object", asCell: ["cell"] } },
        },
      };
      expect(
        resolveEmittedAddressArguments(
          { them: [{ $link: ADDRESS }, ADDRESS] },
          listed,
        ),
      ).toEqual({ value: { them: [ENVELOPE, ENVELOPE] } });
    });

    it("judges the string inside `$link` as it judges a bare one", () => {
      expect(
        resolveEmittedAddressArguments(
          { on: { $link: "/tracker" } },
          inlineMarker,
        )
          .refusal,
      ).toContain('"/tracker" at <event>.on is not an address');
    });

    it("refuses a `$link` that holds no string as an inline copy", () => {
      // `{"$link": true}` is the projection-schema marker, not an address.

      expect(
        resolveEmittedAddressArguments({ on: { $link: true } }, inlineMarker)
          .refusal,
      ).toContain("an inline copy would store a detached document");
    });

    it("refuses a reference naming a piece by slug or a space by name", () => {
      // The wider vocabulary `cf`'s own intake takes stops at this seam. What
      // is built here is a stored link, which holds the id and the space
      // verbatim and has no session behind it to resolve a name with, so a
      // slug written into one is a durable edge pointing at nothing.
      expect(
        resolveEmittedAddressArguments({ on: "/tracker" }, inlineMarker)
          .refusal,
      ).toBe(
        '"/tracker" at <event>.on is not an address — the position ' +
          "declares a reference, and takes the /of:… form a read prints",
      );
      expect(
        resolveEmittedAddressArguments({ on: `/@my-space/${ID}` }, inlineMarker)
          .refusal,
      ).toContain("is not an address");
      // The colon is what separates the vocabularies, not the length: a slug
      // may run to eighty characters, so one past twenty reads as a handle to
      // a length rule and is stored verbatim.
      expect(
        resolveEmittedAddressArguments(
          { on: "/a-piece-name-that-is-twenty-plus" },
          inlineMarker,
        ).refusal,
      ).toContain("is not an address");
    });

    it("converts a reference whose space is a DID, which a link can hold", () => {
      const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
      expect(
        resolveEmittedAddressArguments({ on: `/@${did}/${ID}` }, inlineMarker),
      ).toEqual({
        value: { on: { "/": { "link@1": { id: ID, space: did } } } },
      });
    });

    it("reads the marker off the `$ref` site, where the compiled contract carries it", () => {
      // The compiled contract spells a named reference `{$ref: …, asCell: […]}`
      // — the marker rides the REFERENCE SITE. A walk that resolves the `$ref`
      // before looking loses it and converts nothing, which is exactly how the
      // first live probe of this feature failed.

      const schema: JSONSchema = {
        type: "object",
        properties: { on: { $ref: "#/$defs/Item", asCell: ["cell"] } },
        $defs: { Item: { type: "object", properties: {} } },
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("reads the marker off the `$ref` target as well", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { on: { $ref: "#/$defs/Item" } },
        $defs: { Item: { type: "object", asCell: ["cell"] } },
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("carries the address's path into the envelope", () => {
      expect(
        resolveEmittedAddressArguments(
          { on: `${ADDRESS}/status` },
          inlineMarker,
        ),
      ).toEqual({
        value: { on: { "/": { "link@1": { id: ID, path: ["status"] } } } },
      });
    });

    it("refuses a string that is not an address, naming the position and the form", () => {
      const resolved = resolveEmittedAddressArguments(
        { on: "not-an-address" },
        inlineMarker,
      );
      expect(resolved.refusal).toBe(
        '"not-an-address" at <event>.on is not an address — the position ' +
          "declares a reference, and takes the /of:… form a read prints",
      );
    });

    it("refuses the `#argument` suffix at a reference position", () => {
      // `#argument` names a piece's arguments cell for commands that take
      // `--input`; as a verb argument it addresses nothing a reference position
      // can hold.

      const resolved = resolveEmittedAddressArguments(
        { on: `${ADDRESS}#argument` },
        inlineMarker,
      );
      expect(resolved.refusal).toContain("is not an address");
    });

    it("refuses a suffix the address grammar rejects outright", () => {
      // The parser THROWS on an unknown suffix rather than declining; the walk
      // absorbs that into the same refusal, so a caller never sees a parser
      // stack where a refusal was owed.

      const resolved = resolveEmittedAddressArguments(
        { on: `${ADDRESS}#bogus` },
        inlineMarker,
      );
      expect(resolved.refusal).toContain("is not an address");
    });

    it("refuses an inline copy at a reference position as a detached document", () => {
      const resolved = resolveEmittedAddressArguments(
        { on: { title: "a copy" } },
        inlineMarker,
      );
      expect(resolved.refusal).toBe(
        "<event>.on declares a reference, and an inline copy would store a " +
          "detached document rather than an edge — send the address a read " +
          "printed",
      );
    });

    it("passes a link envelope through untouched", () => {
      const payload = { on: ENVELOPE };
      expect(resolveEmittedAddressArguments(payload, inlineMarker))
        .toEqual({ value: payload });
    });

    it("leaves a string at an unmarked position for shape validation", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { on: { type: "object" } },
      };
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, schema))
        .toEqual({ value: payload });
    });

    it("never converts at the event root", () => {
      // The event root is where the payload ITSELF sits; a marker there says
      // how the runtime holds the event, not that the caller sends an address.

      const schema: JSONSchema = {
        type: "object",
        asCell: ["cell"],
        properties: { on: { type: "object" } },
      };
      expect(resolveEmittedAddressArguments(ADDRESS, schema))
        .toEqual({ value: ADDRESS });
    });

    it("walks arrays by `items`, and indexes the position a refusal names", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          them: { type: "array", items: { type: "object", asCell: ["cell"] } },
        },
      };
      expect(
        resolveEmittedAddressArguments({ them: [ADDRESS, ADDRESS] }, schema),
      ).toEqual({ value: { them: [ENVELOPE, ENVELOPE] } });
      expect(
        resolveEmittedAddressArguments({ them: [ADDRESS, "nope"] }, schema)
          .refusal,
      ).toContain('"nope" at <event>.them[1] is not an address');
    });

    it("walks `prefixItems` by position, and flows the positions beyond them", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [
              { type: "string" },
              { type: "object", asCell: ["cell"] },
            ],
          },
        },
      };
      expect(
        resolveEmittedAddressArguments({ pair: ["label", ADDRESS] }, schema),
      ).toEqual({ value: { pair: ["label", ENVELOPE] } });
      // A third element has no declared position: it flows through as
      // written, address form or not.
      expect(
        resolveEmittedAddressArguments(
          { pair: ["label", ADDRESS, ADDRESS] },
          schema,
        ),
      ).toEqual({ value: { pair: ["label", ENVELOPE, ADDRESS] } });
    });

    it("walks a record schema's values through `additionalProperties`", () => {
      // A record schema names no key at all: its values are declared on
      // `additionalProperties`, which is where a map of references puts its
      // marker. Reading only `properties` skips every one of them.

      const schema: JSONSchema = {
        type: "object",
        additionalProperties: { type: "object", asCell: ["cell"] },
      };
      expect(resolveEmittedAddressArguments({ anything: ADDRESS }, schema))
        .toEqual({ value: { anything: ENVELOPE } });
      expect(
        resolveEmittedAddressArguments({ anything: "nope" }, schema).refusal,
      ).toContain('"nope" at <event>.anything is not an address');
    });

    it("prefers a named property over `additionalProperties`", () => {
      // A named key keeps its own account; `additionalProperties` covers only
      // what `properties` does not name.

      const schema: JSONSchema = {
        type: "object",
        properties: { plain: { type: "string" } },
        additionalProperties: { type: "object", asCell: ["cell"] },
      };
      expect(
        resolveEmittedAddressArguments(
          { plain: ADDRESS, other: ADDRESS },
          schema,
        ),
      ).toEqual({ value: { plain: ADDRESS, other: ENVELOPE } });
    });

    it("walks a conjunction member-wise, refusals included", () => {
      const schema: JSONSchema = {
        allOf: [{
          type: "object",
          properties: { on: { type: "object", asCell: ["cell"] } },
        }],
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
      expect(
        resolveEmittedAddressArguments({ on: "nope" }, schema).refusal,
      ).toContain('"nope" at <event>.on is not an address');
    });

    it("passes over disjunction interiors", () => {
      // Choosing a disjunction branch is the caller's; converting inside one
      // would pick it for them.

      const schema: JSONSchema = {
        type: "object",
        properties: {
          on: {
            anyOf: [{ type: "object", asCell: ["cell"] }, { type: "null" }],
          },
        },
      };
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, schema))
        .toEqual({ value: payload });
    });

    it("flows a field the contract does not name through untouched", () => {
      const payload = { on: ADDRESS, extra: ADDRESS };
      const resolved = resolveEmittedAddressArguments(payload, inlineMarker);
      expect((resolved.value as { extra: unknown }).extra).toBe(ADDRESS);
    });

    it("converts nothing without a contract", () => {
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, undefined))
        .toEqual({ value: payload });
    });
  });

  describe("handlerVerbEvents()", () => {
    const link = (n: number) => ({
      $alias: { partialCause: { n }, path: ["stream"], scope: "space" },
    });
    const eventDef: JSONSchema = {
      type: "object",
      properties: { on: { $ref: "#/$defs/Item", asCell: ["cell"] } },
    };

    it("resolves a `$ref` event against the module schema's own root", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{
          inputs: { $event: link(1) },
          module: {
            argumentSchema: {
              type: "object",
              properties: { $event: { $ref: "#/$defs/E" }, $ctx: true },
              $defs: { E: eventDef, Item: { type: "object" } },
            },
          },
        }],
      };
      const event = handlerVerbEvents(pattern).get("relate") as
        & JSONSchema
        & object;
      expect(event.properties).toEqual(eventDef.properties);
      // Self-contained: the interior `$ref` must stay resolvable without the
      // pattern in hand.
      expect((event.$defs as Record<string, unknown>).Item).toBeDefined();
    });

    it("attaches the module root's `$defs` to an inline event", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{
          inputs: { $event: link(1) },
          module: {
            argumentSchema: {
              type: "object",
              properties: { $event: eventDef, $ctx: true },
              $defs: { Item: { type: "object" } },
            },
          },
        }],
      };
      const event = handlerVerbEvents(pattern).get("relate") as
        & JSONSchema
        & object;
      expect(event.properties).toEqual(eventDef.properties);
      expect((event.$defs as Record<string, unknown>).Item).toBeDefined();
    });

    it("maps a stream two handler nodes share to `undefined`", () => {
      // A stream two handler nodes share is still a verb, but it names no
      // single contract — matching what its declared result does.

      const argumentSchema = {
        type: "object",
        properties: { $event: eventDef, $ctx: true },
      };
      const pattern = {
        result: { relate: link(1) },
        nodes: [
          { inputs: { $event: link(1) }, module: { argumentSchema } },
          { inputs: { $event: link(1) }, module: { argumentSchema } },
        ],
      };
      const verbs = handlerVerbEvents(pattern);
      expect(verbs.has("relate")).toBe(true);
      expect(verbs.get("relate")).toBeUndefined();
    });

    it("keys a matched node whose module states no schema, as `undefined`", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{ inputs: { $event: link(1) }, module: {} }],
      };
      const verbs = handlerVerbEvents(pattern);
      expect(verbs.has("relate")).toBe(true);
      expect(verbs.get("relate")).toBeUndefined();
    });

    it("omits a result property no handler node drives", () => {
      const pattern = {
        result: { data: link(1) },
        // A node with no inputs at all sits beside the mismatch: the walk
        // steps over what it cannot read rather than crashing on it.
        nodes: [{}, { inputs: { $event: link(2) }, module: {} }],
      };
      expect(handlerVerbEvents(pattern).has("data")).toBe(false);
    });

    it("returns an empty map for a pattern with no result", () => {
      expect(handlerVerbEvents(null).size).toBe(0);
      expect(handlerVerbEvents({}).size).toBe(0);
    });
  });
});
