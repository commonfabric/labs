/**
 * The views this module mints over deep-frozen parts are deep-frozen
 * themselves, so the memos keyed on a resolution's root hold for them: the
 * view a `$ref` resolves to within a document, the view a fragment gets of
 * the definitions it inherits, and the document a definition map is read as.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";

import { ContextualFlowControl } from "../../src/cfc.ts";
import {
  cfcSchemaDocumentOf,
  cfcSchemaWithInheritedDefs,
  resolveCfcSchemaRef,
  resolveCfcSchemaRefs,
} from "../../src/cfc/schema-refs.ts";

describe("schema-refs", () => {
  describe("resolveCfcSchemaRef()", () => {
    /** A document whose one definition names itself. */
    const document = (): JSONSchemaObj => ({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    });

    it("returns a deep-frozen view carrying the document's own map for a deep-frozen document", () => {
      const root = deepFreeze(document());
      const view = resolveCfcSchemaRef(root, "#/$defs/Node") as JSONSchemaObj;

      expect(isDeepFrozen(view)).toBe(true);
      expect(view.$defs).toBe(root.$defs);
      expect(view.properties).toBe(
        (root.$defs!.Node as JSONSchemaObj).properties,
      );
    });

    it("keeps what a reference within the view resolves to", () => {
      const root = deepFreeze(document());
      const view = resolveCfcSchemaRef(root, "#/$defs/Node") as JSONSchemaObj;
      const next = (view.properties as Record<string, JSONSchemaObj>).next;

      const first = resolveCfcSchemaRefs(next, view);
      expect(first).toEqual(view);
      expect(resolveCfcSchemaRefs(next, view)).toBe(first);
    });

    it("leaves the view of a mutable document unfrozen", () => {
      const root = document();
      const view = resolveCfcSchemaRef(root, "#/$defs/Node") as JSONSchemaObj;

      expect(Object.isFrozen(view)).toBe(false);
      expect(Object.isFrozen(root.$defs)).toBe(false);
    });
  });

  describe("cfcSchemaWithInheritedDefs()", () => {
    const definitions = (): Record<string, JSONSchema> => ({
      Name: { type: "string" },
    });
    const fragment = (): JSONSchemaObj => ({ $ref: "#/$defs/Name" });

    it("returns one deep-frozen view for a deep-frozen fragment and a deep-frozen map", () => {
      const map = deepFreeze(definitions());
      const ref = deepFreeze(fragment());
      const view = cfcSchemaWithInheritedDefs(ref, map);

      expect(view).toEqual({ $ref: "#/$defs/Name", $defs: map });
      expect(isDeepFrozen(view)).toBe(true);
      expect(cfcSchemaWithInheritedDefs(ref, map)).toBe(view);
    });

    it("keeps what a reference resolved against the view resolves to", () => {
      const map = deepFreeze(definitions());
      const view = cfcSchemaWithInheritedDefs(
        deepFreeze(fragment()),
        map,
      ) as JSONSchemaObj;

      const first = resolveCfcSchemaRefs(view);
      expect(first).toEqual({ type: "string", $defs: map });
      expect(resolveCfcSchemaRefs(view)).toBe(first);
    });

    it("leaves the view of a deep-frozen fragment unfrozen under a mutable map", () => {
      const map = definitions();
      const view = cfcSchemaWithInheritedDefs(deepFreeze(fragment()), map);

      expect(view).toEqual({ $ref: "#/$defs/Name", $defs: map });
      expect(Object.isFrozen(view)).toBe(false);
      expect(Object.isFrozen(map)).toBe(false);
    });
  });

  describe("cfcSchemaDocumentOf()", () => {
    const definitions = (): Record<string, JSONSchema> => ({
      Node: {
        type: "object",
        properties: { next: { $ref: "#/$defs/Node" } },
      },
    });

    it("returns one deep-frozen document per deep-frozen map", () => {
      const map = deepFreeze(definitions());
      const document = cfcSchemaDocumentOf(map);

      expect(document).toEqual({ $defs: map });
      expect(document.$defs).toBe(map);
      expect(isDeepFrozen(document)).toBe(true);
      expect(cfcSchemaDocumentOf(map)).toBe(document);
    });

    it("returns one shared document declaring no map for `undefined`", () => {
      const document = cfcSchemaDocumentOf(undefined);

      expect(document).toEqual({});
      expect(isDeepFrozen(document)).toBe(true);
      expect(cfcSchemaDocumentOf(undefined)).toBe(document);
    });

    it("mints a fresh unfrozen document for a mutable map", () => {
      const map = definitions();
      const document = cfcSchemaDocumentOf(map);

      expect(document.$defs).toBe(map);
      expect(Object.isFrozen(document)).toBe(false);
      expect(cfcSchemaDocumentOf(map)).not.toBe(document);
    });

    it("keeps what a reference resolved against the document resolves to", () => {
      const map = deepFreeze(definitions());
      const ref = deepFreeze({ $ref: "#/$defs/Node" }) as JSONSchemaObj;

      const first = resolveCfcSchemaRefs(ref, cfcSchemaDocumentOf(map));
      expect(first).toMatchObject({ type: "object" });
      expect(resolveCfcSchemaRefs(ref, cfcSchemaDocumentOf(map))).toBe(first);
    });

    it("is the document `schemaAtPath()` narrows through a `$ref` against", () => {
      // The narrowing's own result is minted per call, so what it resolves
      // against is what a second narrowing can share: the reference it
      // follows, resolved against the kept document, is the same instance
      // the first narrowing resolved, and both narrowings read the same
      // definition through it.
      const root = deepFreeze<JSONSchemaObj>({
        type: "object",
        properties: { head: { $ref: "#/$defs/Node" } },
        $defs: definitions(),
      });
      const ref = root.properties!.head as JSONSchemaObj;
      const narrow = () =>
        ContextualFlowControl.schemaAtPath(root, ["head", "next"], new Set());

      const first = narrow();
      const resolved = resolveCfcSchemaRefs(
        ref,
        cfcSchemaDocumentOf(root.$defs),
      );
      expect(first).toMatchObject({ $ref: "#/$defs/Node" });
      expect(narrow()).toEqual(first);
      expect(resolveCfcSchemaRefs(ref, cfcSchemaDocumentOf(root.$defs))).toBe(
        resolved,
      );
    });
  });
});
