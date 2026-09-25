import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { OpaqueCell, PatternFactory } from "@commonfabric/api";
import { cfcLabelViewForResolvedCellWithStatus } from "../src/cfc/label-view.ts";
import type { CfcPreparationWork } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("cfc-prepare-round2");
const space = signer.did();

describe("CFC prepare reproduction", () => {
  it("preserves preparation counts through nested transaction wrappers and resets", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    try {
      const wrapped = new TransactionWrapper(new TransactionWrapper(tx));
      const kinds = [
        "overlapWildcardQueries",
        "overlapConcreteQueries",
        "authoritativeCoverCalls",
        "stagedReferenceDerivations",
        "stagedReferenceCacheHits",
        "flowTemplateEntriesMinted",
        "flowTemplateContainers",
      ] as const satisfies readonly CfcPreparationWork[];
      const before = runtime.getCfcStats();
      for (const kind of kinds) {
        expect(before[kind]).toBe(0);
        wrapped.noteCfcPreparationWork(kind);
        wrapped.noteCfcPreparationWork(kind, 3);
        wrapped.noteCfcPreparationWork(kind, 0);
        expect(runtime.getCfcStats()[kind]).toBe(4);
        expect(before[kind]).toBe(0);
      }
      const counted = runtime.getCfcStats();
      runtime.resetCfcStats();
      for (const kind of kinds) {
        expect(runtime.getCfcStats()[kind]).toBe(0);
        expect(counted[kind]).toBe(4);
        wrapped.noteCfcPreparationWork(kind, 2);
        expect(runtime.getCfcStats()[kind]).toBe(2);
      }
    } finally {
      tx.abort();
      await runtime.dispose();
    }
  });

  it("instantiates fifty labeled map elements and counts preparation work", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const source = runtime.getCell(space, "messages", undefined, seed);
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        ...source.getAsNormalizedFullLink(),
        path: [],
      }, {
        value: Array.from({ length: 50 }, (_, n) => ({ n })),
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: ["secret"] } }],
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();
      const select = runtime.edit();
      source.withTx(select).get();
      const selected = runtime.getCell(space, "selected", {
        type: "array",
        items: { asCell: ["cell"] },
      }, select);
      selected.set(
        Array.from(
          { length: 50 },
          (_, n) => source.withTx(select).key(String(n)),
        ),
      );
      expect((await select.commit()).error).toBeUndefined();
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, lift } = commonfabric;
      const render = lift<{ n: number }>((item) => ({
        type: "vnode",
        name: "div",
        props: { className: "bubble" },
        children: [String(item.n)],
      }));
      const elementPattern = pattern<{ element: { n: number } }>((
        { element },
      ) => render(element));
      const mapped = pattern<{ values: { n: number }[] }>(({ values }) => ({
        // mapWithPattern receives the wrapper emitted by the transformer;
        // its public signature names the element rather than that wrapper.
        rendered: (values as unknown as OpaqueCell<{ n: number }[]>)
          .mapWithPattern(
            elementPattern as unknown as PatternFactory<
              { n: number },
              { children: string[] }
            >,
            {},
          ),
      }));
      const preparations: unknown[] = [];
      const edit = runtime.edit.bind(runtime);
      runtime.edit = (...args: Parameters<Runtime["edit"]>) => {
        const tx = edit(...args);
        const prepare = tx.prepareCfc.bind(tx);
        tx.prepareCfc = () => {
          const before = runtime.getCfcStats();
          const reads = [...(tx.getReadActivities?.() ?? [])].length;
          const writes = tx.getCfcState().writePolicyInputs.length;
          const started = performance.now();
          const digest = prepare();
          const elapsedMs = performance.now() - started;
          const after = runtime.getCfcStats();
          preparations.push({
            reads,
            writes,
            elapsedMs,
            counters: Object.fromEntries(
              Object.entries(after).map((
                [key, value],
              ) => [key, value - before[key as keyof typeof before]]),
            ),
          });
          return digest;
        };
        return tx;
      };
      runtime.resetCfcStats();
      const tx = runtime.edit();
      const result = runtime.run(
        tx,
        mapped,
        { values: selected.withTx(tx) },
        runtime.getCell(space, "mapped-result", undefined, tx),
      );
      expect((await tx.commit()).error).toBeUndefined();
      await result.pull();
      await runtime.idle();
      const rendered = result.key("rendered").get() as readonly {
        readonly children: readonly string[];
      }[];
      expect(rendered).toHaveLength(50);
      expect(rendered.map((node) => node.children)).toEqual(
        Array.from({ length: 50 }, (_, n) => [String(n)]),
      );
      const stats = runtime.getCfcStats();
      if (Deno.env.get("CF_CFC_PREPARE_DIAGNOSTICS") === "1") {
        console.error(
          JSON.stringify({ reproduction: "map50", stats, preparations }),
        );
      }
      expect(stats.flowTemplateEntriesMinted).toBe(
        3 * stats.flowTemplateContainers,
      );
      expect(stats.flowTemplateContainers).toBe(251);
      // All fifty instances reuse one source-container template query.
      expect(stats.overlapWildcardQueries).toBe(1);
      for (let index = 0; index < 50; index++) {
        const cell = result.key("rendered").key(String(index)).resolveAsCell();
        const status = cfcLabelViewForResolvedCellWithStatus(cell);
        expect(status.readFailed).toBe(false);
        expect(status.view?.entries.length).toBeGreaterThan(0);
        for (const entry of status.view!.entries) {
          expect(entry.label.confidentiality).toEqual(["secret"]);
        }
      }
      expect(stats.authoritativeCoverCalls).toBeGreaterThan(0);
      expect(stats.consumedLabelWalks).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
