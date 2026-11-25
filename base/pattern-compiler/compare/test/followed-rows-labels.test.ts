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

// `fixtures/followed-rows.tsx` in the runtime's storage: `items` and `notes`
// in one document under the clause `list`, each item a document under a
// clause of its own that links to the owner, a document under the clause
// `owner`. The labels stored at the count and at each row, after two items
// are appended: an append changes the labels of the list document at the
// appended item, and no label a row's record reads there.
describe("the labels stored at rows that follow a link and name the facts", () => {
  const labels = async (appended: number, byHandler = false) => {
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
    const artifact = await artifactOf("followed-rows");
    const id = identifierOf({ test: "followed-rows" });
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
        const cell = runtime.getCell(
          space,
          { followedInput: name },
          schema,
          tx,
        );
        const link = cell.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        cell.set(value);
        expect((await tx.commit().settled).error).toBeUndefined();
        hooks.external(link.id);
        documents.push({ id: link.id, kind: "input", value });
        return link.id;
      };
      const link = (doc: string, path: string[] = []) => ({
        $link: { doc, path },
      });
      const owner = await held("owner", { name: "Ada" });
      const ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        ids.push(
          await held(`item-${index}`, {
            title: `t${index}`,
            owner: link(owner),
          }),
        );
      }
      const list = await held("list", {
        items: ids.map((item) => link(item)),
        notes: [{ title: "t0" }],
      });
      const instance = new Instance(artifact, {
        items: link(list, ["items"]),
        notes: link(list, ["notes"]),
        owner: link(owner),
      }, {
        space,
        id,
        transactions: hooks,
        documents,
      });
      expect(await hooks.settled()).toEqual([]);
      const add = instance.plan.bindings.findIndex(({ name }) =>
        name === "add"
      );
      for (let added = 0; added < appended && byHandler; added++) {
        instance.send(add, { title: `added ${added}` });
        instance.settle();
        expect(await hooks.settled()).toEqual([]);
      }
      for (let added = 0; added < appended && !byHandler; added++) {
        const index = ids.length;
        const value = { title: `t${index}`, owner: link(owner) };
        const item = await held(`item-${index}`, value);
        instance.store.create(item, "input", value);
        ids.push(item);
        instance.store.write(new Ref(list, ["items", `${index}`]), link(item));
        instance.settle();
        expect(await hooks.settled()).toEqual([]);
      }
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
        const row = (index: number, child: number) =>
          at(["$UI", "children", "0", `${index}`, "children", `${child}`]);
        // The document that the handler keeps the result of the instance
        // in, and what it appended to the list.
        const kept = [...instance.store.docs].find(([, { kind }]) =>
          kind === "state cell"
        )?.[0];
        const stored = (doc: string, path: readonly string[]) => {
          const held = readStoredCfcMetadata(read, {
            space,
            id: hooks.entityOf(doc),
            scope: "space",
          });
          return clausesOf(JSON.stringify(
            (held === undefined ? undefined : labelForConsumedEntries(
              consumedEntriesForRead(held, path, {
                nonRecursive: false,
                consumes: "value",
              }),
              path,
              false,
            ))?.confidentiality ?? [],
          ));
        };
        return {
          kept: kept === undefined ? undefined : stored(kept, []),
          appended: Array.from(
            { length: byHandler ? appended : 0 },
            (_, added) => stored(list, ["items", `${3 + added}`]),
          ),
          count: at(["count"]),
          titles: ids.map((_, index) => row(index, 0)),
          owners: ids.map((_, index) => row(index, 1)),
          lookUps: ids.map((_, index) => row(index, 2)),
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

  it("stores at the count the clauses of every item, and at each row those of the inputs it was given", async () => {
    const stored = await labels(2);

    const items = (count: number) =>
      Array.from({ length: count }, (_, index) => `item-${index}`);
    expect(stored.count).toEqual([...items(5), "list"]);
    expect(stored.titles).toEqual(items(5).map(() => ["list"]));
    expect(stored.owners).toEqual(items(5).map(() => ["list", "owner"]));
    // The look-up of a row names the facts, whose inputs were those of the
    // items there were when the row was given; an append forms no row's
    // label again, the appended one's aside.
    expect(stored.lookUps).toEqual([
      [...items(3), "list"],
      [...items(3), "list"],
      [...items(3), "list"],
      [...items(4), "list"],
      [...items(5), "list"],
    ]);
  });

  it("stores at what the handler writes the clauses of what it reads, after two adds", async () => {
    // The handler reads whether the result of the instance is there, which
    // is a read of which children the result holds and of none of them.
    const stored = await labels(2, true);

    const read = ["item-0", "item-1", "item-2", "list", "owner"];
    expect(stored.kept).toEqual(read);
    expect(stored.appended).toEqual([read, read]);
  });
});
