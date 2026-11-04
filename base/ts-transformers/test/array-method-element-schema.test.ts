import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

/**
 * Compiles a pattern whose `entries` input has the type `listType` and whose
 * body maps over it with `expression`, and returns every emitted schema that
 * describes an array-method callback argument, in source order. `annotated`
 * selects whether the pattern's destructured parameter carries an explicit
 * `: Input` annotation.
 */
async function callbackSchemas(
  listType: string,
  annotated: boolean,
  expression: string,
): Promise<Record<string, unknown>[]> {
  const parameter = annotated ? "({ entries }: Input)" : "({ entries })";
  const output = await transformSource(
    `/// <cts-enable />
    import { type Cfc, type Default, pattern, UI, Writable } from "commonfabric";
    interface Entry { name: string; tag: string }
    type EntriesValue = Entry[] | Default<[]>;
    type EntriesCell = Writable<Entry[] | Default<[]>>;
    interface Entries<T> extends Array<T> {}
    interface Input { entries: ${listType}; }
    export default pattern<Input>(${parameter} => ({
      [UI]: <div>{${expression}}</div>,
    }));
    `,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  return emittedSchemas(parseModule(output)).filter((schema) =>
    (schema.properties as Record<string, unknown> | undefined)?.element !==
      undefined
  );
}

function elementOf(schema: Record<string, unknown> | undefined): unknown {
  return (schema?.properties as Record<string, unknown> | undefined)?.element;
}

describe("array-method-element-schema", () => {
  describe("a cell whose list type wraps the array", () => {
    // An explicit parameter annotation keeps the declared cell type, whose
    // argument is the whole union or intersection. Without one the receiver has
    // the pattern body's view, which drops a `Default` brand and keeps a `Cfc`
    // label. Each case compiles both and compares them, so a reading that
    // handles only one of the two fails.

    const listTypes = {
      "`T[] | Default<[]>`": "Writable<Entry[] | Default<[]>>",
      "an alias of `T[] | Default<[]>`": "Writable<EntriesValue>",
      "an alias of the cell": "EntriesCell",
      "`Default<T[], []>`": "Writable<Default<Entry[], []>>",
      "`Cfc<T[], Meta>`":
        'Writable<Cfc<Entry[], { confidentiality: ["secret"] }>>',
      "a list derived from `Array<T>`":
        "Writable<Entries<Entry> | Default<[]>>",
    };

    for (const [form, listType] of Object.entries(listTypes)) {
      it(`emits one entry as \`element\` for ${form}, with or without a parameter annotation`, async () => {
        const expression = "entries.map((entry) => <span>{entry.name}</span>)";
        const annotated = await callbackSchemas(listType, true, expression);
        const unannotated = await callbackSchemas(listType, false, expression);

        expect(annotated.map(elementOf)).toEqual([{ $ref: "#/$defs/Entry" }]);
        expect(annotated).toEqual(unannotated);
      });
    }

    const methods = {
      filter: 'entries.filter((entry) => entry.tag === "x")',
      flatMap: "entries.flatMap((entry) => [<span>{entry.name}</span>])",
    };

    for (const [method, expression] of Object.entries(methods)) {
      it(`emits one entry as \`element\` for \`${method}()\`, with or without a parameter annotation`, async () => {
        const listType = "Writable<Entry[] | Default<[]>>";
        const annotated = await callbackSchemas(listType, true, expression);
        const unannotated = await callbackSchemas(listType, false, expression);

        expect(annotated.map(elementOf)).toEqual([{ $ref: "#/$defs/Entry" }]);
        expect(annotated).toEqual(unannotated);
      });
    }

    for (const absent of ["undefined", "null"]) {
      it(`emits one entry as \`element\` for \`T[] | ${absent}\``, async () => {
        const schemas = await callbackSchemas(
          `Writable<Entry[] | ${absent}>`,
          true,
          "entries.map((entry) => <span>{entry?.name}</span>)",
        );

        expect(schemas.map(elementOf)).toEqual([{ $ref: "#/$defs/Entry" }]);
      });
    }
  });

  describe("an array receiver", () => {
    // The receiver is the list here, so its element is emitted whole and is
    // never read as a list type in turn.

    it("emits a row as `element` for a list of lists", async () => {
      const schemas = await callbackSchemas(
        "Entry[][]",
        true,
        "entries.map((row) => <span>{row.length}</span>)",
      );

      expect(schemas.map(elementOf)).toEqual([{
        type: "array",
        items: { $ref: "#/$defs/Entry" },
      }]);
    });

    it("emits the union of a tuple's positions as `element`", async () => {
      const schemas = await callbackSchemas(
        "[string, number]",
        true,
        "entries.map((position) => <span>{String(position)}</span>)",
      );

      expect(schemas.map(elementOf)).toEqual([{ type: ["number", "string"] }]);
    });

    it("emits the whole element of an interface extending `Array<T>`", async () => {
      const schemas = await callbackSchemas(
        "Entries<string[] | number>",
        true,
        "entries.map((row) => <span>{String(row)}</span>)",
      );

      expect(schemas.map(elementOf)).toEqual([{
        anyOf: [{ type: "number" }, {
          type: "array",
          items: { type: "string" },
        }],
      }]);
    });

    it("emits a row as `element` for an interface extending `Array<T[]>`", async () => {
      const schemas = await callbackSchemas(
        "Entries<Entry[]>",
        true,
        "entries.map((row) => <span>{row.length}</span>)",
      );

      expect(schemas.map(elementOf)).toEqual([{
        type: "array",
        items: { $ref: "#/$defs/Entry" },
      }]);
    });

    it("emits the array's own element when that element is itself a union around an array", async () => {
      const schemas = await callbackSchemas(
        "(string[] | number)[]",
        true,
        "entries.map((row) => <span>{String(row)}</span>)",
      );

      expect(schemas.map(elementOf)).toEqual([{
        anyOf: [{ type: "number" }, {
          type: "array",
          items: { type: "string" },
        }],
      }]);
    });
  });
});
