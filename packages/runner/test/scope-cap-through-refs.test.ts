/**
 * A scope declared on a definition is read through the `$ref` that names it,
 * so what a slot stores follows from the schema rather than from the form the
 * schema travels in: inline `$defs` while it is held, content-addressed
 * documents once it is stored.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import { ContextualFlowControl } from "../src/cfc.ts";
import { externalizeSchema } from "../src/link-utils.ts";

/** The cap the slot at `key` declares, as the write path reads it. */
const capAt = (schema: JSONSchema, key: string): string | undefined =>
  ContextualFlowControl.getSchemaScopeCap(
    ContextualFlowControl.getSchemaAtPath(schema, [key]),
  );

describe("scope-cap-through-refs", () => {
  describe("getSchemaScopeCap()", () => {
    it("returns the scope declared by the definition a slot names", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { nickname: { $ref: "#/$defs/Nickname" } },
        $defs: { Nickname: { type: "string", scope: "user" } },
      };

      expect(capAt(schema, "nickname")).toBe("user");
    });

    it("returns the scope beside the `$ref` over the definition's", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: {
          nickname: { $ref: "#/$defs/Nickname", scope: "session" },
        },
        $defs: { Nickname: { type: "string", scope: "user" } },
      };

      expect(capAt(schema, "nickname")).toBe("session");
    });

    it("returns the definition's `asCell` entry scope over a `scope` beside the `$ref`", () => {
      // Keywords beside a `$ref` merge over the definition's one by one, so
      // the slot reads `{ asCell: [{ kind: "cell", scope: "user" }], scope:
      // "session" }`, the shape `PerUser<Cell<PerSession<T>>>` emits written
      // in place. There the entry scopes the slot and `scope` its value.

      const schema: JSONSchemaObj = {
        type: "object",
        properties: {
          draft: { $ref: "#/$defs/Draft", scope: "session" },
        },
        $defs: {
          Draft: {
            type: "string",
            asCell: [{ kind: "cell", scope: "user" }],
          },
        },
      };

      expect(capAt(schema, "draft")).toBe("user");
      expect(capAt(externalizeSchema(structuredClone(schema)), "draft"))
        .toBe("user");
    });

    it("returns the scope declared at the end of a chain of definitions", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { nickname: { $ref: "#/$defs/Nickname" } },
        $defs: {
          Nickname: { $ref: "#/$defs/Handle" },
          Handle: { type: "string", scope: "user" },
        },
      };

      expect(capAt(schema, "nickname")).toBe("user");
    });

    it("returns the scope on the outermost `asCell` entry of a definition", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { draft: { $ref: "#/$defs/Draft" } },
        $defs: {
          Draft: {
            type: "string",
            asCell: [{ kind: "cell", scope: "session" }],
          },
        },
      };

      expect(capAt(schema, "draft")).toBe("session");
    });

    it("returns the same scope inline and content-addressed", () => {
      // The two forms are the same declaration: one held, one stored.

      const schema: JSONSchemaObj = {
        type: "object",
        properties: { nickname: { $ref: "#/$defs/Nickname" } },
        $defs: { Nickname: { type: "string", scope: "user" } },
      };

      const stored = externalizeSchema(structuredClone(schema));

      expect(capAt(stored, "nickname")).toBe(capAt(schema, "nickname"));
      expect(capAt(stored, "nickname")).toBe("user");
    });

    it("returns `undefined` for a definition that names only itself", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        $defs: { Node: { $ref: "#/$defs/Node" } },
      };

      expect(capAt(schema, "node")).toBeUndefined();
    });

    it("returns `undefined` in either form for a scoped definition that names only itself", () => {
      // A reference chain that never reaches a schema resolves to nothing, so
      // the scope written on its definition is never reached in either form.

      const schema: JSONSchemaObj = {
        type: "object",
        properties: { never: { $ref: "#/$defs/Never" } },
        $defs: { Never: { $ref: "#/$defs/Never", scope: "user" } },
      };

      expect(capAt(schema, "never")).toBeUndefined();
      expect(capAt(externalizeSchema(structuredClone(schema)), "never"))
        .toBeUndefined();
    });

    it("returns `undefined` for a `$ref` the document defines nothing for", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { nickname: { $ref: "#/$defs/Missing" } },
        $defs: { Nickname: { type: "string", scope: "user" } },
      };

      expect(capAt(schema, "nickname")).toBeUndefined();
    });
  });

  describe("getAsCellFollowScopeCap()", () => {
    it("returns the entry scope declared by the definition a handle names", () => {
      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Draft",
        $defs: {
          Draft: {
            type: "string",
            asCell: [{ kind: "cell", scope: "session" }],
          },
        },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBe("session");
    });

    it("returns the narrowest entry scope among the branches of a definition", () => {
      // The runtime value may be any branch, so the cap that admits the
      // fewest link scopes is the one that holds for all of them.

      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Draft",
        $defs: {
          Draft: {
            anyOf: [
              { type: "string", asCell: [{ kind: "cell", scope: "session" }] },
              { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
            ],
          },
        },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBe("user");
    });

    it("returns `undefined` for a `scope` a definition declares beside no `asCell`", () => {
      // The follow cap is an `asCell` entry's to declare; a bare `scope` says
      // where a value lives, and reading it here would invent a restriction.

      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Nickname",
        $defs: { Nickname: { type: "string", scope: "user" } },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBeUndefined();
    });
  });
});
