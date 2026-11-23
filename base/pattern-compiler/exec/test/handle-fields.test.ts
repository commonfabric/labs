import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../executor.ts";
import { Ref } from "../store.ts";

/** The artifact of `compare/fixtures/handle-fields.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/handle-fields.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns[patterns.length - 1];
};

/** An instance over three items, each a document of its own. */
const started = async () => {
  const documents = [0, 1, 2].map((index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { id: `i${index}`, title: `t${index}`, done: index === 1 },
  }));
  const instance = new Instance(
    await artifact(),
    { items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
    { documents },
  );
  return instance;
};

describe("a read through a handle whose declared type names its fields", () => {
  it("gives the body the fields the type names", async () => {
    const instance = await started();

    expect(instance.result()).toEqual({ done: 1 });
  });

  it("evaluates the body again when a field the type names changes", async () => {
    const instance = await started();
    const before = instance.counts.evaluations;

    instance.store.write(new Ref("item-0", ["done"]), true);
    instance.settle();

    expect(instance.result()).toEqual({ done: 2 });
    expect(instance.counts.evaluations).toBeGreaterThan(before);
  });

  // Not built (note 582 of `SPEC-NOTES.md`): the plan holds no schema for
  // the type a body declares for a handle, so the executor reads a member
  // under the type of the place, which names every field.
  it.ignore("does not evaluate the body again when a field the type does not name changes", async () => {
    const instance = await started();
    const before = instance.counts.evaluations;

    instance.store.write(new Ref("item-0", ["title"]), "edited");
    instance.settle();

    expect(instance.result()).toEqual({ done: 1 });
    expect(instance.counts.evaluations).toBe(before);
  });

  it("evaluates the body again when a member is replaced whole", async () => {
    const instance = await started();

    instance.store.write(new Ref("item-0", []), {
      id: "i0",
      title: "t0",
      done: true,
    });
    instance.settle();

    expect(instance.result()).toEqual({ done: 2 });
  });

  // Not built, as the case before.
  it.ignore("reports to the transaction hooks the positions of the fields and not the root of a member", async () => {
    const read: string[] = [];
    const documents = [0, 1].map((index) => ({
      id: `item-${index}`,
      kind: "item",
      value: { id: `i${index}`, title: `t${index}`, done: false },
    }));
    new Instance(
      await artifact(),
      { items: documents.map(({ id }) => ({ $link: { doc: id, path: [] } })) },
      {
        documents,
        transactions: {
          begin: () => {},
          read: (doc, path) => {
            if (doc.startsWith("item-")) read.push(`${doc}/${path.join("/")}`);
          },
          change: () => {},
          end: () => {},
        },
      },
    );

    expect(new Set(read)).toEqual(new Set(["item-0/done", "item-1/done"]));
  });
});
