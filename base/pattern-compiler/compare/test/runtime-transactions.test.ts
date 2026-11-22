import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";

import {
  getTimingStatsBreakdown,
  resetAllTimingStats,
} from "../../../logger/src/logger.ts";
import type { JSONSchema } from "../../../../runtime/runner/src/builder/types.ts";
import {
  type MemorySpace,
  recordRelevantSchemaWritePolicyInput,
} from "../../../../runtime/runner/src/cell.ts";
import {
  consumedEntriesForRead,
  labelForConsumedEntries,
} from "../../../../runtime/runner/src/cfc/consumed-label.ts";
import { readStoredCfcMetadata } from "../../../../runtime/runner/src/cfc/metadata.ts";
import { parseLink } from "../../../../runtime/runner/src/link-utils.ts";
import type { NormalizedFullLink } from "../../../../runtime/runner/src/link-types.ts";
import { Runtime } from "../../../../runtime/runner/src/runtime.ts";
import { StorageManager } from "../../../../runtime/runner/src/storage/cache.deno.ts";
import {
  type Artifact,
  Instance,
  type LabelChange,
} from "../../exec/executor.ts";
import { InputsTable } from "../../exec/plan-write.ts";
import { identifierOf, isLink, Ref, Store } from "../../exec/store.ts";
import { generateInputs, inputClause } from "../generate.ts";
import { scenarioAudience } from "../harness.ts";
import { labeledInputs } from "../integrated.ts";
import { RuntimeTransactions } from "../runtime-transactions.ts";
import { CASES, type Figures, measure } from "../template-cost.ts";

const artifactOf = async (
  name: string,
  pattern = "default",
): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((artifact) => artifact.name === pattern) ??
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

  it("admits into the executor's documents a clause the space does not admit, as into a store the runtime owns", async () => {
    // `secret` carries "alice" alone, with no alternative the space admits,
    // and `record` writes it into the state cell `last`. Today's runner
    // enrolls the stores of a piece, and a clause that does not fit such a
    // store is declared onto it rather than refused (CFC spec §8.12.5).
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: identifierOf({ test: "runtime-transactions" }),
    });
    const { given, documents } = await labeledInputs(
      runtime,
      space,
      {
        secret: {
          schema: { type: "string", ifc: { confidentiality: ["alice"] } },
        },
      },
      { secret: "s", note: "n" },
      hooks,
    );
    const instance = new Instance(await artifactOf("handler"), given, {
      space,
      id: identifierOf({ test: "runtime-transactions" }),
      transactions: hooks,
      documents,
    });
    instance.send(bindingOf(instance, "record"), { text: "t", extra: "e" });
    expect(await hooks.settled()).toEqual([]);

    const last = instance.stateCells().find(({ name }) => name === "last");
    const read = runtime.edit();
    try {
      const metadata = readStoredCfcMetadata(read, {
        space,
        id: hooks.entityOf(last!.id),
        scope: "space",
      });
      expect(JSON.stringify(metadata ?? {})).toContain("alice");
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

describe("RuntimeTransactions with labels from templates", () => {
  /**
   * The labels stored on the result of `briefing.tsx` at `climate`,
   * `briefing` and the `[UI]` text, run over labeled inputs with the
   * experimental option `compiledPatterns` as `enabled` says: for each, the
   * clauses of the label a value read there consumes, as text, and whether
   * that label carries the atom of a compiled pattern.
   */
  const briefing = async (enabled: boolean) => {
    const signer = await Identity.fromPassphrase("pattern-compiler-compare");
    const space = signer.did();
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcFlowLabels: "persist",
      experimental: { compiledPatterns: enabled },
      servingPosture: true,
    });
    const id = identifierOf({ test: "briefing" });
    const artifact = await artifactOf("briefing");
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: id,
      artifact,
    });
    try {
      const inputs = generateInputs(
        artifact.plan as Parameters<typeof generateInputs>[0],
        artifact.schemas as Parameters<typeof generateInputs>[1],
        await scenarioAudience(),
      );
      const { given, documents } = await labeledInputs(
        runtime,
        space,
        inputs,
        { secret: "s", city: "Paris" },
        hooks,
      );
      const instance = new Instance(artifact, given, {
        space,
        id,
        transactions: hooks,
        documents,
      });
      expect(await hooks.settled()).toEqual([]);
      const read = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(read, {
          space,
          id: hooks.entityOf(instance.id),
          scope: "space",
        });
        // The label a value read at the path consumes.
        const at = (path: readonly string[]) => {
          const label = metadata === undefined
            ? undefined
            : labelForConsumedEntries(
              consumedEntriesForRead(metadata, path, {
                nonRecursive: false,
                consumes: "value",
              }),
              path,
              false,
            );
          return {
            clauses: JSON.stringify(label?.confidentiality ?? []),
            atom: (label?.integrity ?? []).some((atom) =>
              JSON.stringify(atom).includes('"kind":"compiled"')
            ),
          };
        };
        return {
          climate: at(["climate"]),
          briefing: at(["briefing"]),
          text: at(["$UI", "children", "1"]),
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

  it("stores at each output the label of its template, with the pattern's atom, with the option on", async () => {
    const { climate, briefing: both, text } = await briefing(true);
    expect(climate.clauses).toContain('"input:city"');
    expect(climate.clauses).not.toContain("demo-secret");
    // The text holds the reference to `city`, whose template observes the
    // reference's identity and not the content it points to.
    expect(text.clauses).toBe("[]");
    expect(both.clauses).toContain('"input:city"');
    expect(both.clauses).toContain("demo-secret");
    expect([climate.atom, both.atom, text.atom]).toEqual([true, true, true]);
  });

  it("reports to the executor the label entries a commit changed in a document whose labels it asked for", async () => {
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
    const hooks = new RuntimeTransactions(runtime, space, {
      artifact: await artifactOf("briefing"),
    });
    try {
      const write = async (schema: JSONSchema, value: string) => {
        const tx = runtime.edit();
        const cell = runtime.getCell<string>(space, { probe: 1 }, schema, tx);
        recordRelevantSchemaWritePolicyInput(
          tx,
          cell.getAsNormalizedFullLink(),
          schema,
        );
        cell.set(value);
        expect((await tx.commit().settled).error).toBeUndefined();
        return cell.getAsNormalizedFullLink().id;
      };
      const id = await write({ type: "string" }, "a");
      hooks.external(id);
      const plain = hooks.labelOf(id, []);
      const changes: LabelChange[] = [];
      hooks.watchLabels((changed) => {
        for (const change of changed) changes.push(change);
      });
      await write({
        type: "string",
        ifc: { confidentiality: [inputClause("probe")] },
      } as JSONSchema, "b");
      // The executor's next transaction hears of it first.
      hooks.begin("event");
      hooks.end({ committed: false });
      expect(changes.map(({ doc }) => doc)).toEqual([id]);
      expect(changes[0].paths).toContainEqual([]);
      expect(hooks.labelOf(id, [])).not.toBe(plain);
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gives two links written under different labels one identifier for a read of their values, and two for a read of them as references", async () => {
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
    const hooks = new RuntimeTransactions(runtime, space, {
      artifact: await artifactOf("briefing"),
    });
    try {
      const seed = runtime.edit();
      const list = runtime.getCell<{ items: unknown[] }>(
        space,
        { probe: "list" },
        undefined,
        seed,
      );
      list.set({ items: [] });
      for (const name of ["a", "b"]) {
        const schema = {
          type: "string",
          ifc: { confidentiality: [inputClause(name)] },
        } as JSONSchema;
        const source = runtime.getCell<string>(
          space,
          { probe: `source ${name}` },
          schema,
          seed,
        );
        recordRelevantSchemaWritePolicyInput(
          seed,
          source.getAsNormalizedFullLink(),
          schema,
        );
        source.set(name);
        runtime.getCell<string>(
          space,
          { probe: `target ${name}` },
          undefined,
          seed,
        )
          .set("public");
      }
      expect((await seed.commit().settled).error).toBeUndefined();
      // Each link is written by a transaction that read another source.
      for (const [index, name] of ["a", "b"].entries()) {
        const tx = runtime.edit();
        runtime.getCell<string>(
          space,
          { probe: `source ${name}` },
          undefined,
          tx,
        )
          .get();
        runtime.getCell<{ items: unknown[] }>(
          space,
          { probe: "list" },
          undefined,
          tx,
        ).key("items").key(index).set(
          runtime.getCell<string>(
            space,
            { probe: `target ${name}` },
            undefined,
            tx,
          ),
        );
        expect((await tx.commit().settled).error).toBeUndefined();
      }
      const id = list.getAsNormalizedFullLink().id;
      hooks.external(id);

      expect(hooks.labelOf(id, ["items", "0"])).toBe(
        hooks.labelOf(id, ["items", "1"]),
      );
      expect(hooks.labelOf(id, ["items", "0"], "identity")).not.toBe(
        hooks.labelOf(id, ["items", "1"], "identity"),
      );
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("stores the transaction's join at each output with the option off", async () => {
    const { climate, text } = await briefing(false);
    expect(climate.clauses).toContain("demo-secret");
    expect(text.clauses).toContain("demo-secret");
    expect(climate.atom).toBe(false);
  });
});

describe("write records the runtime instantiates with the option on", () => {
  /**
   * Runs a fixture over labeled inputs with the experimental option
   * `compiledPatterns` on, and returns the refused commits and the label
   * stored at `path` of the result document.
   */
  const commitWithOptionOn = async (
    name: string,
    argument: Record<string, unknown>,
    path: readonly string[],
    /** The binding of a handler to send one event to, once settled. */
    binding?: number,
    /** Changes the artifact before it is run. */
    edit?: (artifact: Artifact) => void,
    /** The pattern of the fixture to run. */
    pattern = "default",
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
    const id = identifierOf({ test: name });
    const artifact = await artifactOf(name, pattern);
    edit?.(artifact);
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: id,
      artifact,
    });
    try {
      const inputs = generateInputs(
        artifact.plan as Parameters<typeof generateInputs>[0],
        artifact.schemas as Parameters<typeof generateInputs>[1],
        await scenarioAudience(),
      );
      const { given, documents } = await labeledInputs(
        runtime,
        space,
        inputs,
        argument,
        hooks,
      );
      const instance = new Instance(artifact, given, {
        space,
        id,
        transactions: hooks,
        documents,
      });
      const refused = await hooks.settled();
      if (binding !== undefined) {
        instance.send(binding, {});
        for (const reason of await hooks.settled()) refused.push(reason);
      }
      const read = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(read, {
          space,
          id: hooks.entityOf(instance.id),
          scope: "space",
        });
        const label = metadata === undefined
          ? undefined
          : labelForConsumedEntries(
            consumedEntriesForRead(metadata, path, {
              nonRecursive: false,
              consumes: "value",
            }),
            path,
            false,
          );
        // The clauses a reader of `path` observes: those stored at the
        // position, and where a link is stored at it or above it, those at
        // the link and at the position the link leads to, followed in turn.
        const through: unknown[] = [];
        let at: NormalizedFullLink | undefined = {
          space,
          id: hooks.entityOf(instance.id),
          path: [...path],
          scope: "space",
        };
        for (let hop = 0; at !== undefined && hop < 8; hop++) {
          let value: unknown = read.readValueOrThrow({ ...at, path: [] });
          let reached = 0;
          while (
            reached < at.path.length && parseLink(value, at) === undefined
          ) {
            value = (value as Record<string, unknown> | undefined)?.[
              at.path[reached]
            ];
            reached++;
          }
          const position = at.path.slice(0, reached);
          const stored = readStoredCfcMetadata(read, at);
          if (stored !== undefined) {
            const consumed = labelForConsumedEntries(
              consumedEntriesForRead(stored, position, {
                nonRecursive: false,
                consumes: "value",
              }),
              position,
              false,
            );
            for (const clause of consumed?.confidentiality ?? []) {
              through.push(clause);
            }
          }
          const link: NormalizedFullLink | undefined = parseLink(value, at);
          at = link === undefined
            ? undefined
            : { ...link, path: [...link.path, ...at.path.slice(reached)] };
        }
        // The entries stored at `path` itself.
        const entries = (metadata?.labelMap.entries ?? []).filter((entry) =>
          JSON.stringify(entry.path) === JSON.stringify(path)
        );
        return { refused, label, through, entries };
      } finally {
        read.abort();
      }
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  };

  it("binds the `shape` slot of the left operand of `??` to the position its value was read at, and commits", async () => {
    const { refused, label } = await commitWithOptionOn(
      "coalesce",
      { name: "ada" },
      ["shout"],
    );
    expect(refused).toEqual([]);
    // The label of the template is stored: a kept output carries the atom
    // of its pattern.
    expect(JSON.stringify(label?.integrity ?? [])).toContain(
      '"kind":"compiled"',
    );
    // The selected branch passes the scalar on as its `value` (PL §3.5),
    // and `toUpperCase()` reads it: its clause is in the stored label.
    expect(JSON.stringify(label?.confidentiality ?? [])).toContain(
      '"input:name"',
    );
  });

  it("binds a slot whose position the transaction read after it wrote it to the label the write staged", async () => {
    // `bumped` reads `count` and writes it from `trigger`; `shown` reads
    // `count` in the same transaction after that write, and sees the value
    // the write made: the label of `shown` holds the clause of `trigger`.
    const { refused, label } = await commitWithOptionOn(
      "read-after-side-write",
      { trigger: 1 },
      ["shown"],
    );
    expect(refused).toEqual([]);
    expect(JSON.stringify(label?.confidentiality ?? [])).toContain(
      '"input:trigger"',
    );
  });

  it("binds the element slot of an empty collection to the position of its elements, and commits", async () => {
    // The `identity` slot of `list/*` reads no element of the empty list.
    // It is bound to `*` below the list, which covers no element entry and
    // has the label of the list above it.
    const { refused, label } = await commitWithOptionOn(
      "spread-empty",
      { trigger: 1 },
      ["appended"],
    );
    expect(refused).toEqual([]);
    expect(label).toBeDefined();
  });

  it("journals the shape of a position whose value a slot of the same template observes too, and commits", async () => {
    const { refused, label } = await commitWithOptionOn(
      "shape-and-keys",
      { box: { a: 1, b: 2 } },
      ["count"],
    );
    expect(refused).toEqual([]);
    expect(JSON.stringify(label?.confidentiality ?? [])).toContain(
      '"input:box"',
    );
  });

  it("resolves an `enumeration` slot as a read of the container's shape, without the clause a member of an element declares", async () => {
    // `items.length` observes which elements the list has (PL §2.2: an
    // `enumeration` slot resolves as a `shape` read at the container's
    // path). The clause `note` of an element declares is at `items/*/note`.
    const { refused, label } = await commitWithOptionOn(
      "length-of-labeled",
      { items: [{ note: "a", amount: 1 }, { note: "b", amount: 2 }] },
      ["count"],
    );
    expect(refused).toEqual([]);
    const clauses = JSON.stringify(label?.confidentiality ?? []);
    expect(clauses).toContain('"input:items"');
    expect(clauses).not.toContain("item-note");
  });

  it("stores at a text of a whole list the clauses of the list and of a record the list holds a link to", async () => {
    // The handler appends a record, which is a document of its own that
    // the list links to. The read of the list's value goes through the
    // list's array and through that link: the label of `all` holds the
    // clause of the list, and the clause its elements declare on `note`.
    const { refused, entries } = await commitWithOptionOn(
      "whole-after-push",
      { items: [{ note: "a", amount: 1 }] },
      ["all"],
      0,
    );
    expect(refused).toEqual([]);
    const value = JSON.stringify(
      entries.filter((entry) => entry.observes === "value")
        .map((entry) => entry.label.confidentiality ?? []),
    );
    expect(value).toContain('"input:items"');
    expect(value).toContain("item-note");
  });

  it("binds a `value` slot that no evaluation bound through the link at its position, where a slot that observes the reference there was bound", async () => {
    // The pattern compiled in binds a handler to `items`, which observes
    // the reference the argument holds, and computes a text of the list.
    // The `value` slot of the text resolves through that reference (PL
    // §2.5): its label is the list's, with the clause an element declares.
    const { refused, entries } = await commitWithOptionOn(
      "whole-in-child",
      { items: [{ note: "a", amount: 1 }] },
      ["$UI", "children", "0", "children", "0"],
    );
    expect(refused).toEqual([]);
    const value = JSON.stringify(
      entries.filter((entry) => entry.observes === "value")
        .map((entry) => entry.label.confidentiality ?? []),
    );
    expect(value).toContain('"input:items"');
    expect(value).toContain("item-note");
  });

  it("binds the slot of a handler's write edge that read the position the edge writes to what it read, and commits", async () => {
    // The edge writes the input's own cell, which the result document does
    // not hold: what is asserted is that the commit is not refused.
    const { refused } = await commitWithOptionOn(
      "increment",
      { count: 1 },
      [],
      0,
    );
    expect(refused).toEqual([]);
  });

  it("gives no write record for an output the plan has no template for, and commits with the transaction's join there", async () => {
    // The crate emits some kept outputs with no template; the runtime has
    // nothing to instantiate for them.
    const { refused, label } = await commitWithOptionOn(
      "coalesce",
      { name: "ada" },
      ["shout"],
      undefined,
      (artifact) => {
        delete (artifact.plan as { outputs: { template?: unknown }[] })
          .outputs[0].template;
      },
    );
    expect(refused).toEqual([]);
    expect(JSON.stringify(label?.confidentiality ?? [])).toContain(
      '"input:name"',
    );
  });

  it("binds the source slot of the result of a `map` over plain values in place that a selector's branch names from outside the element body, and commits", async () => {
    const { refused, label } = await commitWithOptionOn(
      "collection-output",
      { names: ["a", "b"] },
      ["$UI", "children", "0"],
    );
    expect(refused).toEqual([]);
    expect(JSON.stringify(label?.confidentiality ?? [])).toContain(
      '"input:names"',
    );
  });
  it("stores the atom of a pattern's expression code, equal whether the pattern runs alone or compiled into another", async () => {
    /** The pattern identities of the `TransformedBy` atoms of a label. */
    const minted = (label: { integrity?: readonly unknown[] } | undefined) =>
      (label?.integrity ?? []).flatMap((atom) => {
        const identity =
          (atom as { identity?: { kind?: string; pattern?: string } })
            .identity;
        return identity?.kind === "compiled" ? [identity.pattern] : [];
      });
    const alone = await commitWithOptionOn(
      "compiled-in",
      { title: "t" },
      ["shout"],
      undefined,
      undefined,
      "Row",
    );
    const within = await commitWithOptionOn(
      "compiled-in",
      { title: "t" },
      ["row", "shout"],
    );
    expect(alone.refused).toEqual([]);
    expect(within.refused).toEqual([]);
    const row = minted(alone.label);
    // Alone, the kept output and the expression code both name `Row`.
    expect(new Set(row).size).toBe(1);
    // Compiled in, the expression code names `Row` and the kept output
    // names the pattern of the instance.
    expect(minted(within.label)).toContain(row[0]);
    expect(new Set(minted(within.label)).size).toBe(2);
  });

  it("records the writes of an instance a handler body makes under that instance's pattern, and commits", async () => {
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
    const id = identifierOf({ test: "instantiate-labeled" });
    const [{ patterns }] = JSON.parse(
      await Deno.readTextFile(
        new URL("../fixtures/instantiate-labeled.emit.json", import.meta.url),
      ),
    ) as { patterns: Artifact[] }[];
    const artifact = patterns.find(({ name }) => name === "default")!;
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: id,
      artifact,
    });
    // The compiled pattern each instance's write records were recorded
    // under.
    const recordedUnder = new Map<string, Set<string>>();
    hooks.onCommitted((writes) => {
      for (const { instance, compiledPattern } of writes) {
        const patterns = recordedUnder.get(instance) ?? new Set();
        recordedUnder.set(instance, patterns.add(compiledPattern));
      }
    });
    try {
      const { given, documents } = await labeledInputs(
        runtime,
        space,
        generateInputs(
          artifact.plan as Parameters<typeof generateInputs>[0],
          artifact.schemas as Parameters<typeof generateInputs>[1],
          await scenarioAudience(),
        ),
        { note: "n" },
        hooks,
      );
      const instance = new Instance(artifact, given, {
        space,
        id,
        transactions: hooks,
        documents,
        artifacts: (pattern) =>
          patterns.find(({ plan }) =>
            (plan as { patterns?: string[] }).patterns?.[0] === pattern
          ),
      });
      expect(await hooks.settled()).toEqual([]);
      // `add` instantiates `Row`, whose plan is another one than the
      // plan of the instance the executor was started with.
      const outcome = instance.send(bindingOf(instance, "add"), {
        title: "first",
      });
      expect(outcome.committed).toBe(true);
      expect(await hooks.settled()).toEqual([]);
      expect(
        (instance.result() as { rows: { shout: string }[] }).rows.map((
          { shout },
        ) => shout),
      ).toEqual(["firstn"]);
      // The output `shout` of the instance stores the label of its own
      // template: the clause of `note`, which it reads.
      const [made] = [...instance.store.docs].filter(([, { value }]) =>
        (value as { shout?: unknown } | undefined)?.shout === "firstn"
      ).map(([doc]) => doc);
      const [ofBoard] = recordedUnder.get(instance.id) ?? [];
      expect([...recordedUnder.get(instance.id) ?? []]).toHaveLength(1);
      expect([...recordedUnder.get(made) ?? []]).toHaveLength(1);
      expect([...recordedUnder.get(made) ?? []]).not.toContain(ofBoard);
      const read = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(read, {
          space,
          id: hooks.entityOf(made),
          scope: "space",
        });
        const label = metadata === undefined
          ? undefined
          : labelForConsumedEntries(
            consumedEntriesForRead(metadata, ["shout"], {
              nonRecursive: false,
              consumes: "value",
            }),
            ["shout"],
            false,
          );
        expect(JSON.stringify(label?.confidentiality ?? [])).toContain(
          '"input:note"',
        );
      } finally {
        read.abort();
      }
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("binds the slot of a literal a handler binding gives its state as a constant, and commits", async () => {
    const { refused } = await commitWithOptionOn(
      "constant-state",
      { title: "t" },
      [],
      0,
    );
    expect(refused).toEqual([]);
  });

  it("binds the slot of a state cell that a pattern compiled in passes to an element property, and commits", async () => {
    const { refused } = await commitWithOptionOn(
      "state-to-component",
      { title: "t" },
      ["controls"],
    );
    expect(refused).toEqual([]);
  });

  it("binds the slots of a `reduce` over an array of plain values in place a cell holds, and commits", async () => {
    const { refused, label } = await commitWithOptionOn(
      "reduce-entries",
      { entries: [{ amount: 1 }, { amount: 2 }] },
      ["total"],
    );
    expect(refused).toEqual([]);
    expect(JSON.stringify(label?.confidentiality ?? [])).toContain(
      '"input:entries"',
    );
  });

  for (
    const [fixture, argument, path, source] of [
      ["pass-through", { secret: "s", flag: true }, ["whole"], "secret"],
      [
        "pass-through",
        { secret: "s", flag: true },
        ["member", "inner"],
        "secret",
      ],
      ["pass-through", { secret: "s", flag: true }, ["element", "0"], "secret"],
      ["pass-through", { secret: "s", flag: true }, ["chosen"], "secret"],
      ["pass-through", { secret: "s", flag: true }, ["parameter"], "secret"],
      ["pass-through", { secret: "s", flag: true }, ["lifted"], "secret"],
      ["pass-through", { secret: "s", flag: true }, ["fromLift"], "secret"],
      ...([
        [["chosenList", "0"], "list"],
        [["chosenBox", "a"], "box"],
        [["spreadList", "0"], "list"],
        [["member"], "box"],
        [["element"], "list"],
        [["mapped", "0"], "list"],
        [["local", "a"], "box"],
      ] as const).map(([path, source]) =>
        [
          "pass-through-containers",
          { list: ["s"], box: { a: "s" }, flag: true, other: ["o"] },
          path,
          source,
        ] as const
      ),
    ] as const
  ) {
    it(
      `stores the clause of \`${source}\` that value code passes on, at \`${
        path.join(".")
      }\` of \`${fixture}\` or at the position the link stored there leads to`,
      async () => {
        const { refused, through } = await commitWithOptionOn(
          fixture,
          argument,
          path,
        );
        expect(refused).toEqual([]);
        expect(JSON.stringify(through)).toContain(`"input:${source}"`);
      },
    );
  }
});

describe("a commit the preparation refuses", () => {
  it("writes a document whole in the next transaction where the refused commit created it, before the refused commit settles", async () => {
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
    const doc = identifierOf({ test: "refused-first-write" });
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: doc,
      artifact: await artifactOf("coalesce"),
    });
    try {
      const store = new Store();
      store.docs.set(doc, { kind: "result", value: { box: {} } });
      // The first transaction creates the document with a write record
      // that names an output the plan does not have: the preparation
      // refuses the commit.
      hooks.begin("send");
      const unbound = new InputsTable();
      hooks.change(
        doc,
        [],
        store,
        undefined,
        [{
          target: { doc, path: ["elsewhere"] },
          record: { output: 999 },
          instance: doc,
          keys: [],
          inputs: unbound.place({ slots: {} }),
        }],
        undefined,
        unbound,
      );
      hooks.end({ committed: true });
      // The second, begun before the first settled, writes below the root.
      store.put(doc, ["box"], { n: 1 });
      hooks.begin("send");
      hooks.change(doc, ["box"], store);
      hooks.end({ committed: true });
      const refused = await hooks.settled();
      expect(refused.length).toBe(1);
      expect(refused[0]).toContain("plan-label refused");
      expect(withoutSchemas(hooks.stored().get(doc))).toEqual({
        box: { n: 1 },
      });
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("a change that leaves the stored value as it was", () => {
  it("records its write record as that of a write that left the value as it was, and stores the label of the record at the path", async () => {
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
    const doc = identifierOf({ test: "unchanged-write" });
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: doc,
      artifact: await artifactOf("coalesce"),
    });
    try {
      const store = new Store();
      store.docs.set(doc, { kind: "result", value: { shout: "A" } });
      hooks.begin("send");
      hooks.change(doc, [], store);
      hooks.end({ committed: true });
      expect(await hooks.settled()).toEqual([]);
      // The executor writes `shout` again with the value it holds: the
      // storage records no write, and the write record is given as that of
      // a write that left the value as it was, which names a path the
      // transaction did not write.
      hooks.begin("send");
      const constants = new InputsTable();
      const constant = constants.binding({ constant: true });
      hooks.change(
        doc,
        ["shout"],
        store,
        undefined,
        [{
          target: { doc, path: ["shout"] },
          record: { output: 0 },
          instance: doc,
          keys: [],
          inputs: constants.place({
            slots: { 0: constant, 1: constant },
            selections: { 0: 0 },
          }),
        }],
        undefined,
        constants,
      );
      hooks.end({ committed: true });
      expect(await hooks.settled()).toEqual([]);
      expect(hooks.counts.unchangedRecords).toBe(1);
      // The kept output's label is the atom of its pattern.
      const reader = runtime.edit();
      try {
        const entries = readStoredCfcMetadata(reader, {
          space,
          id: hooks.entityOf(doc),
          scope: "space",
        })?.labelMap.entries ?? [];
        expect(
          entries.filter((entry) =>
            entry.observes === "value" && entry.path.join("/") === "shout"
          ).map((entry) => entry.label.integrity?.length),
        ).toEqual([1]);
      } finally {
        reader.abort();
      }
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("the write records of one transaction", () => {
  /**
   * Writes `count` documents in one transaction, each with a write record of
   * output 0 of `coalesce` at its path `shout` that names one set of
   * inputs, and returns what the adapter counted and the labels stored at
   * that path of each document.
   */
  const writeDocuments = async (count: number) => {
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
    const docs = Array.from(
      { length: count },
      (_, index) => identifierOf({ test: "merged-records", count, index }),
    );
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: docs[0],
      artifact: await artifactOf("coalesce"),
      countRecordBytes: true,
    });
    try {
      const store = new Store();
      const table = new InputsTable();
      const constant = table.binding({ constant: true });
      const inputs = table.place({
        slots: { 0: constant, 1: constant },
        selections: { 0: 0 },
      });
      hooks.begin("send");
      for (const doc of docs) {
        store.docs.set(doc, { kind: "result", value: { shout: "A" } });
        hooks.change(
          doc,
          [],
          store,
          undefined,
          [{
            target: { doc, path: ["shout"] },
            record: { output: 0 },
            instance: docs[0],
            keys: [],
            inputs,
          }],
          undefined,
          table,
        );
      }
      hooks.end({ committed: true });
      const refused = await hooks.settled();
      const reader = runtime.edit();
      try {
        const labeled = docs.filter((doc) =>
          (readStoredCfcMetadata(reader, {
            space,
            id: hooks.entityOf(doc),
            scope: "space",
          })?.labelMap.entries ?? []).some((entry) =>
            entry.observes === "value" && entry.path.join("/") === "shout" &&
            entry.label.integrity?.length === 1
          )
        );
        return { refused, counts: hooks.counts, labeled: labeled.length };
      } finally {
        reader.abort();
      }
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  };

  it("records one write record for the records of one plan record with one set of inputs at one path of several documents", async () => {
    const { refused, counts, labeled } = await writeDocuments(6);

    expect(refused).toEqual([]);
    expect(counts.recordsGiven).toBe(6);
    expect(counts.recordsRecorded).toBe(1);
    expect(labeled).toBe(6);
  });

  it("records for 200 documents the one record it records for 20, larger by the list of the documents alone", async () => {
    const small = await writeDocuments(20);
    const large = await writeDocuments(200);

    expect(large.refused).toEqual([]);
    expect(large.labeled).toBe(200);
    expect(large.counts.recordsRecorded).toBe(small.counts.recordsRecorded);
    // Each further document adds its identifier to the list, and nothing
    // of the record's inputs.
    const perDocument = (large.counts.recordBytes - small.counts.recordBytes) /
      180;
    expect(perDocument).toBeLessThan(80);
  });
});

// `fixtures/whole-after-push.tsx`: `all` is a text of everything the list
// `items` holds, given here as references to a cell each, all under one
// clause: an array of references whose members hold equal labels.
describe("the write records of a change of one member of an array of references", () => {
  /**
   * Changes one of `size` records and returns the write records the
   * change's transactions recorded, their size, how many labels the
   * adapter was asked for, and the refused commits.
   */
  const changeOne = async (size: number) => {
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
    const artifact = await artifactOf("whole-after-push");
    const id = identifierOf({ test: "one-member", size });
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: id,
      artifact,
      countRecordBytes: true,
    });
    try {
      const schema = {
        type: "object",
        properties: { note: { type: "string" }, amount: { type: "number" } },
        ifc: {
          confidentiality: [inputClause("items", await scenarioAudience())],
        },
      } as JSONSchema;
      const tx = runtime.edit();
      const values = Array.from(
        { length: size },
        (_, index) => ({ note: `n${index}`, amount: index }),
      );
      const ids = values.map((value, index) => {
        const cell = runtime.getCell(space, { member: index }, schema, tx);
        const link = cell.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        cell.set(value);
        hooks.external(link.id);
        return link.id;
      });
      expect((await tx.commit().settled).error).toBeUndefined();
      const instance = new Instance(
        artifact,
        { items: ids.map((doc) => ({ $link: { doc, path: [] } })) },
        {
          space,
          id,
          transactions: hooks,
          documents: ids.map((doc, index) => ({
            id: doc,
            kind: "input",
            value: values[index],
          })),
        },
      );
      expect(await hooks.settled()).toEqual([]);
      let asked = 0;
      const labelOf = hooks.labelOf.bind(hooks);
      hooks.labelOf = (...given) => {
        asked += 1;
        return labelOf(...given);
      };
      const before = hooks.counts;

      instance.writeArgument(["items", "4", "amount"], 99);

      const refused = await hooks.settled();
      const after = hooks.counts;
      return {
        refused,
        asked,
        given: after.recordsGiven - before.recordsGiven,
        recorded: after.recordsRecorded - before.recordsRecorded,
        bytes: after.recordBytes - before.recordBytes,
        all: instance.result(),
      };
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  };

  it("records among 1,000 members the records it records among 10, of the same size but for the digits of a number, and asks for as many labels", async () => {
    const small = await changeOne(10);
    const large = await changeOne(1_000);

    expect(small.refused).toEqual([]);
    expect(large.refused).toEqual([]);
    expect(small.recorded).toBeGreaterThan(0);
    expect(large.given).toBe(small.given);
    expect(large.recorded).toBe(small.recorded);
    // The records differ by the digits of the number of members stated.
    expect(Math.abs(large.bytes - small.bytes)).toBeLessThan(16);
    expect(large.asked).toBe(small.asked);
  });
});

describe("the cost of labels from templates for a `filter`", () => {
  it("commits a change of one element over plain values in place, over references, and over the result of a `map`, one that leaves the filtered list and one that stays in it, with the same work and stored entries at 20 and at 200 elements", async () => {
    for (const which of CASES) {
      const [small, large] = [
        await measure(which, 20, true),
        await measure(which, 200, true),
      ];
      for (const figures of [small, large]) {
        expect({ which, refused: figures.refused }).toEqual({
          which,
          refused: [],
        });
      }
      const work = ({ prepareMs: _ms, size: _size, ...rest }: Figures) => rest;
      expect(work(large)).toEqual(work(small));
    }
  });
});

describe("the label of a position of the result of a `map`", () => {
  /**
   * Runs `ordered-rows.tsx` over `size` items, each a document of its own
   * under a clause of its own, with the inputs `items` and `notes` each a
   * document under a clause of its own, applies `change`, and returns, for
   * each row's `text` of `sorted`, `filed` and `plain`, and each `text` of
   * the rows of `nested`, the clauses of the label a value read there
   * consumes, as text.
   */
  const rows = async (
    size: number,
    change?: (
      instance: Instance,
      ids: readonly string[],
      write: (doc: string, path: string[], value: unknown) => Promise<void>,
      items: string,
    ) => Promise<void> | void,
    initial: (ids: readonly string[]) => readonly string[] = (ids) => ids,
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
    const artifact = await artifactOf("ordered-rows");
    const id = identifierOf({ test: "ordered-rows", size });
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
      const tx = runtime.edit();
      const documents: { id: string; kind: string; value: unknown }[] = [];
      const held = (name: unknown, schema: JSONSchema, value: unknown) => {
        const cell = runtime.getCell(space, name, schema, tx);
        const link = cell.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        cell.set(value);
        hooks.external(link.id);
        documents.push({ id: link.id, kind: "input", value });
        return link.id;
      };
      // Item `index` is ranked last for the lowest index, so `sorted` holds
      // the items in the reverse of their order in `items`.
      const ids = Array.from(
        { length: size },
        (_, index) =>
          held({ orderedItem: index }, schemaOf(`item-${index}`), {
            title: `t${index}`,
            rank: size - index,
            tags: [`a${index}`, `b${index}`],
          }),
      );
      const link = (doc: string) => ({ $link: { doc, path: [] } });
      const items = initial(ids).map(link);
      const notes = Array.from(
        { length: size },
        (_, index) => ({ text: `n${index}` }),
      );
      const given = {
        items: link(held({ orderedInput: "items" }, schemaOf("items"), items)),
        notes: link(held({ orderedInput: "notes" }, schemaOf("notes"), notes)),
      };
      expect((await tx.commit().settled).error).toBeUndefined();
      const instance = new Instance(artifact, given, {
        space,
        id,
        transactions: hooks,
        documents,
      });
      expect(await hooks.settled()).toEqual([]);
      await change?.(instance, ids, async (doc, path, value) => {
        instance.store.write(new Ref(doc, path), value);
        instance.settle();
        expect(await hooks.settled()).toEqual([]);
      }, given.items.$link.doc);
      expect(await hooks.settled()).toEqual([]);
      const read = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(read, {
          space,
          id: hooks.entityOf(instance.id),
          scope: "space",
        });
        const at = (path: readonly string[]) =>
          JSON.stringify(
            (metadata === undefined ? undefined : labelForConsumedEntries(
              consumedEntriesForRead(metadata, path, {
                nonRecursive: false,
                consumes: "value",
              }),
              path,
              false,
            ))?.confidentiality ?? [],
          );
        const result = instance.result() as Record<string, unknown[]>;
        const texts = (name: string) =>
          result[name].map((_, index) => at([name, `${index}`, "text"]));
        return {
          sorted: texts("sorted"),
          filed: texts("filed"),
          plain: texts("plain"),
          nested: result.nested.flatMap((row, index) =>
            (row as { tags: unknown[] }).tags.map((_, tag) =>
              at(["nested", `${index}`, "tags", `${tag}`, "text"])
            )
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

  const holdsAll = (labels: string[], names: string[]) => {
    for (const label of labels) {
      for (const name of names) expect(label).toContain(`"input:${name}"`);
    }
  };

  it("joins into a read of a row of a `map` over the result of a `lift` that is an array of references the label of what decided the order", async () => {
    const { sorted } = await rows(3);

    expect(sorted.length).toBe(3);
    holdsAll(sorted, ["item-0", "item-1", "item-2"]);
  });

  it("joins the label of the order into every row after a writer changes the rank of one item", async () => {
    const { sorted, nested } = await rows(3, async (_, ids, write) => {
      await write(ids[2], ["rank"], 10);
    });

    holdsAll(sorted, ["item-0", "item-1", "item-2"]);
    holdsAll(nested, ["item-0", "item-1", "item-2"]);
  });

  it("joins the label of an item a writer adds into every row, where the item is ranked last", async () => {
    // Item 0 has the highest rank, so its row is added at the end of
    // `sorted`: that it stands there, and that no row before it moved, was
    // decided by its rank.
    const { sorted, nested } = await rows(
      3,
      async (_, ids, write, items) => {
        await write(
          items,
          [],
          [ids[1], ids[2], ids[0]].map((doc) => ({ $link: { doc, path: [] } })),
        );
      },
      (ids) => [ids[1], ids[2]],
    );

    expect(sorted.length).toBe(3);
    holdsAll(sorted, ["item-0", "item-1", "item-2"]);
    expect(nested.length).toBe(6);
    holdsAll(nested, ["item-0", "item-1", "item-2"]);
  });

  it("joins the label of an item a writer adds into every row, where the item is ranked first", async () => {
    const { sorted, nested } = await rows(
      3,
      async (_, ids, write, items) => {
        await write(
          items,
          [],
          ids.map((doc) => ({ $link: { doc, path: [] } })),
        );
      },
      (ids) => [ids[0], ids[1]],
    );

    expect(sorted.length).toBe(3);
    holdsAll(sorted, ["item-0", "item-1", "item-2"]);
    expect(nested.length).toBe(6);
    holdsAll(nested, ["item-0", "item-1", "item-2"]);
  });

  it("joins into a read of a row of a `map` over an array of references the label of the array, after a handler changes its order", async () => {
    const before = await rows(3);
    const after = await rows(3, (instance) => {
      instance.send(bindingOf(instance, "rotate"), {});
      instance.settle();
    });

    holdsAll(before.filed, ["items"]);
    holdsAll(after.filed, ["items"]);
  });

  it("joins into a read of a row of a `map` over an array of plain values in place, within a row of a `map` over sorted references, the label of both orders", async () => {
    const { nested } = await rows(3);

    expect(nested.length).toBe(6);
    holdsAll(nested, ["item-0", "item-1", "item-2"]);
  });

  it("joins into a read of a row of a `map` over an array of plain values in place the label of the array", async () => {
    const { plain } = await rows(3);

    holdsAll(plain, ["notes"]);
  });
});

describe("the `identity` slots of a handler's binding state", () => {
  it("bind an output the handler reads as a handle without the label of what the output holds", async () => {
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
    const artifact = await artifactOf("identity-state");
    const id = identifierOf({ test: "identity-state" });
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: id,
      artifact,
    });
    try {
      const audience = await scenarioAudience();
      const tx = runtime.edit();
      const documents: { id: string; kind: string; value: unknown }[] = [];
      const held = (name: string, value: unknown) => {
        const schema = {
          ifc: { confidentiality: [inputClause(name, audience)] },
        } as JSONSchema;
        const cell = runtime.getCell(
          space,
          { identityInput: name },
          schema,
          tx,
        );
        const link = cell.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        cell.set(value);
        hooks.external(link.id);
        documents.push({ id: link.id, kind: "input", value });
        return { $link: { doc: link.id, path: [] } };
      };
      const given = { items: held("items", []), secret: held("secret", "s") };
      expect((await tx.commit().settled).error).toBeUndefined();
      const instance = new Instance(artifact, given, {
        space,
        id,
        transactions: hooks,
        documents,
      });
      expect(await hooks.settled()).toEqual([]);

      instance.send(bindingOf(instance, "add"), {});
      instance.settle();

      expect(await hooks.settled()).toEqual([]);
      const read = runtime.edit();
      try {
        const labelAt = (doc: string, path: readonly string[]) => {
          const metadata = readStoredCfcMetadata(read, {
            space,
            id: hooks.entityOf(doc),
            scope: "space",
          });
          return JSON.stringify(
            (metadata === undefined ? undefined : labelForConsumedEntries(
              consumedEntriesForRead(metadata, path, {
                nonRecursive: false,
                consumes: "value",
              }),
              path,
              false,
            ))?.confidentiality ?? [],
          );
        };
        const items = given.items.$link.doc;
        const [entry] = instance.store.peek(items, []) as unknown[];
        expect(isLink(entry)).toBe(true);
        const record = (entry as { $link: { doc: string } }).$link.doc;
        // What the push wrote: the position in `items` and the record.
        expect(labelAt(items, ["0"])).not.toContain('"input:secret"');
        expect(labelAt(record, ["title"])).not.toContain('"input:secret"');
        // The record holds a link to the position of the result document
        // that holds `summary`, and a read there holds the clause.
        expect(instance.store.peek(record, ["source"])).toEqual({
          $link: { doc: instance.id, path: ["summary"] },
        });
        expect(labelAt(record, ["source"])).not.toContain('"input:secret"');
        expect(labelAt(instance.id, ["summary"])).toContain('"input:secret"');
      } finally {
        read.abort();
      }
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("a document a `lift` writes for a row of its result", () => {
  it("takes the label of what the `lift` read, and of nothing else the transaction read", async () => {
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
    const artifact = await artifactOf("created-rows");
    const id = identifierOf({ test: "created-rows" });
    const hooks = new RuntimeTransactions(runtime, space, {
      owner: id,
      artifact,
    });
    try {
      const audience = await scenarioAudience();
      const tx = runtime.edit();
      const documents: { id: string; kind: string; value: unknown }[] = [];
      const held = (name: string, value: unknown) => {
        const schema = {
          ifc: { confidentiality: [inputClause(name, audience)] },
        } as JSONSchema;
        const cell = runtime.getCell(space, { createdInput: name }, schema, tx);
        const link = cell.getAsNormalizedFullLink();
        recordRelevantSchemaWritePolicyInput(tx, link, schema);
        cell.set(value);
        hooks.external(link.id);
        documents.push({ id: link.id, kind: "input", value });
        return { $link: { doc: link.id, path: [] } };
      };
      const items = [0, 1].map((index) =>
        held(`item-${index}`, { title: `t${index}` })
      );
      const given = {
        items: held("items", items),
        other: held("other", "o"),
      };
      expect((await tx.commit().settled).error).toBeUndefined();
      const instance = new Instance(artifact, given, {
        space,
        id,
        transactions: hooks,
        documents,
      });
      expect(await hooks.settled()).toEqual([]);
      const labelsOfRows = () => {
        const read = runtime.edit();
        try {
          const rows = instance.store.peek(instance.id, ["rows"]) as unknown[];
          return rows.map((row) => {
            expect(isLink(row)).toBe(true);
            const { doc } = (row as { $link: { doc: string } }).$link;
            expect(instance.store.peek(doc, ["title"])).toMatch(/^(T|CHANGED)/);
            const metadata = readStoredCfcMetadata(read, {
              space,
              id: hooks.entityOf(doc),
              scope: "space",
            });
            const path = ["title"];
            return JSON.stringify(
              (metadata === undefined ? undefined : labelForConsumedEntries(
                consumedEntriesForRead(metadata, path, {
                  nonRecursive: false,
                  consumes: "value",
                }),
                path,
                false,
              ))?.confidentiality ?? [],
            );
          });
        } finally {
          read.abort();
        }
      };

      const first = labelsOfRows();

      expect(first.length).toBe(2);
      for (const label of first) {
        expect(label).toContain('"input:items"');
        expect(label).toContain('"input:item-0"');
        expect(label).toContain('"input:item-1"');
        expect(label).not.toContain('"input:other"');
      }

      // A writer changes one item: its row is written again, and the row
      // of the other item is left as it was.
      instance.store.write(new Ref(items[1].$link.doc, ["title"]), "changed");
      instance.settle();
      expect(await hooks.settled()).toEqual([]);

      const second = labelsOfRows();

      expect(second.length).toBe(2);
      for (const label of second) {
        expect(label).toContain('"input:item-0"');
        expect(label).toContain('"input:item-1"');
        expect(label).not.toContain('"input:other"');
      }
    } finally {
      hooks.close();
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
