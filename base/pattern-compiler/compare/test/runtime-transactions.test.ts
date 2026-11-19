import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../../logger/src/logger.ts";
import type { JSONSchema } from "../../../../runtime/runner/src/builder/types.ts";
import type { MemorySpace } from "../../../../runtime/runner/src/cell.ts";
import { readStoredCfcMetadata } from "../../../../runtime/runner/src/cfc/metadata.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";
import { type Artifact, Instance } from "../../exec/executor.ts";
import { identifierOf, isLink, Ref, Store } from "../../exec/store.ts";
import { inputClause } from "../generate.ts";
import { scenarioAudience } from "../harness.ts";
import { labeledInputs } from "../integrated.ts";
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

const bindingOf = (instance: Instance, name: string): number =>
  instance.plan.bindings.findIndex((binding) => binding.name === name);

/** A value with the schema of each link left out. */
const withoutSchemas = (value: unknown): unknown => {
  if (isLink(value)) {
    return { $link: { doc: value.$link.doc, path: value.$link.path } };
  }
  if (Array.isArray(value)) return value.map(withoutSchemas);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, member]) => [
        name,
        withoutSchemas(member),
      ]),
    );
  }
  return value;
};

/** How many times the runtime prepared a commit for CFC. */
const preparations = (): number =>
  getTimingStatsBreakdown()["extended-storage-transaction"]?.prepareCfc
    ?.count ?? 0;

describe("RuntimeTransactions", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: MemorySpace;

  beforeEach(async () => {
    // The identity of the scenarios of the comparison, whose space is the
    // audience that every generated clause names as an alternative
    // (`scenarioAudience`).
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
    });
    resetAllTimingStats();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** An instance of the fixture `handler.tsx` whose documents the runtime keeps. */
  const started = async (
    argument: Record<string, unknown>,
    documents: { id: string; kind: string; value: unknown }[] = [],
  ) => {
    const hooks = new RuntimeTransactions(runtime, space);
    const instance = new Instance(await artifactOf("handler"), argument, {
      space,
      id: identifierOf({ test: "runtime-transactions" }),
      transactions: hooks,
      documents,
    });
    expect(await hooks.settled()).toEqual([]);
    return { hooks, instance };
  };

  it("holds in storage every document the executor's commits wrote, as the executor holds it", async () => {
    const { hooks, instance } = await started({ secret: "s", note: "n" });
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    expect(await hooks.settled()).toEqual([]);

    const stored = hooks.stored();
    expect([...stored.keys()].sort()).toEqual(
      [...instance.store.docs.keys()].sort(),
    );
    for (const [doc, value] of stored) {
      expect(withoutSchemas(value)).toEqual(
        withoutSchemas(instance.store.docs.get(doc)?.value),
      );
    }
  });

  it("holds the whole default of a state cell that a write below its root created", async () => {
    // `fixtures/state-below.tsx`: `retitle` writes `draft/text` of a cell
    // whose default is `{ text: "", tags: ["new"] }` and which has no
    // document before the write.
    const hooks = new RuntimeTransactions(runtime, space);
    const instance = new Instance(
      await artifactOf("state-below"),
      { items: [], words: [] },
      {
        space,
        id: identifierOf({ test: "runtime-transactions" }),
        transactions: hooks,
      },
    );
    const retitle = instance.plan.bindings.findIndex((binding) =>
      binding.name === "retitle" &&
      binding.within.every((step) => step.element === undefined)
    );
    instance.send(retitle, { text: "t" });
    expect(await hooks.settled()).toEqual([]);

    const draft = instance.stateCells().find(({ name }) => name === "draft");
    expect(draft?.value).toEqual({ text: "t", tags: ["new"] });
    expect(hooks.stored().get(draft!.id)).toEqual({
      text: "t",
      tags: ["new"],
    });
  });

  it("holds a member written below a stored value that held no container", async () => {
    // Two transactions of the store: the first stores a document whose
    // root holds no container, and the second writes below that root.
    const hooks = new RuntimeTransactions(runtime, space);
    const store = new Store({ parts: false });
    store.onChange = ({ doc, path, covers, schema }) =>
      hooks.change(doc, covers ?? path, store, schema);
    hooks.begin("derivation");
    store.create("fid1:below", "state", undefined);
    hooks.end({ committed: true });
    hooks.begin("derivation");
    store.write(new Ref("fid1:below", ["a", "b"]), 1);
    hooks.end({ committed: true });
    expect(await hooks.settled()).toEqual([]);

    expect(hooks.stored().get("fid1:below")).toEqual({ a: { b: 1 } });
  });

  it("stores the clause that the declared type of a write gives, where the handler read no labeled input", async () => {
    // `fixtures/declared-writes.tsx`: `overwrite` sets `mine`, whose type
    // is `Confidential<string, ["alice"]>`.
    const hooks = new RuntimeTransactions(runtime, space);
    const instance = new Instance(
      await artifactOf("declared-writes"),
      { mine: "m", sealed: [] },
      {
        space,
        id: identifierOf({ test: "runtime-transactions" }),
        transactions: hooks,
      },
    );
    instance.send(bindingOf(instance, "overwrite"), {});
    expect(await hooks.settled()).toEqual([]);

    const read = runtime.edit();
    try {
      const metadata = readStoredCfcMetadata(read, {
        space,
        id: hooks.entityOf(instance.argument),
        scope: "space",
      });
      expect(JSON.stringify(metadata ?? {})).toContain("alice");
    } finally {
      read.abort();
    }
  });

  it("keeps every document of the executor loaded through the release passes of the replica", async () => {
    // A document the replica drops reads as absent at seq 0 through a
    // transaction, and a commit that read it is refused as a stale read.
    // A pass releases only a watched document, and keeps one read since
    // the previous pass, so each document is watched and two passes run.
    const { hooks, instance } = await started({ secret: "s", note: "n" });
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    expect(await hooks.settled()).toEqual([]);
    const provider = runtime.storageManager.open(space);
    for (const doc of instance.store.docs.keys()) {
      expect((await provider.sync(hooks.entityOf(doc))).error).toBeUndefined();
    }
    await runtime.storageManager.releaseUnreadDocuments?.();
    await runtime.storageManager.releaseUnreadDocuments?.();

    const { replica } = runtime.storageManager.open(space);
    for (const doc of instance.store.docs.keys()) {
      const view = replica.speculationRetirementView?.(
        hooks.entityOf(doc),
        "space",
      );
      expect({ doc, confirmed: (view?.confirmedSeq ?? 0) > 0 }).toEqual({
        doc,
        confirmed: true,
      });
      expect(view?.pendingLocalSeqs).toEqual([]);
    }
  });

  it("writes a labeled input with the records of its array in place, as a lift's result is written", async () => {
    const schema = {
      type: "array",
      items: { type: "object", properties: { count: { type: "number" } } },
      ifc: {
        confidentiality: [inputClause("items", await scenarioAudience())],
      },
    } as JSONSchema;
    const value = [{ count: 1 }, { count: 2 }];
    const { given, documents } = await labeledInputs(
      runtime,
      space,
      { items: { schema } },
      { items: value },
      new RuntimeTransactions(runtime, space),
    );

    expect(documents.map(({ value }) => value)).toEqual([value]);
    expect(given.items).toEqual({ $link: { doc: documents[0].id, path: [] } });
    const read = runtime.edit();
    try {
      const address = {
        space,
        id: documents[0].id as `of:${string}`,
        path: [],
        scope: "space" as const,
      };
      expect(read.readValueOrThrow(address)).toEqual(value);
      expect(readStoredCfcMetadata(read, address)).toBeDefined();
    } finally {
      read.abort();
    }
  });

  it("commits one transaction of the runtime for each transaction the executor commits", async () => {
    const { hooks, instance } = await started({ secret: "s", note: "n" });
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    expect(await hooks.settled()).toEqual([]);

    // The append of the event and the watermark that passes it are
    // transactions of their own in the runtime.
    const committed: Record<string, number> = { send: 1, watermark: 1 };
    for (
      const { cause } of instance.transactions.filter((tx) => tx.committed)
    ) {
      committed[cause] = (committed[cause] ?? 0) + 1;
    }
    expect(hooks.counts.byCause).toEqual(committed);
    expect(hooks.counts.aborted).toBe(
      instance.transactions.filter(({ committed }) => !committed).length,
    );
    expect(hooks.counts.reads).toBeGreaterThan(0);
  });

  it("stores labels on what a handler writes where it read a labeled input", async () => {
    // The input is a cell of its own whose schema declares a clause, as
    // the harness of today's runtime writes an input; the argument links
    // to it.
    const tx = runtime.edit();
    const input = runtime.getCell<string>(
      space,
      { input: "secret" },
      {
        type: "string",
        ifc: {
          confidentiality: [inputClause("secret", await scenarioAudience())],
        },
      } as JSONSchema,
      tx,
    );
    input.set("s");
    const { error } = await tx.commit().settled;
    expect(error).toBeUndefined();
    const id = input.getAsNormalizedFullLink().id;

    const { hooks, instance } = await started(
      { secret: { $link: { doc: id, path: [] } }, note: "n" },
      [{ id, kind: "input", value: "s" }],
    );
    const before = preparations();
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    expect(await hooks.settled()).toEqual([]);

    expect(instance.result()).toMatchObject({ last: "ts" });
    expect(preparations()).toBeGreaterThan(before);
    const last = instance.stateCells().find(({ name }) => name === "last");
    expect(last).toBeDefined();
    const read = runtime.edit();
    try {
      const metadata = readStoredCfcMetadata(read, {
        space,
        id: hooks.entityOf(last!.id),
        scope: "space",
      });
      expect(metadata).toBeDefined();
    } finally {
      read.abort();
    }
  });

  it("stores no labels on what a handler writes where it read no labeled input", async () => {
    const { hooks, instance } = await started({ secret: "s", note: "n" });
    const before = preparations();
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    expect(await hooks.settled()).toEqual([]);

    expect(preparations()).toBe(before);
    const last = instance.stateCells().find(({ name }) => name === "last");
    const read = runtime.edit();
    try {
      expect(
        readStoredCfcMetadata(read, {
          space,
          id: hooks.entityOf(last!.id),
          scope: "space",
        }),
      ).toBeUndefined();
    } finally {
      read.abort();
    }
  });
});
