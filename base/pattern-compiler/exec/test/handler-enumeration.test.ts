import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance, type TransactionHooks } from "../executor.ts";

/** The pattern of `compare/fixtures/handler-enumeration.tsx`. */
const artifact = async (): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../compare/fixtures/handler-enumeration.emit.json",
        import.meta.url,
      ),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find(({ name }) => name === "default")!;
};

const link = (doc: string) => ({ $link: { doc, path: [] } });

/**
 * An instance whose namespace holds `count` references, each to a document
 * of its own, with the documents that each transaction read.
 */
const started = async (count: number) => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    kind: "item",
    value: { title: `t${index}` },
  }));
  const read: string[] = [];
  const transactions: TransactionHooks = {
    begin: () => {},
    read: (doc) => {
      read.push(doc);
    },
    change: () => {},
    end: () => {},
  };
  const instance = new Instance(
    await artifact(),
    {
      names: Object.fromEntries(
        items.map(({ id }, index) => [`${index + 1}`, link(id)]),
      ),
    },
    { documents: items, transactions },
  );
  const binding = instance.plan.bindings.findIndex(({ name }) =>
    name === "file"
  );
  return { instance, read, file: () => instance.send(binding, { title: "n" }) };
};

describe("a handler that is handed a record of references as a cell and reads which names it holds", () => {
  it("chooses the name behind those the record holds", async () => {
    const { instance, file } = await started(3);

    expect(file().committed).toBe(true);

    expect((instance.result() as { last: string }).last).toBe("4");
  });

  it("reads no document that a member of the record refers to", async () => {
    const { read, file } = await started(3);
    read.length = 0;

    file();

    expect(read.filter((doc) => doc.startsWith("item-"))).toEqual([]);
  });
});
