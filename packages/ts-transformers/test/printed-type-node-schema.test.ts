import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  callSchemas,
  callsNamed,
  emittedSchemas,
  literalToValue,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import { transformFiles, transformSource } from "./utils.ts";

const IMPORTS =
  `import { computed, type Default, pattern, Writable, type PerUser } from "commonfabric";
interface Box<T> { value: T; extra: string; }
`;

/** An emitted schema, read as a plain record. */
type Schema = Record<string, unknown>;

/**
 * The schemas of `c` in the first `computed()` capture and in the pattern
 * result, for a pattern returning its generic input binding `c`.
 */
async function schemasOfBinding(
  declaration: string,
  argument: string,
  read = "c",
): Promise<{ capture: unknown; result: unknown }> {
  const output = await transformSource(
    `${IMPORTS}interface Input<T> { c: ${declaration}; }
export default pattern<Input<${argument}>>(({ c }) => ({
  c,
  s: computed(() => JSON.stringify(${read})),
}));`,
    { types: COMMONFABRIC_TYPES, typeCheck: true },
  );
  const root = parseModule(output);
  const [capture] = callSchemas(root, "lift");
  return {
    capture: (capture!.properties as Schema).c,
    result: (patternSchemas(root).output.properties as Schema).c,
  };
}

/** The input and result schemas of the first `lift()` in `source`. */
async function liftSchemas(source: string): Promise<unknown[]> {
  const output = await transformSource(source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  const [lift] = callsNamed(parseModule(output), "lift");
  return lift!.arguments
    .filter(ts.isSatisfiesExpression)
    .map((argument) => literalToValue(argument.expression));
}

/** The schema of a `Box` whose `value` has the schema `value`. */
function box(value: unknown): Schema {
  return {
    type: "object",
    properties: { value, extra: { type: "string" } },
    required: ["value", "extra"],
  };
}

describe("printed type node schema", () => {
  describe("a generic binding whose printed type names a generic declaration", () => {
    it("reads the instantiated fields of a scoped array", async () => {
      const { capture, result } = await schemasOfBinding(
        "PerUser<Box<T>[]>",
        "number",
      );
      const scoped = {
        type: "array",
        items: box({ type: "number" }),
        scope: "user",
      };

      expect(capture).toEqual(scoped);
      expect(result).toEqual(scoped);
    });

    it("keeps a cell argument of the generic declaration", async () => {
      const { capture, result } = await schemasOfBinding(
        "PerUser<Box<T>[]>",
        "Writable<{ text: string }>",
      );
      const scoped = {
        type: "array",
        items: box({
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          asCell: ["cell"],
        }),
        scope: "user",
      };

      expect(capture).toEqual(scoped);
      expect(result).toEqual(scoped);
    });

    it("reads the instantiated fields of an array held in a cell", async () => {
      const { capture } = await schemasOfBinding(
        "Writable<Box<T>[]>",
        "number",
        "c.get()",
      );

      expect(capture).toEqual({
        type: "array",
        items: box({ type: "number" }),
        asCell: ["readonly"],
      });
    });
  });

  describe("a printed result type that holds `any`", () => {
    it("reads an element type the emitting module does not import", async () => {
      const output = await transformFiles({
        "/lib.ts": `export interface Entry { host: string; }
export function entriesOf(): Entry[] { return []; }`,
        "/main.tsx": `import { computed, pattern } from "commonfabric";
import { entriesOf } from "./lib.ts";
export default pattern<{ n: number }>(({ n }) => ({
  view: computed(() => ({ entries: entriesOf(), extra: n as any })),
}));`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });
      const [, result] = callSchemas(parseModule(output["/main.tsx"]!), "lift");

      expect(result).toEqual({
        type: "object",
        properties: {
          entries: { type: "array", items: { $ref: "#/$defs/Entry" } },
          extra: true,
        },
        required: ["entries", "extra"],
        $defs: {
          Entry: {
            type: "object",
            properties: { host: { type: "string" } },
            required: ["host"],
          },
        },
      });
    });
  });

  describe("a printed pattern result type that holds `any`", () => {
    it("reads an element type the emitting module does not import", async () => {
      const output = await transformFiles({
        "/lib.ts": `export interface Entry { host: string; }
export function entriesOf(): Entry[] { return []; }`,
        "/main.tsx": `import { pattern } from "commonfabric";
import { entriesOf } from "./lib.ts";
export default pattern<{ n: number }>(({ n }) => ({
  entries: entriesOf(),
  extra: n as any,
}));`,
      }, { types: COMMONFABRIC_TYPES, typeCheck: true });

      expect(patternSchemas(parseModule(output["/main.tsx"]!)).output).toEqual({
        type: "object",
        properties: {
          entries: { type: "array", items: { $ref: "#/$defs/Entry" } },
          extra: true,
        },
        required: ["entries", "extra"],
        $defs: {
          Entry: {
            type: "object",
            properties: { host: { type: "string" } },
            required: ["host"],
          },
        },
      });
    });
  });

  describe("a type the checker will not print", () => {
    it("reads an array of cells with an empty default by its type", async () => {
      const [, result] = await liftSchemas(
        `${IMPORTS}interface Item { title: string; attachments: Writable<any>[] | Default<[]>; }
interface Input { item: Item; }
export default pattern<Input>(({ item }) => {
  const attachments = computed(() => item.attachments ?? []);
  return { count: computed(() => attachments.length) };
});`,
      );

      expect(result).toEqual({
        type: "array",
        items: { asCell: ["cell"] },
        default: [],
      });
    });
  });

  describe("a pass reading inside a print", () => {
    // A pass that narrows, shrinks, or marks identity inside a print reads the
    // print's unfolding, each part printed afresh from its type, and leaves no
    // piece of the print for schema generation to read as a node.

    it("reads a member naming a type the module does not import by its type", async () => {
      const output = await transformSource(
        `import { computed, generateObject, pattern, UI } from "commonfabric";
interface Item { content: string; }
interface Sentiment { label: string; }
export default pattern<{ items: Item[] }>(({ items }) => {
  const analyses = items.map((item) => ({
    content: item.content,
    analysis: generateObject<Sentiment>({ prompt: item.content }),
  }));
  return {
    [UI]: (
      <div>
        {analyses.map((entry, i) => (
          <div key={i}>
            {computed(() => {
              const pending = entry.analysis.pending;
              const label = entry.analysis.result?.label;
              return pending ? "…" : label;
            })}
          </div>
        ))}
      </div>
    ),
  };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      // The element schema of the callback mapping `analyses`.
      const element = emittedSchemas(parseModule(output))
        .map((schema) =>
          (schema.properties as Schema | undefined)?.element as
            | Schema
            | undefined
        )
        .find((element) =>
          (element?.properties as Schema | undefined)?.analysis
        );

      expect(element).toMatchObject({
        properties: {
          analysis: {
            type: "object",
            properties: {
              pending: { type: "boolean" },
              result: {
                anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Sentiment" }],
              },
            },
          },
        },
      });
    });

    it("narrows a cell inside a printed literal and reads its other members by type", async () => {
      const output = await transformSource(
        `import { type Cell, computed, pattern, UI } from "commonfabric";
type ProfileCell = Cell<{ name?: string }>;
export default pattern<{ profiles: ProfileCell[] }>(({ profiles }) => {
  const participants = computed<{ name: string; profile: ProfileCell }[]>(() =>
    profiles.map((profile) => ({ name: "someone", profile }))
  );
  return {
    [UI]: <div>{participants.map((p) => <cf-profile-badge $profile={p.profile} />)}</div>,
  };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const element = emittedSchemas(parseModule(output))
        .map((schema) =>
          (schema.properties as Schema | undefined)?.element as
            | Schema
            | undefined
        )
        .find((element) => element !== undefined);

      expect(element).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          profile: {
            type: "object",
            properties: { name: { type: "string" } },
            asCell: ["readonly"],
          },
        },
        required: ["name", "profile"],
      });
    });

    it("keeps a scoped cell whole where its capture is narrowed", async () => {
      // Only the scope wrapper names the scope, which a narrowed wrapper around
      // the cell's value would drop.
      const output = await transformSource(
        `import { computed, pattern, UI, Writable } from "commonfabric";
export default pattern<Record<string, never>>(() => {
  const confirming = Writable.perSession.of<boolean>(false);
  const isConfirming = computed(() => confirming.get());
  return { [UI]: <div>{isConfirming ? "yes" : "no"}</div> };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const root = parseModule(output);
      const [lift] = callsNamed(root, "lift");
      const captures = lift!.typeArguments![0]! as ts.TypeLiteralNode;
      const confirming = captures.members.find(ts.isPropertySignature)!;

      expect(confirming.type!.getText(root)).toBe(
        "__cfHelpers.PerSession<__cfHelpers.Cell<boolean>>",
      );
      expect((callSchemas(root, "lift")[0]!.properties as Schema).confirming)
        .toEqual({
          type: "boolean",
          asCell: [{ kind: "cell", scope: "session" }],
        });
    });

    it("reads elements compared only by identity inside a printed value as comparable", async () => {
      const [capture] = await liftSchemas(
        `import { computed, equals, pattern, Writable } from "commonfabric";
interface Note { title: string; body: string; }
export default pattern<{
  doc: Writable<{ notes?: Note[]; title: string }>;
  self: Note;
}>(({ doc, self }) => ({
  found: computed(() => (doc.get().notes ?? []).some((n) => equals(n, self))),
}));`,
      );

      expect((capture as Schema).properties).toMatchObject({
        doc: {
          properties: {
            notes: {
              type: "array",
              items: { type: "unknown", asCell: ["comparable"] },
            },
          },
        },
      });
    });
  });
});
