import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const IMPORTS =
  `import { computed, pattern, Writable, type Default, type PerSession, type PerUser } from "commonfabric";
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

    it("keeps the empty default of an array declared on a nested property", async () => {
      const capture = await captureOf(`
interface Roster { people: Person[] | Default<[]>; }
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
            default: [],
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

    it("shrinks an array declared through an alias to the element fields read", async () => {
      const output = await transformSource(
        `import { lift } from "commonfabric";
type Item = { name: string; extra: string };
type Items = Item[];
export const names = lift((input: { items: Items }) =>
  input.items.map((item) => item.name)
);`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const [input] = callSchemas(parseModule(output), "lift");

      expect((input!.properties as Schema).items).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
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

    it("keeps the scope and empty default of a generic array binding", async () => {
      const capture = await captureOf(readingElementsOf(
        `interface Input<T> { c: PerUser<T[] | Default<[]>>; }`,
        "Box<number>",
      ));

      expect(capture.c).toEqual({
        type: "array",
        items: VALUE_ONLY,
        default: [],
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

    const ARRAY = "PerUser<Box<number>[]>";
    for (
      const [form, declaration, wrapper] of [
        ["an alias of", `type Rec = ${ARRAY};`, ARRAY],
        [
          "an alias of an alias of",
          `type Inner = ${ARRAY};\ntype Rec = Inner;`,
          ARRAY,
        ],
        [
          "a generic alias of",
          "type Scoped<T> = PerUser<T[]>;\ntype Rec = Scoped<Box<number>>;",
          ARRAY,
        ],
      ]
    ) {
      it(`gives an array typed by ${form} ${wrapper} the schema of the wrapper written in place`, async () => {
        const aliased = await captureOf(readingElementsOf(
          `${declaration}\ninterface Input { c: Rec; }`,
        ));
        const direct = await captureOf(readingElementsOf(
          `interface Input { c: ${wrapper}; }`,
        ));

        expect(direct.c).toMatchObject({ scope: "user" });
        expect(aliased.c).toEqual(direct.c);
      });
    }

    it("keeps the scope and the type of a boolean typed by an alias of a scope wrapper", async () => {
      // The checker holds `boolean` as `false | true`, so the brand a wrapper
      // leaves on it is distributed over two literals. The pair is read back
      // as the type the author wrote, rather than shrunk literal by literal.
      const capture = await captureOf(`
type Flag = PerSession<boolean>;
interface Row { flag: Flag; value: number; extra: string; }
interface Input { c: Row[]; }
export default pattern<Input>(({ c }) => ({
  s: computed(() => c.map((x) => x.flag)),
}));`);

      expect(capture.c).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: { flag: { type: "boolean", scope: "session" } },
          required: ["flag"],
        },
      });
    });

    it("gives an array typed by an alias of a scope wrapper around a union one alternative per member", async () => {
      // The brand a wrapper leaves on a union is distributed over its members,
      // so each member is shrunk on its own. The wrapper written in place
      // names the union itself, and shrinks it to a single array whose element
      // type is the union of the members' element types.
      const capture = await captureOf(readingElementsOf(
        `type Rec = PerUser<Box<number>[] | Box<string>[]>;
interface Input { c: Rec; }`,
      ));

      expect(capture.c).toEqual({
        anyOf: [
          { type: "array", items: VALUE_ONLY },
          {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
        scope: "user",
      });
    });
  });

  describe("a capture of a scoped cell", () => {
    it("keeps the readonly narrowing, unread elements, and scope of a cell read for its length", async () => {
      // Only the scope wrapper names the scope, so the narrowed and shrunk
      // cell is put back inside it.
      const capture = await captureOf(`
interface Input { c: PerUser<Writable<Box<number>[]>>; }
export default pattern<Input>(({ c }) => ({
  count: computed(() => c.get().length),
}));`);

      expect(capture.c).toEqual({
        type: "array",
        items: { type: "unknown" },
        asCell: [{ kind: "readonly", scope: "user" }],
      });
    });

    it("keeps the identity narrowing and scope of a cell whose elements are compared", async () => {
      const capture = await captureOf(`import { equals } from "commonfabric";
export default pattern<{ c: PerUser<Writable<Person[]>>; self: Person }>(
  ({ c, self }) => ({
    found: computed(() => c.get().some((p) => equals(p, self))),
  }),
);`);

      expect(capture.c).toEqual({
        type: "array",
        items: { type: "unknown", asCell: ["comparable"] },
        asCell: [{ kind: "readonly", scope: "user" }],
      });
    });
  });

  describe("a capture whose authored type keeps a default", () => {
    it("keeps an optional value's default at the top of its schema", async () => {
      // The runtime reads a missing property's default from the top of the
      // property's schema, not from inside one of its alternatives.
      const capture = await captureOf(`
interface Author { kind: string; name: string; avatar: string; }
interface Topic {
  title: string;
  createdBy?: Author | Default<{ kind: "person"; name: ""; avatar: "" }>;
}
export default pattern<{ topic: Topic }>(({ topic }) => ({
  who: computed(() => topic.createdBy?.name ?? ""),
}));`);

      expect(capture.topic).toEqual({
        type: "object",
        properties: {
          createdBy: {
            anyOf: [{ type: "undefined" }, {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            }],
            default: { kind: "person", name: "", avatar: "" },
          },
        },
      });
    });

    it("keeps a nullable value's default at the top of its schema", async () => {
      const capture = await captureOf(`
interface Topic { createdBy: Person | null | Default<{ name: ""; age: 0 }>; }
export default pattern<{ topic: Topic }>(({ topic }) => ({
  who: computed(() => topic.createdBy?.name ?? ""),
}));`);

      expect(capture.topic).toEqual({
        type: "object",
        properties: {
          createdBy: {
            anyOf: [{
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            }, { type: "null" }],
            default: { name: "", age: 0 },
          },
        },
        required: ["createdBy"],
      });
    });

    it("keeps an optional array's default at the top of its schema", async () => {
      const capture = await captureOf(`
interface Topic { tags?: string[] | Default<["a"]>; }
export default pattern<{ topic: Topic }>(({ topic }) => ({
  count: computed(() => topic.tags?.length ?? 0),
}));`);

      expect(capture.topic).toEqual({
        type: "object",
        properties: {
          tags: {
            anyOf: [
              { type: "array", items: { type: "unknown" } },
              { type: "undefined" },
            ],
            default: ["a"],
          },
        },
      });
    });

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
        type: ["string", "undefined"],
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
