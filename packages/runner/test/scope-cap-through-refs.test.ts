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

/**
 * `schema` in its content-addressed form. `externalizeSchema` hands back its
 * input unchanged when the schema cannot be decomposed, so the form is checked
 * rather than assumed.
 */
const storedForm = (schema: JSONSchemaObj): JSONSchema => {
  const stored = externalizeSchema(structuredClone(schema));
  expect((stored as JSONSchemaObj).$ref).toMatch(/^cid:/);
  return stored;
};

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
      expect(capAt(storedForm(schema), "draft"))
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

      const stored = storedForm(schema);

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
      expect(capAt(storedForm(schema), "never"))
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

    it("returns the entry scope of a handle branch beside a boolean branch of a definition", () => {
      // A boolean schema is a valid branch that declares no cap, so the
      // branches that do declare one decide.

      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Draft",
        $defs: {
          Draft: {
            anyOf: [
              true,
              { type: "string", asCell: [{ kind: "cell", scope: "session" }] },
            ],
          },
        },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBe("session");
    });

    it("returns `undefined` for a handle whose definition names itself through a branch", () => {
      // The shape `type Recursive = Cell<Recursive> | null` generates: the
      // branch's `$ref` resolves to the union holding that same branch.

      const schema: JSONSchemaObj = {
        type: "object",
        properties: { node: { $ref: "#/$defs/Recursive" } },
        $defs: {
          Recursive: {
            anyOf: [
              { type: "null" },
              { $ref: "#/$defs/Recursive", asCell: ["cell"] },
            ],
          },
        },
      };
      const node = ContextualFlowControl.getSchemaAtPath(schema, ["node"]);

      expect(ContextualFlowControl.getAsCellFollowScopeCap(node))
        .toBeUndefined();
      expect(ContextualFlowControl.getSchemaScopeCap(node)).toBeUndefined();
    });

    it("returns the entry scope of a recursive handle branch in either form", () => {
      // A branch naming a definition that is already being expanded still
      // declares its own cap; only the expansion stops there.

      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Recursive",
        $defs: {
          Recursive: {
            anyOf: [
              { type: "null" },
              {
                $ref: "#/$defs/Recursive",
                asCell: [{ kind: "cell", scope: "user" }],
              },
            ],
          },
        },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBe("user");
      expect(ContextualFlowControl.getAsCellFollowScopeCap(storedForm(schema)))
        .toBe("user");
    });

    it("returns the entry scope of a branch repeating its compound's reference in either form", () => {
      const schema: JSONSchemaObj = {
        $ref: "#/$defs/R",
        anyOf: [
          { $ref: "#/$defs/R", asCell: [{ kind: "cell", scope: "user" }] },
          { type: "null" },
        ],
        $defs: { R: { type: "string" } },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBe("user");
      expect(ContextualFlowControl.getAsCellFollowScopeCap(storedForm(schema)))
        .toBe("user");
    });

    for (const keyword of ["anyOf", "oneOf"] as const) {
      it(`returns the entry scope inside a repeated reference's own \`${keyword}\` in either form`, () => {
        // Both positions name `R`, but each carries its own compound beside the
        // `$ref`; the inner one has not been expanded when it is reached.

        const schema: JSONSchemaObj = {
          $ref: "#/$defs/R",
          [keyword]: [
            {
              $ref: "#/$defs/R",
              [keyword]: [
                { type: "string", asCell: [{ kind: "cell", scope: "user" }] },
                { type: "null" },
              ],
            },
            { type: "null" },
          ],
          $defs: { R: { type: "string" } },
        };

        expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
          .toBe("user");
        expect(
          ContextualFlowControl.getAsCellFollowScopeCap(storedForm(schema)),
        ).toBe("user");
      });
    }

    it("returns `undefined` for a recursive handle carrying a keyword beside its `$ref`", () => {
      // A `description` beside the `$ref`, as documentation on the type emits,
      // gives the branch a merged view of its own on every visit; the compound
      // it expands is still the definition's.

      const schema: JSONSchemaObj = {
        $ref: "#/$defs/Recursive",
        $defs: {
          Recursive: {
            anyOf: [
              { type: "null" },
              {
                $ref: "#/$defs/Recursive",
                description: "a node",
                asCell: ["cell"],
              },
            ],
          },
        },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBeUndefined();
    });

    it("returns `undefined` for a cycle that passes through a position's own compound", () => {
      // `D` reaches itself through a branch that carries a compound of its own,
      // so the expansion alternates between the two compounds before repeating.

      const schema: JSONSchemaObj = {
        $ref: "#/$defs/D",
        $defs: {
          D: {
            anyOf: [
              {
                $ref: "#/$defs/D",
                anyOf: [{ $ref: "#/$defs/D" }, { type: "null" }],
              },
              { type: "null" },
            ],
          },
        },
      };

      expect(ContextualFlowControl.getAsCellFollowScopeCap(schema))
        .toBeUndefined();
    });

    it("returns the owning document's definition for a branch that carries a `$defs` of its own", () => {
      // A `$defs` below the root is inert: `#/$defs/Handle` names the root's
      // definition wherever the reference sits.

      const schema: JSONSchemaObj = {
        anyOf: [{
          anyOf: [{ $ref: "#/$defs/Handle" }, { type: "null" }],
          $defs: {
            Handle: {
              type: "string",
              asCell: [{ kind: "cell", scope: "session" }],
            },
          },
        }],
        $defs: {
          Handle: {
            type: "string",
            asCell: [{ kind: "cell", scope: "user" }],
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
