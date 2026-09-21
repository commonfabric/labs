import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const IMPORTS =
  `import { computed, pattern, Writable, type Default, type PerUser } from "commonfabric";
interface Box<T> { value: T; extra: string; }
interface Person { name: string; age: number; }
`;

/** An emitted schema, read as a plain record. */
type Schema = Record<string, unknown>;

/** The properties of the schema of the first `computed()` capture in `source`. */
async function captureOf(source: string): Promise<Schema> {
  const output = await transformSource(IMPORTS + source, {
    types: COMMONFABRIC_TYPES,
    typeCheck: true,
  });
  const [capture] = callSchemas(parseModule(output), "lift");
  return capture!.properties as Schema;
}

/** A pattern whose `computed()` reads `value` from each element of `c`. */
function readingElementsOf(declaration: string, argument?: string): string {
  const input = argument === undefined ? "Input" : `Input<${argument}>`;
  return `${declaration}
export default pattern<${input}>(({ c }) => ({
  s: computed(() => c.map((x) => x.value)),
}));`;
}

// The schema of `Box<number>` with only `value` read.
const VALUE_ONLY = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
};

const BOX_DEFAULT = `Default<[{ value: 1; extra: "x" }]>`;

describe("shrunk capture wrappers", () => {
  describe("a capture shrunk to the element fields it reads", () => {
    it("keeps the default of an array declared on a nested property", async () => {
      const capture = await captureOf(`
interface Roster { people: Person[] | Default<[{ name: "a"; age: 1 }]>; }
interface Input { roster: Roster; }
export default pattern<Input>(({ roster }) => ({
  s: computed(() => roster.people.map((p) => p.name)),
}));`);

      expect(capture.roster).toEqual({
        type: "object",
        properties: {
          people: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            default: [{ name: "a", age: 1 }],
          },
        },
        required: ["people"],
      });
    });

    it("keeps the default of a generic array binding", async () => {
      const capture = await captureOf(readingElementsOf(
        `interface Input<T> { c: T[] | ${BOX_DEFAULT}; }`,
        "Box<number>",
      ));

      expect(capture.c).toEqual({
        type: "array",
        items: VALUE_ONLY,
        default: [{ value: 1, extra: "x" }],
      });
    });

    it("keeps the default of each element", async () => {
      const capture = await captureOf(readingElementsOf(
        `interface Input { c: (Box<number> | Default<{ value: 0; extra: "" }>)[]; }`,
      ));

      expect(capture.c).toEqual({
        type: "array",
        items: { ...VALUE_ONLY, default: { value: 0, extra: "" } },
      });
    });

    it("keeps the scope of an array declared in place", async () => {
      const capture = await captureOf(readingElementsOf(
        `interface Input { c: PerUser<Box<number>[]>; }`,
      ));

      expect(capture.c).toEqual({
        type: "array",
        items: VALUE_ONLY,
        scope: "user",
      });
    });

    it("keeps the scope of a generic array binding", async () => {
      const capture = await captureOf(readingElementsOf(
        `interface Input<T> { c: PerUser<T[]>; }`,
        "Box<number>",
      ));

      expect(capture.c).toEqual({
        type: "array",
        items: VALUE_ONLY,
        scope: "user",
      });
    });

    it("keeps the scope and default of a generic array binding", async () => {
      const capture = await captureOf(readingElementsOf(
        `interface Input<T> { c: PerUser<T[] | ${BOX_DEFAULT}>; }`,
        "Box<number>",
      ));

      expect(capture.c).toEqual({
        type: "array",
        items: VALUE_ONLY,
        default: [{ value: 1, extra: "x" }],
        scope: "user",
      });
    });
  });

  describe("a capture of a scoped cell", () => {
    it("keeps the readonly narrowing and unread elements of a cell read for its length", async () => {
      const capture = await captureOf(`
interface Input { c: PerUser<Writable<Box<number>[]>>; }
export default pattern<Input>(({ c }) => ({
  count: computed(() => c.get().length),
}));`);
      const { items, asCell } = capture.c as {
        items: unknown;
        asCell: (string | { kind: string })[];
      };

      expect(items).toEqual({ type: "unknown" });
      expect(
        asCell.map((entry) => typeof entry === "string" ? entry : entry.kind),
      )
        .toEqual(["readonly"]);
    });
  });

  describe("a capture whose authored type keeps a default", () => {
    it("keeps the capability of a cell captured beside it", async () => {
      const capture = await captureOf(`
interface Input {
  note: { title?: string; content?: string } | Default<{ title: ""; content: "" }>;
  content?: Writable<string | undefined>;
}
export default pattern<Input>(({ note, content }) => ({
  s: computed(() => content?.get?.() ?? note?.content ?? ""),
}));`);

      expect(capture.content).toEqual({
        anyOf: [
          { anyOf: [{ type: "string" }, { type: "undefined" }] },
          { type: "undefined" },
        ],
        asCell: ["readonly"],
      });
      expect(capture.note).toEqual({
        type: "object",
        properties: { content: { type: "string" } },
        default: { title: "", content: "" },
      });
    });
  });
});
