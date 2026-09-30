/** Reference selection through aggregate leaves and persisted combine nodes. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { cfcAtom } from "@commonfabric/api/cfc";
import { normalizeClause } from "../src/cfc/clause.ts";
import { Identity } from "@commonfabric/identity";

import { aggregateNode } from "../src/builtins/aggregate.ts";
import { createNodeFactory } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import { type Cell, isCell } from "../src/cell.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import {
  inlineExternalSchemaRefsInValue,
  parseLink,
} from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-aggregate-reference");
const space = signer.did();
const selection = normalizeClause({
  anyOf: ["private-selection", cfcAtom.space(space)],
});

describe("cfc-aggregate-reference", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose({ closeStorage: false });
    await storage.close();
  });

  const seed = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return cell.withTx(undefined);
  };

  const runNode = async (
    tx: IExtendedStorageTransaction,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    const inputs = runtime.getImmutableCell(space, args, undefined, tx);
    let result: unknown;
    const action = aggregateNode(
      inputs,
      (_tx, value) => result = value,
      () => {},
      undefined,
      runtime.getCell(space, "parent", undefined, tx),
      runtime,
    );
    await (typeof action === "function" ? action : action.action)(tx);
    return result;
  };

  for (const flowLabels of ["off", "persist"] as const) {
    it(`${flowLabels === "off" ? "resumes" : "refuses"} legacy normalized-address combine state in ${flowLabels} mode`, async () => {
      await runtime.dispose({ closeStorage: false });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: storage,
        cfcFlowLabels: flowLabels,
      });
      const target = await seed("legacy-selected", "selected value");
      const state = await seed("legacy-state", {
        candidate: {
          score: 1,
          key: "selected",
          element: target.getAsNormalizedFullLink(),
        },
      });
      const tx = runtime.edit();
      try {
        const result = runNode(tx, {
          operation: "minBy",
          mode: "combine",
          final: true,
          left: state,
          right: state,
        });
        if (flowLabels === "persist") {
          await expect(result).rejects.toThrow(
            "Legacy aggregate references require recomputation",
          );
        } else {
          const selected = await result;
          if (!isCell(selected)) throw new Error("Expected selected Cell");
          expect(selected.get()).toBe("selected value");
        }
      } finally {
        tx.abort();
      }
    });
  }

  for (const operation of ["minBy", "maxBy"] as const) {
    it(`retains nested immutable ${operation} references after an aborted selection`, async () => {
      const target = await seed("target", "visible");
      const source = await seed("selected", target.getAsLink(), [{
        path: [],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: { confidentiality: [selection] },
      }]);
      const acquisition = runtime.edit();
      const selected = source.withTx(acquisition).resolveAsCell();
      const list = runtime.getImmutableCell(space, [{ nested: selected }]);
      acquisition.abort();

      const tx = runtime.edit();
      const result = await runNode(tx, {
        operation,
        mode: "leaf",
        final: true,
        values: [1],
        keys: ["selected"],
        elements: [list.key(0)],
      });
      expect(isCell(result)).toBe(true);
      if (!isCell(result)) throw new Error("Expected selected Cell");
      const held = result.withTx(undefined) as Cell<{ nested: string }>;
      tx.abort();

      const read = runtime.edit();
      expect(held.withTx(read).key("nested").get()).toBe("visible");
      expect(deriveFlowJoin(read).confidentiality).toEqual([selection]);
      read.abort();
    });

    it(`retains ${operation} candidates through cold persisted combine nodes`, async () => {
      const target = await seed("cold target", { visible: "chosen" });
      const selected = await seed("cold selected", target.getAsLink(), [{
        path: [],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: { confidentiality: [selection] },
      }]);
      const acquisition = runtime.edit();
      const held = selected.withTx(acquisition).resolveAsCell();
      const list = runtime.getImmutableCell(space, [{ nested: held }]);
      acquisition.abort();
      const states = [];
      for (let index = 0; index < 4; index++) {
        const tx = runtime.edit();
        const state = await runNode(tx, {
          operation,
          mode: "leaf",
          final: false,
          values: [index],
          keys: [String(index)],
          elements: [list.key(0)],
        });
        const output = runtime.getCell(
          space,
          { partial: index },
          undefined,
          tx,
        );
        output.set(state);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        states.push(output.getAsNormalizedFullLink());
      }
      await runtime.dispose({ closeStorage: false });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: storage,
        cfcFlowLabels: "persist",
      });
      const branches = [];
      for (let index = 0; index < 2; index++) {
        const destination = await seed(`branch ${index}`, undefined, [{
          path: [],
          origin: "declared",
          label: { confidentiality: [selection] },
        }]);
        const tx = runtime.edit();
        const state = await runNode(tx, {
          operation,
          mode: "combine",
          final: false,
          left: runtime.getCellFromLink(states[index * 2]),
          right: runtime.getCellFromLink(states[index * 2 + 1]),
        });
        const output = destination.withTx(tx);
        output.set(state);
        runtime.prepareTxForCommit(tx);
        const verdict = await tx.commit();
        expect(verdict.error).toBeUndefined();
        branches.push(output.withTx(undefined));
      }
      const tx = runtime.edit();
      const result = await runNode(tx, {
        operation,
        mode: "combine",
        final: true,
        left: branches[0],
        right: branches[1],
      });
      if (!isCell(result)) throw new Error("Expected selected Cell");
      const chosen = result.withTx(undefined) as Cell<
        { nested: { visible: string } }
      >;
      tx.abort();
      const read = runtime.edit();
      expect(chosen.withTx(read).key("nested", "visible").get()).toBe("chosen");
      expect(deriveFlowJoin(read).confidentiality).toEqual([selection]);
      read.abort();
    });

    it(`selects immutable elements through a multilevel ${operation} coordinator`, async () => {
      const aggregate = createNodeFactory({
        type: "ref",
        implementation: "aggregate",
      });
      const compiled = pattern<{ list: number[]; elements: unknown[] }>(
        ({ list, elements }) => ({
          winner: aggregate({ list, elements, operation }),
        }),
        {
          type: "object",
          properties: { list: { type: "array" }, elements: { type: "array" } },
        },
        {
          type: "object",
          properties: { winner: { asCell: ["cell"] } },
        },
      );
      const target = await seed("tree target", "visible");
      const elements = runtime.getImmutableCell(
        space,
        Array.from({ length: 65 }, (_, rank) => ({ rank, nested: target })),
      );
      const tx = runtime.edit();
      const output = runtime.getCell<
        { winner: Cell<{ rank: number; nested: string }> }
      >(
        space,
        "tree result",
        compiled.resultSchema,
        tx,
      );
      runtime.run(tx, compiled, {
        list: Array.from({ length: 65 }, (_, rank) => rank),
        elements,
      }, output);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const cancel = output.sink(() => {});
      try {
        await runtime.idle();
        await output.pull();
        const winner = output.key("winner").resolveAsCell();
        await winner.sync();
        expect(winner.key("rank").get()).toBe(operation === "minBy" ? 0 : 64);
        expect(winner.key("nested").get()).toBe("visible");
      } finally {
        cancel();
      }
    });
  }

  it("carries score confidentiality without reading selected target content", async () => {
    const score = await seed("secret score", 1, [{
      path: [],
      origin: "derived",
      observes: "value",
      label: { confidentiality: [selection] },
    }]);
    const target = await seed("private target", { secret: "content" }, [{
      path: ["secret"],
      origin: "derived",
      observes: "value",
      label: { confidentiality: ["target-content"] },
    }]);
    const tx = runtime.edit();
    const result = await runNode(tx, {
      operation: "minBy",
      mode: "leaf",
      final: true,
      values: [score, 2],
      keys: ["a", "b"],
      elements: [target, target],
    });
    if (!isCell(result)) throw new Error("Expected selected Cell");
    expect(deriveFlowJoin(tx).confidentiality).toEqual([selection]);
    expect(getCfcReferenceProvenance(result)?.confidentiality).toEqual([
      selection,
    ]);
    const held = result.withTx(undefined) as Cell<{ secret: string }>;
    tx.abort();
    await held.sync();
    const read = runtime.edit();
    expect(held.withTx(read).key("secret").get()).toBe("content");
    expect([...deriveFlowJoin(read).confidentiality].sort()).toEqual([
      selection,
      "target-content",
    ]);
    read.abort();
  });

  it("retains the selected handle scope cap across abort and schema widening", async () => {
    const setup = runtime.edit();
    const session = runtime.getCell(space, "session target", {
      scope: "session",
    }, setup);
    session.set("private session");
    const target = runtime.getCell(space, "space target", undefined, setup);
    target.set({ nested: session });
    runtime.prepareTxForCommit(setup);
    expect((await setup.commit()).ok).toBeDefined();
    const tx = runtime.edit();
    const result = await runNode(tx, {
      operation: "maxBy",
      mode: "leaf",
      final: true,
      values: [1],
      keys: ["a"],
      elements: [target.withTx(undefined).asSchema({ scope: "space" })],
    });
    if (!isCell(result)) throw new Error("Expected selected Cell");
    const held = result.withTx(undefined) as Cell<{ nested: string }>;
    tx.abort();
    const update = runtime.edit();
    target.withTx(update).set(session);
    runtime.prepareTxForCommit(update);
    expect((await update.commit()).ok).toBeDefined();
    await held.sync();
    await session.sync();
    const read = runtime.edit();
    expect(held.withTx(read).asSchema({ scope: "session" }).get())
      .toBeUndefined();
    expect(session.withTx(read).get()).toBe("private session");
    read.abort();
  });

  it("retains current scope caps in immutable inputs without copying reader value schemas", async () => {
    const target = await seed("schema target", { value: 1 });
    const plain = runtime.getImmutableCell(space, { target });
    const typed = runtime.getImmutableCell(space, {
      target: target.asSchema({
        type: "object",
        properties: { value: { type: "number" } },
      }),
    });
    expect(typed.getAsNormalizedFullLink().id).toBe(
      plain.getAsNormalizedFullLink().id,
    );
    const scoped = runtime.getImmutableCell(space, {
      target: target.asSchema({
        anyOf: [{ asCell: [{ kind: "cell", scope: "space" }] }],
      }),
    });
    const tx = runtime.edit();
    const raw = scoped.withTx(tx).key("target").getRawUntyped();
    expect(getCfcReferenceProvenance(raw)?.scopeCaps).toEqual([{
      depth: 0,
      scope: "space",
    }]);
    tx.abort();
    expect(() =>
      runtime.getImmutableCell(space, {
        target: target.asSchema({ scope: "space" }).asSchema({
          scope: "session",
        }),
      })
    ).toThrow("Reference acquisition scope cap cannot be widened for storage");
    const valueSchema = {
      type: "object",
      properties: { value: { type: "number" } },
    } as const;
    const rawSchema = target.asSchema(valueSchema).getAsLink({
      includeSchema: true,
    });
    const inline = inlineExternalSchemaRefsInValue(rawSchema);
    expect(parseLink(inline)?.schema).toEqual(valueSchema);
    expect(runtime.getImmutableCell(space, { rawSchema }).getRaw()).toEqual({
      rawSchema: inline,
    });
  });

  it("retains scope and redirect semantics through immutable serialization", async () => {
    const target = await seed("redirect target", "visible");
    const redirect = runtime.getCellFromLink(
      target.asSchema({ scope: "space" }).getAsWriteRedirectLink({
        includeSchema: true,
      }),
    );
    const tx = runtime.edit();
    const immutable = runtime.getImmutableCell(
      space,
      { redirect },
      undefined,
      tx,
    );
    const raw = immutable.key("redirect").getRawUntyped();
    const binding = getCfcReferenceProvenance(raw)?.binding;
    expect(binding?.overwrite).toBe("redirect");
    expect(binding?.id).toBe(target.getAsNormalizedFullLink().id);
    expect(getCfcReferenceProvenance(raw)?.scopeCaps).toEqual([{
      depth: 0,
      scope: "space",
    }]);
    tx.abort();
  });

  it("retains scope caps through a cold persisted candidate", async () => {
    const target = await seed("cold capped target", "visible");
    const tx = runtime.edit();
    const state = await runNode(tx, {
      operation: "minBy",
      mode: "leaf",
      final: false,
      values: [1],
      keys: ["a"],
      elements: [target.asSchema({ scope: "space" })],
    });
    const output = runtime.getCell(space, "cold capped state", undefined, tx);
    output.set(state);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const stateLink = output.getAsNormalizedFullLink();
    const targetLink = target.getAsNormalizedFullLink();
    await runtime.dispose({ closeStorage: false });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    const select = runtime.edit();
    const result = await runNode(select, {
      operation: "minBy",
      mode: "combine",
      final: true,
      left: runtime.getCellFromLink(stateLink),
      right: runtime.getCellFromLink(stateLink),
    });
    if (!isCell(result)) throw new Error("Expected selected Cell");
    const held = result.withTx(undefined);
    select.abort();
    const update = runtime.edit();
    const session = runtime.getCell(
      space,
      "cold session",
      { scope: "session" },
      update,
    );
    session.set("private session");
    runtime.getCellFromLink(targetLink, undefined, update).set(session);
    runtime.prepareTxForCommit(update);
    expect((await update.commit()).ok).toBeDefined();
    await held.sync();
    await session.sync();
    const read = runtime.edit();
    expect(held.withTx(read).asSchema({ scope: "session" }).get())
      .toBeUndefined();
    expect(session.withTx(read).get()).toBe("private session");
    read.abort();
  });

  for (const operation of ["sum", "countTruthy", "min", "max"] as const) {
    it(`does not acquire unused element references for ${operation}`, async () => {
      const target = await seed("unused target", "unused");
      const unproven = JSON.parse(JSON.stringify(target.getAsLink()));
      const tx = runtime.edit();
      const result = await runNode(tx, {
        operation,
        mode: "leaf",
        final: true,
        values: [1, 2],
        keys: ["a", "b"],
        elements: [unproven, unproven],
      });
      expect(result).toBe(
        operation === "sum" ? 3 : operation === "min" ? 1 : 2,
      );
      expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
      tx.abort();
    });
  }

  it("rejects an unproven selected reference", async () => {
    const target = await seed("unproven target", "unused");
    const tx = runtime.edit();
    await expect(runNode(tx, {
      operation: "minBy",
      mode: "leaf",
      final: true,
      values: [1],
      keys: ["a"],
      elements: [JSON.parse(JSON.stringify(target.getAsLink()))],
    })).rejects.toThrow(
      "Reference acquisition lacks complete legacy provenance",
    );
    tx.abort();
  });
});
