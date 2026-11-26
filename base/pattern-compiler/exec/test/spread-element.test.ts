import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

/** The pattern of `compare/fixtures/<name>.tsx`. */
const artifact = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../../compare/fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns[0];
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

/**
 * The result of an instance of the fixture `name` over `items`, two references to documents of
 * their own, `rows`, two plain values in place, and `extra`, a record in
 * place.
 */
const result = async (
  name = "spread-element",
): Promise<Record<string, unknown>> => {
  const instance = new Instance(
    await artifact(name),
    {
      items: [link("item-a"), link("item-b")],
      rows: [{ title: "r", done: false, note: "n" }, { title: "s" }],
      extra: { tag: "t", done: false },
    },
    {
      documents: [
        {
          id: "item-a",
          kind: "item",
          value: { title: "a", done: false, note: "first" },
        },
        { id: "item-b", kind: "item", value: { title: "b", done: true } },
      ],
    },
  );
  return instance.result() as Record<string, unknown>;
};

// `fixtures/spread-element.tsx`: object literals with a spread, in the
// bodies of `lift` functions, which run in JavaScript.
describe("spread-element", () => {
  describe("a spread of an element in a function body, with a member behind it", () => {
    it("keeps the members of each element of an array of references", async () => {
      expect((await result()).ofReferences).toEqual([
        { title: "a", done: true, note: "first" },
        { title: "b", done: true },
      ]);
    });

    it("keeps the members of each element of an array of plain values in place", async () => {
      expect((await result()).ofPlain).toEqual([
        { title: "r", done: true, note: "n" },
        { title: "s", done: true },
      ]);
    });

    it("keeps the members of each element of the result of a `filter` over an array of references", async () => {
      expect((await result()).ofFilter).toEqual([
        { title: "a", done: true, note: "first" },
      ]);
    });

    it("keeps the members of each element of the result of a `map`", async () => {
      expect((await result()).ofMap).toEqual([
        { title: "a", note: "mapped", done: true },
        { title: "b", note: "mapped", done: true },
      ]);
    });

    it("keeps the members of one element read by its index", async () => {
      expect((await result()).first).toEqual({
        title: "a",
        done: true,
        note: "first",
      });
    });
  });

  describe("a spread of an element of an array of references in a function body", () => {
    it("copies every member where the spread is the whole literal", async () => {
      expect((await result()).copies).toEqual([
        { title: "a", done: false, note: "first" },
        { title: "b", done: true },
      ]);
    });

    it("replaces a member written before it, and leaves one the element lacks", async () => {
      expect((await result()).before).toEqual([
        { title: "a", done: false, note: "first" },
        { title: "b", done: true, note: "none" },
      ]);
    });

    it("replaces a member before it and gives way to a member behind it", async () => {
      expect((await result()).both).toEqual([
        { title: "a", done: true, note: "first" },
        { title: "b", done: true, note: "replaced" },
      ]);
    });
  });

  it("keeps the members of a record that is no element, spread in a function body beside a member of each element", async () => {
    expect((await result()).withExtra).toEqual([
      { tag: "t", done: false, title: "a" },
      { tag: "t", done: false, title: "b" },
    ]);
  });

  // `fixtures/spread-element-reactive.tsx`: the same literals in the
  // callback of a `map` of the reactive tier.
  describe("a spread in the reactive tier", () => {
    const reactive = () => result("spread-element-reactive");

    it("keeps the members of each element of an array of references", async () => {
      expect((await reactive()).ofReferences).toEqual([
        { title: "a", done: true, note: "first" },
        { title: "b", done: true },
      ]);
    });

    it("keeps the members of each element of an array of plain values in place", async () => {
      expect((await reactive()).ofPlain).toEqual([
        { title: "r", done: true, note: "n" },
        { title: "s", done: true },
      ]);
    });

    it("keeps the members of each element of the result of a `filter` over an array of references", async () => {
      expect((await reactive()).ofFilter).toEqual([
        { title: "a", done: true, note: "first" },
      ]);
    });

    it("replaces a member written before the spread of an element", async () => {
      expect((await reactive()).before).toEqual([
        { title: "a", done: false, note: "first" },
        { title: "b", done: true },
      ]);
    });

    it("keeps the members of a record that is no element beside a member of each element", async () => {
      expect((await reactive()).withExtra).toEqual([
        { tag: "t", done: false, title: "a" },
        { tag: "t", done: false, title: "b" },
      ]);
    });
  });
});
