import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";

/** The pattern of `compare/fixtures/returned-links.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/returned-links.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns[0];
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

/**
 * The result document of an instance over two items that are documents of
 * their own, two plain values in place, and a record that links the first
 * item, as stored.
 */
const stored = async (): Promise<Record<string, unknown>> => {
  const instance = new Instance(
    await artifact(),
    {
      items: [link("item-a"), link("item-b")],
      rows: [{ title: "r" }, { title: "s" }],
      holder: { item: link("item-a") },
    },
    {
      documents: [
        { id: "item-a", kind: "item", value: { title: "a" } },
        { id: "item-b", kind: "item", value: { title: "b" } },
      ],
    },
  );
  instance.result();
  return instance.store.docs.get(instance.id)!.value as Record<
    string,
    unknown
  >;
};

/** The document and path a stored link names, or the value it is not. */
const target = (value: unknown) =>
  typeof value === "object" && value !== null && "$link" in value
    ? {
      doc: (value as { $link: { doc: string } }).$link.doc,
      path: (value as { $link: { path: string[] } }).$link.path,
    }
    : value;

// `fixtures/returned-links.tsx`: `lift` bodies that return a value they
// read through a link (ES §2.4, "A value passed on unchanged is stored as
// a reference"), over `items`, an array of references, `rows`, an array of
// plain values in place, and `holder`, a record with a link at `item`.
describe("returned-links", () => {
  it("stores a link where a body returns an element of an array of references declared `unknown` (case a)", async () => {
    expect(target((await stored()).element)).toEqual({
      doc: "item-a",
      path: [],
    });
  });

  it("stores a link where a body returns an element of an array of references declared by its type (case a)", async () => {
    expect(target((await stored()).typedElement)).toEqual({
      doc: "item-a",
      path: [],
    });
  });

  it("stores a link to the argument's position where a body returns the array of references itself (case b)", async () => {
    expect(target((await stored()).array)).toMatchObject({ path: ["items"] });
  });

  it("stores a link where a body returns a member it reached through a link at a static path (case c)", async () => {
    expect(target((await stored()).member)).toEqual({
      doc: "item-a",
      path: [],
    });
  });

  it("stores a copy where a body returns an element of an array of plain values in place, which has no document of its own (case d)", async () => {
    expect((await stored()).row).toEqual({ title: "r" });
  });

  it("stores a link inside a record the body builds around an element of an array of references (case e)", async () => {
    const { picked } = (await stored()) as { picked: { picked: unknown } };

    expect(target(picked.picked)).toEqual({ doc: "item-a", path: [] });
  });

  it("stores a link for each element of an array of references that a `filter` in a body keeps (case e)", async () => {
    const { kept } = (await stored()) as { kept: unknown[] };

    expect(kept.map(target)).toEqual([
      { doc: "item-a", path: [] },
      { doc: "item-b", path: [] },
    ]);
  });

  it("stores a new value where a body changed a member of an element", async () => {
    expect((await stored()).renamed).toEqual({ title: "a!" });
  });

  it("stores the value where a body read a member of an element and returned the member", async () => {
    expect((await stored()).title).toBe("a");
  });
});
