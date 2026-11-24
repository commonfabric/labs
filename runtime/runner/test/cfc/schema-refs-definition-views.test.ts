/**
 * The view a `#/$defs/<name>` reference resolves to is one object per
 * definition body and definition map, whichever deep-frozen document the
 * reference is resolved from, so that interning it hashes the map once.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { deepFreeze, isDeepFrozen } from "@commonfabric/data-model";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";

import {
  resolveCfcSchemaRef,
  resolveCfcSchemaRefs,
} from "../../src/cfc/schema-refs.ts";

describe("schema-refs", () => {
  /** A definition map whose one definition names itself. */
  const definitions = (): Record<string, JSONSchemaObj> => ({
    Node: {
      type: "object",
      properties: { next: { $ref: "#/$defs/Node" } },
    },
  });

  describe("resolveCfcSchemaRef()", () => {
    it("returns one deep-frozen view of a definition from every deep-frozen document carrying one map", () => {
      const map = deepFreeze(definitions());
      const document = deepFreeze({ $ref: "#/$defs/Node", $defs: map });
      const other = deepFreeze(
        {
          type: "array",
          items: { $ref: "#/$defs/Node" },
          $defs: map,
        } satisfies JSONSchemaObj,
      );

      const view = resolveCfcSchemaRef(document, "#/$defs/Node");
      expect(resolveCfcSchemaRef(other, "#/$defs/Node")).toBe(view);
      expect(isDeepFrozen(view)).toBe(true);
      expect((view as JSONSchemaObj).$defs).toBe(map);
      expect((view as JSONSchemaObj).properties).toBe(map.Node.properties);
    });

    it("returns a view per map for two deep-frozen maps of equal content", () => {
      const first = deepFreeze({ $ref: "#/$defs/Node", $defs: definitions() });
      const second = deepFreeze({
        $ref: "#/$defs/Node",
        $defs: definitions(),
      });

      const firstView = resolveCfcSchemaRef(first, "#/$defs/Node");
      const secondView = resolveCfcSchemaRef(second, "#/$defs/Node");
      expect(secondView).toEqual(firstView);
      expect(secondView).not.toBe(firstView);
      expect((firstView as JSONSchemaObj).$defs).toBe(first.$defs);
      expect((secondView as JSONSchemaObj).$defs).toBe(second.$defs);
    });

    it("returns a mutable view per resolution for a mutable map", () => {
      const map = definitions();
      const document = { $ref: "#/$defs/Node", $defs: map };

      const view = resolveCfcSchemaRef(document, "#/$defs/Node");
      const again = resolveCfcSchemaRef(document, "#/$defs/Node");
      expect(again).toEqual(view);
      expect(again).not.toBe(view);
      expect(Object.isFrozen(view)).toBe(false);
    });
  });

  describe("resolveCfcSchemaRefs()", () => {
    it("hashes nothing to resolve, from a second document carrying the map, a reference a first document resolved", () => {
      const map = deepFreeze(definitions());
      const document = deepFreeze(
        {
          type: "object",
          properties: { node: { $ref: "#/$defs/Node" } },
          $defs: map,
        } satisfies JSONSchemaObj,
      );
      const other = deepFreeze(
        {
          type: "array",
          items: { $ref: "#/$defs/Node" },
          $defs: map,
        } satisfies JSONSchemaObj,
      );

      const resolved = resolveCfcSchemaRefs(document.properties.node, document);
      const hashedBefore = getContainersHashedForTestingOnly();
      expect(resolveCfcSchemaRefs(other.items, other)).toBe(resolved);
      expect(getContainersHashedForTestingOnly()).toBe(hashedBefore);
    });
  });
});
