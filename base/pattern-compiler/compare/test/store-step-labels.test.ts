import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../../../runtime/runner/src/builder/types.ts";
import { recordRelevantSchemaWritePolicyInput } from "../../../../runtime/runner/src/cell.ts";
import {
  consumedEntriesForRead,
  labelForConsumedEntries,
} from "../../../../runtime/runner/src/cfc/consumed-label.ts";
import { readStoredCfcMetadata } from "../../../../runtime/runner/src/cfc/metadata.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";
import { type Artifact, Instance } from "../../exec/executor.ts";
import { identifierOf, Ref } from "../../exec/store.ts";
import { inputClause } from "../generate.ts";
import { scenarioAudience } from "../harness.ts";
import { RuntimeTransactions } from "../runtime-transactions.ts";

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/** The names of the input clauses a label written as text holds, sorted. */
const clausesOf = (label: string): string[] =>
  [...new Set([...label.matchAll(/"input:([^"]+)"/g)].map(([, name]) => name))]
    .sort();

// `fixtures/result-tree.tsx` in the runtime's storage, with `items` and each
// item a document under a clause of its own: the labels the store step of
// the result stores at the count, the titles and the rows, after an append
// and after a rename.
describe("the labels the store step of a result that holds a tree stores", () => {
  const labels = async (
    change: (
      instance: Instance,
      append: (title: string) => Promise<void>,
    ) => Promise<void>,
  ) => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    const space = signer.did();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: true },
      servingPosture: true,
    });
    const artifact = await artifactOf("result-tree");
    const id = identifierOf({ test: "result-tree" });
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: id,
      artifact,
    });
    try {
      const audience = await scenarioAudience();
      const schemaOf = (name: string) =>
        ({
          ifc: { confidentiality: [inputClause(name, audience)] },
        }) as JSONSchema;
      const documents: { id: string; kind: string; value: unknown }[] = [];
      const held = async (name: string, value: unknown) => {
        const tx = runtime.edit();
        const schema = schemaOf(name);
        const cell = runtime.getCell(space, { treeInput: name }, schema, tx);
        const link = cell.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        cell.set(value);
        expect((await tx.commit().settled).error).toBeUndefined();
        hooks.external(link.id);
        return link.id;
      };
      const link = (doc: string) => ({ $link: { doc, path: [] } });
      const ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        const item = await held(`item-${index}`, { title: `t${index}` });
        documents.push({
          id: item,
          kind: "input",
          value: { title: `t${index}` },
        });
        ids.push(item);
      }
      const items = await held("items", ids.map(link));
      documents.push({ id: items, kind: "input", value: ids.map(link) });
      const instance = new Instance(artifact, { items: link(items) }, {
        space,
        id,
        transactions: hooks,
        documents,
      });
      expect(await hooks.settled()).toEqual([]);
      await change(instance, async (title) => {
        const index = ids.length;
        const item = await held(`item-${index}`, { title });
        instance.store.create(item, "input", { title });
        ids.push(item);
        instance.store.write(new Ref(items, [`${index}`]), link(item));
        instance.settle();
        expect(await hooks.settled()).toEqual([]);
      });
      expect(await hooks.settled()).toEqual([]);
      const read = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(read, {
          space,
          id: hooks.entityOf(instance.id),
          scope: "space",
        });
        const at = (path: readonly string[]) =>
          clausesOf(JSON.stringify(
            (metadata === undefined ? undefined : labelForConsumedEntries(
              consumedEntriesForRead(metadata, path, {
                nonRecursive: false,
                consumes: "value",
              }),
              path,
              false,
            ))?.confidentiality ?? [],
          ));
        const list = ["$UI", "children", "1", "children", "0"];
        return {
          count: at(["count"]),
          titles: at(["titles"]),
          heading: at(["$UI", "children", "0", "children", "0"]),
          list: at(list),
          rows: ids.map((_, index) =>
            at([...list, `${index}`, "children", "0", "children", "0"])
          ),
        };
      } finally {
        read.abort();
      }
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  };

  it("stores at the count and the titles the clauses of every item and of the array, after an append", async () => {
    const stored = await labels(async (_, append) => {
      await append("t3");
    });

    const every = ["item-0", "item-1", "item-2", "item-3", "items"];
    expect(stored.count).toEqual(every);
    expect(stored.titles).toEqual(every);
    // The tree holds what it held, with the label it was first stored
    // under.
    expect(stored.heading).toEqual(["item-0", "item-1", "item-2", "items"]);
    expect(stored.list).toEqual(["items"]);
    expect(stored.rows).toEqual([
      ["items"],
      ["items"],
      ["items"],
      ["items"],
    ]);
  });

  it("stores the same labels after an append and a rename", async () => {
    const stored = await labels(async (instance, append) => {
      await append("t3");
      instance.send(
        instance.plan.bindings.findIndex(({ name }) => name === "rename"),
        { at: 1, title: "renamed" },
      );
      instance.settle();
    });

    const every = ["item-0", "item-1", "item-2", "item-3", "items"];
    expect(stored.count).toEqual(every);
    expect(stored.titles).toEqual(every);
    expect(stored.heading).toEqual(["item-0", "item-1", "item-2", "items"]);
    expect(stored.list).toEqual(["items"]);
  });
});
