/**
 * Pins the refusal `verbInputSchemaError` gives a payload carrying a field the
 * verb's event schema does not declare, through `undeclaredVerbFieldError`:
 * which positions it fires at, the wording a caller reads, and the positions
 * it passes over. `packages/cli/test/verb-undeclared-field.test.ts` drives the
 * same gate through the whole path `cf piece call` takes to it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchema } from "@commonfabric/runner";
import {
  undeclaredVerbFieldError,
  verbInputSchemaError,
} from "../src/verb-input.ts";

describe("verb-undeclared-field", () => {
  describe("undeclaredVerbFieldError()", () => {
    const addItem: JSONSchema = {
      type: "object",
      properties: { title: { type: "string" }, done: { type: "boolean" } },
      required: ["title"],
    };

    it("names the field, the position it sat at, and the vocabulary that position takes", () => {
      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, addItem),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title", "done"',
        );
    });

    it("suggests the declared field a misspelling is one edit from", () => {
      expect(undeclaredVerbFieldError({ titel: "Milk" }, addItem)).toBe(
        '"titel" at <event> is not a field this verb declares. ' +
          'Did you mean "title"? <event> takes "title", "done"',
      );
    });

    it("counts an adjacent transposition as one edit", () => {
      // A transposition is one slip to the caller who made it, whatever it
      // costs to spell as substitutions, and the threshold for a four-character
      // key is one edit.

      expect(undeclaredVerbFieldError({ doen: true }, addItem)).toMatch(
        /Did you mean "done"\?/,
      );
    });

    it("returns `undefined` for a payload carrying exactly the declared fields", () => {
      expect(undeclaredVerbFieldError({ title: "Milk", done: true }, addItem))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ title: "Milk" }, addItem))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({}, addItem)).toBeUndefined();
    });

    it("returns `undefined` where the verb declares no schema", () => {
      expect(undeclaredVerbFieldError({ anything: 1 }, undefined))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ anything: 1 }, true)).toBeUndefined();
    });

    it("returns `undefined` for an object schema stating no `properties`", () => {
      // A position with no property map is open by construction: the runtime
      // delivers the whole payload there, so nothing is dropped and nothing is
      // refused.

      expect(undeclaredVerbFieldError({ anything: 1 }, { type: "object" }))
        .toBeUndefined();
    });

    it("refuses every field against an explicitly empty `properties` map", () => {
      // The other reading of "declares no fields": an explicit empty map, which
      // the runtime answers by delivering nothing at all. Every field a caller
      // writes there is refused, and there is no vocabulary to offer instead.

      expect(
        undeclaredVerbFieldError({ title: "Milk" }, {
          type: "object",
          properties: {},
        }),
      ).toBe(
        '"title" at <event> is not a field this verb declares. ' +
          "<event> declares no fields at all",
      );
    });

    it("returns `undefined` where the position declares `additionalProperties`", () => {
      // `additionalProperties` is what makes the runtime deliver a field no map
      // names, so a position carrying one honors what it is sent.

      for (const additionalProperties of [true, {}, { type: "string" }]) {
        expect(
          undeclaredVerbFieldError({ title: "Milk", colour: "red" }, {
            ...addItem,
            additionalProperties,
          } as JSONSchema),
        ).toBeUndefined();
      }
    });

    it("names a nested object position", () => {
      // The position half of the message is load-bearing: a field goes missing
      // wherever its enclosing position drops what it does not name, not only
      // at the root.

      expect(
        undeclaredVerbFieldError({ item: { id: "1", lable: "Milk" } }, {
          type: "object",
          properties: {
            item: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
            },
          },
        }),
      ).toBe(
        '"lable" at <event>.item is not a field this verb declares. ' +
          'Did you mean "label"? <event>.item takes "id", "label"',
      );
    });

    it("names an array element by its index", () => {
      expect(
        undeclaredVerbFieldError({
          tags: [{ name: "a" }, { name: "b", colour: "red" }],
        }, {
          type: "object",
          properties: {
            tags: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        }),
      ).toBe(
        '"colour" at <event>.tags[1] is not a field this verb declares. ' +
          '<event>.tags[1] takes "name"',
      );
    });

    it("resolves the top-level `$ref` a stream schema wraps its event in", () => {
      expect(
        undeclaredVerbFieldError({ titel: "Milk" }, {
          $ref: "#/$defs/AddItem",
          asCell: ["stream"],
          $defs: {
            AddItem: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
        } as JSONSchema),
      ).toMatch(/"titel" at <event> .* Did you mean "title"\?/);
    });

    it("returns `undefined` inside a position marked `asCell`", () => {
      // Below the root a marked position is where a caller may write a link
      // instead of a value, and `"/"` is not a field anybody declared.

      const schema: JSONSchema = {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: { n: { type: "number" } },
            asCell: ["cell"],
          },
        },
      };
      expect(undeclaredVerbFieldError({ target: { n: 1, extra: 2 } }, schema))
        .toBeUndefined();
      expect(
        undeclaredVerbFieldError(
          { target: { "/": { id: "of:abc", path: [], space: "did:x:y" } } },
          schema,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` at a position carrying a combinator", () => {
      // A payload need satisfy only one branch of a disjunction, and schema
      // traversal unions the branches before deciding which children exist, so
      // a field only one branch names is one the runtime still delivers.

      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, {
          type: "object",
          properties: { title: { type: "string" } },
          anyOf: [
            { required: ["title"] },
            {
              type: "object",
              properties: { colour: { type: "string" } },
            },
          ],
        } as JSONSchema),
      ).toBeUndefined();
    });
  });

  describe('an object-shaped position with no explicit `type: "object"`', () => {
    // Every shape `schemaIsObjectShaped` recognizes drops what its maps do not
    // name, so every one of them is judged. An explicit `type: "object"` is
    // only the most common of the four.

    const bareProperties: JSONSchema = {
      properties: { title: { type: "string" } },
    } as JSONSchema;
    const conjunction: JSONSchema = {
      allOf: [{ type: "object", properties: { title: { type: "string" } } }],
    } as JSONSchema;
    const typeUnion: JSONSchema = {
      type: ["object", "null"],
      properties: { title: { type: "string" } },
    } as JSONSchema;

    it("refuses an undeclared field against a bare `properties` map", () => {
      expect(
        undeclaredVerbFieldError(
          { title: "Milk", colour: "red" },
          bareProperties,
        ),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title"',
        );
    });

    it("refuses an undeclared field against a conjunction", () => {
      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, conjunction),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title"',
        );
    });

    it("refuses an undeclared field against a type union admitting an object", () => {
      expect(
        undeclaredVerbFieldError({ title: "Milk", colour: "red" }, typeUnion),
      )
        .toBe(
          '"colour" at <event> is not a field this verb declares. ' +
            '<event> takes "title"',
        );
    });

    it("takes the fields a conjunction declares as the union across its members", () => {
      // A payload satisfying a conjunction satisfies every member, so the
      // fields it declares are the union across them.

      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [
          { properties: { body: { type: "string" } } },
          { $ref: "#/$defs/Signed" },
        ],
        $defs: {
          Signed: {
            type: "object",
            properties: { agentName: { type: "string" } },
          },
        },
      } as JSONSchema;
      expect(
        undeclaredVerbFieldError(
          { title: "Milk", body: "b", agentName: "Sol" },
          schema,
        ),
      ).toBeUndefined();
      expect(undeclaredVerbFieldError({ colour: "red" }, schema)).toBe(
        '"colour" at <event> is not a field this verb declares. ' +
          '<event> takes "title", "body", "agentName"',
      );
    });

    it("takes nothing from a conjunction member that is a boolean schema", () => {
      // A member spelled `true` constrains nothing and declares nothing, so the
      // rest of the conjunction is the whole vocabulary.

      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [true, { properties: { body: { type: "string" } } }],
      } as JSONSchema;
      expect(undeclaredVerbFieldError({ title: "Milk", body: "b" }, schema))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ colour: "red" }, schema)).toBe(
        '"colour" at <event> is not a field this verb declares. ' +
          '<event> takes "title", "body"',
      );
    });

    it("takes the fields of a conjunction that names itself, once", () => {
      // A definition whose conjunction names itself contributes its fields once
      // and terminates, which is what lets a recursive event schema be judged
      // at all.

      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
        allOf: [{ $ref: "#/$defs/Loop" }],
        $defs: {
          Loop: {
            type: "object",
            properties: { body: { type: "string" } },
            allOf: [{ $ref: "#/$defs/Loop" }],
          },
        },
      } as JSONSchema;
      expect(undeclaredVerbFieldError({ title: "Milk", body: "b" }, schema))
        .toBeUndefined();
      expect(undeclaredVerbFieldError({ colour: "red" }, schema)).toBe(
        '"colour" at <event> is not a field this verb declares. ' +
          '<event> takes "title", "body"',
      );
    });

    it("refuses an undeclared field inside a type union admitting an array", () => {
      // The array counterpart of the object type union: schema traversal
      // descends the array branch, so the element's undeclared field goes
      // missing there.

      expect(
        undeclaredVerbFieldError({ tags: [{ name: "a", colour: "red" }] }, {
          type: "object",
          properties: {
            tags: {
              type: ["array", "null"],
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        } as JSONSchema),
      ).toBe(
        '"colour" at <event>.tags[0] is not a field this verb declares. ' +
          '<event>.tags[0] takes "name"',
      );
    });

    it("refuses an undeclared field inside an untyped `items` position", () => {
      // An untyped position naming `items` describes an array the same way an
      // untyped position naming `properties` describes an object.

      expect(
        undeclaredVerbFieldError({ tags: [{ name: "a", colour: "red" }] }, {
          type: "object",
          properties: {
            tags: {
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        } as JSONSchema),
      ).toBe(
        '"colour" at <event>.tags[0] is not a field this verb declares. ' +
          '<event>.tags[0] takes "name"',
      );
    });
  });

  describe("a schema that forbids undeclared fields", () => {
    it("refuses the undeclared field rather than letting it be dropped", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: false,
      };
      expect(undeclaredVerbFieldError({ titel: "x" }, schema))
        .toMatch(/"titel" at <event> is not a field this verb declares/);
    });
  });

  describe("verbInputSchemaError()", () => {
    const addItem: JSONSchema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    };

    it("reports the undeclared field ahead of the required one it displaced", () => {
      // Both refusals hold for this payload: `title` is missing and `titel` is
      // undeclared. Only one of the two answers names something the caller
      // wrote, and that is the one they get.

      expect(verbInputSchemaError({ titel: "Milk" }, addItem)).toBe(
        '"titel" at <event> is not a field this verb declares. ' +
          'Did you mean "title"? <event> takes "title"',
      );
    });

    it("returns `undefined` for a payload carrying exactly the declared fields", () => {
      expect(verbInputSchemaError({ title: "Milk" }, addItem)).toBeUndefined();
    });

    it("still reports a declared field of the wrong type", () => {
      expect(verbInputSchemaError({ title: 7 }, addItem)).toMatch(/title/);
    });
  });
});
