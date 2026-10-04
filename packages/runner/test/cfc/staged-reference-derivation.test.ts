import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import type { CfcCellLinkRefPayload } from "../../src/cfc/link-label-view.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { recordReferencedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  seedReferenceGraphLeaf,
  stageReferenceGraph,
} from "../support/staged-reference-graph.ts";

const signer = await Identity.fromPassphrase("staged-reference-derivation");
const space = signer.did();

describe("staged-reference-derivation", () => {
  let runtime: Runtime;

  beforeEach(async () => {
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    await seedReferenceGraphLeaf(runtime, space);
    runtime.resetCfcStats();
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  for (const order of ["bottom-up", "top-down"] as const) {
    it(`preserves every diamond path with bounded derivations in ${order} order`, async () => {
      const depth = 7;
      const { tx, holder } = stageReferenceGraph(
        runtime,
        space,
        depth,
        2,
        order,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const stats = runtime.getCfcStats();
      expect(stats.stagedReferenceCacheHits).toBeGreaterThan(0);
      expect(stats.stagedReferenceDerivations).toBeLessThan(
        3 * (depth + 1) ** 2,
      );
      const inspect = runtime.edit();
      const entries =
        readStoredCfcMetadata(inspect, holder.getAsNormalizedFullLink())!
          .labelMap.entries;
      inspect.abort();
      for (let bits = 0; bits < 2 ** depth; bits++) {
        const path = [
          "argument",
          ...Array.from({ length: depth }, (_, i) => `p${(bits >> i) & 1}`),
        ];
        const labels = entries.filter((entry) =>
          entry.path.join("/") === path.join("/")
        )
          .map((entry) => entry.label);
        expect(labels.flatMap((label) => label.confidentiality ?? []))
          .toContain("secret");
        expect(labels.flatMap((label) => label.integrity ?? [])).toContain(
          "leaf-proof",
        );
      }
      expect(
        entries.filter((entry) => entry.path.length === 1)
          .flatMap((entry) => entry.label.confidentiality ?? []),
      ).not.toContain("secret");
    });

    for (const slotDeclaration of [false, true, "confidentiality"] as const) {
      it(`preserves ancestor integrity through a projected reference${slotDeclaration === "confidentiality" ? " with a confidential slot declaration" : slotDeclaration ? " with a slot declaration" : ""} in ${order} order`, async () => {
        const tx = runtime.edit();
        const wrapper = runtime.getCell(space, "wrapper", {
          type: "object",
          ifc: {
            integrity: ["wrapper-proof"],
            ...(slotDeclaration === "confidentiality"
              ? { confidentiality: ["wrapper-secret"] }
              : {}),
          },
          ...(slotDeclaration
            ? {
              properties: {
                next: {
                  type: "object",
                  ifc: slotDeclaration === "confidentiality"
                    ? { confidentiality: ["slot-secret"] }
                    : { integrity: ["slot-proof"] },
                },
              },
            }
            : {}),
        }, tx);
        const node = runtime.getCell(space, "projection", {
          type: "object",
          ifc: { integrity: ["node-proof"] },
        }, tx);
        const holder = runtime.getCell(space, "projection-holder", {
          type: "object",
          ifc: { integrity: ["holder-proof"] },
          properties: {
            argument: {
              type: "object",
              properties: {
                first: {
                  type: "object",
                  ifc: { requiredIntegrity: ["wrapper-proof"] },
                },
              },
            },
          },
        }, tx);
        const stages = [
          () => {
            wrapper.set({
              next: runtime.getCell(
                space,
                "reference-graph-leaf",
                undefined,
                tx,
              ),
            });
            recordReferencedArgumentFields(
              tx,
              wrapper.getAsNormalizedFullLink(),
              ["next"],
            );
          },
          () => {
            node.set({
              first: wrapper.key("next"),
              second: wrapper.key("next"),
            });
            recordReferencedArgumentFields(tx, node.getAsNormalizedFullLink(), [
              "first",
              "second",
            ]);
          },
          () => {
            holder.set({ argument: node });
            recordReferencedArgumentFields(
              tx,
              holder.getAsNormalizedFullLink(),
              ["argument"],
            );
          },
        ];
        for (
          const stage of order === "bottom-up" ? stages : stages.toReversed()
        ) stage();
        expect((await tx.commit()).error).toBeUndefined();
        const entries = readStoredCfcMetadata(
          runtime.readTx(),
          holder.getAsNormalizedFullLink(),
        )!.labelMap.entries;
        for (const field of ["first", "second"]) {
          const label = entries.find((entry) =>
            entry.path.join("/") === `argument/${field}`
          )?.label;
          expect(label?.confidentiality).toContain("secret");
          expect(label?.integrity).toContain("leaf-proof");
          expect(label?.integrity).toContain("wrapper-proof");
          expect(label?.integrity).not.toContain("slot-proof");
          if (slotDeclaration === "confidentiality") {
            expect(label?.confidentiality).toContain("wrapper-secret");
            expect(label?.confidentiality).toContain("slot-secret");
          }
        }
      });
    }

    it(`keeps ordinary chains outside the shared-result cache in ${order} order`, async () => {
      const { tx, holder } = stageReferenceGraph(runtime, space, 7, 1, order);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      expect(runtime.getCfcStats().stagedReferenceCacheHits).toBe(0);
      const inspect = runtime.edit();
      const entries =
        readStoredCfcMetadata(inspect, holder.getAsNormalizedFullLink())!
          .labelMap.entries;
      inspect.abort();
      expect(
        entries.find((entry) => entry.path.length === 8)?.label.confidentiality,
      )
        .toContain("secret");
    });
  }

  it("preserves object back-references beside shared acyclic sources", async () => {
    const { tx } = stageReferenceGraph(runtime, space, 4, 2, "top-down");
    const cyclic = runtime.getCell(space, "cycle", {
      type: "object",
      ifc: { integrity: ["cycle-proof"] },
    }, tx);
    cyclic.set({ self: cyclic, value: 7 });
    recordReferencedArgumentFields(tx, cyclic.getAsNormalizedFullLink(), [
      "self",
    ]);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    expect(runtime.getCfcStats().stagedReferenceCacheHits).toBe(0);
    expect(runtime.getCell(space, "cycle").key("self").key("value").get()).toBe(
      7,
    );
  });

  it("refuses an unsupported carried reader below a shared source", async () => {
    const { tx, nodes } = stageReferenceGraph(
      runtime,
      space,
      4,
      2,
      "bottom-up",
    );
    const link = linkRefFrom<CfcCellLinkRefPayload>({
      ...linkRefPayload(nodes[0].getAsLink()),
      cfcLabelView: {
        version: 1,
        entries: [{
          path: ["p0", "p0", "p0", "p0"],
          label: {
            confidentiality: [{
              type: CFC_ATOM_TYPE.User,
              subject: { __ctCurrentPrincipal: true },
            }],
          },
        }],
      },
    });
    const receiver = runtime.getCell(space, "carried-reader", undefined, tx);
    receiver.setRaw({ argument: link });
    tx.recordCfcWritePolicyInput({
      kind: "link-write",
      target: { ...receiver.getAsNormalizedFullLink(), path: ["argument"] },
      source: nodes[0].getAsNormalizedFullLink(),
      cfcLabelView: linkRefPayload(link).cfcLabelView,
    });
    recordReferencedArgumentFields(tx, receiver.getAsNormalizedFullLink(), [
      "argument",
    ]);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error?.message).toContain(
      "Link CurrentPrincipal confidentiality requires a concrete stored reader",
    );
    expect(runtime.getCfcStats().stagedReferenceCacheHits).toBeGreaterThan(0);
  });

  for (const array of [false, true]) {
    it(`does not mint a wildcard ${array ? "item" : "property"} declaration through a pending reference`, async () => {
      const tx = runtime.edit();
      const declaration = {
        type: "object",
        ifc: { integrity: ["slot-proof"] },
      } as const;
      const wrapper = runtime.getCell(
        space,
        "wildcard-wrapper",
        array
          ? {
            type: "array",
            items: declaration,
            ifc: { integrity: ["wrapper-proof"] },
          }
          : {
            type: "object",
            additionalProperties: declaration,
            ifc: { integrity: ["wrapper-proof"] },
          },
        tx,
      );
      const holder = runtime.getCell(space, "wildcard-holder", {
        type: "object",
        ifc: { integrity: ["holder-proof"] },
      }, tx);
      const key = array ? "0" : "next";
      holder.set({ item: wrapper.key(key) });
      recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
        "item",
      ]);
      const leaf = runtime.getCell<Record<string, unknown>>(
        space,
        "reference-graph-leaf",
        undefined,
        tx,
      );
      wrapper.set(array ? [leaf] : { next: leaf });
      recordReferencedArgumentFields(tx, wrapper.getAsNormalizedFullLink(), [
        key,
      ]);

      expect((await tx.commit()).error).toBeUndefined();
      const label = readStoredCfcMetadata(
        runtime.readTx(),
        holder.getAsNormalizedFullLink(),
      )!
        .labelMap.entries.find((entry) => entry.path.join("/") === "item")
        ?.label;
      expect(label?.confidentiality).toContain("secret");
      expect(label?.integrity).toContain("leaf-proof");
      expect(label?.integrity).toContain("wrapper-proof");
      expect(label?.integrity).not.toContain("slot-proof");
    });
  }

  it("refreshes shared derivations after source metadata is persisted in the same pass", async () => {
    const flowRuntime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: StorageManager.emulate({ as: signer }),
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      await seedReferenceGraphLeaf(flowRuntime, space);
      const tx = flowRuntime.edit();
      const value = flowRuntime.getCell(
        space,
        "reference-graph-leaf",
        undefined,
        tx,
      )
        .key("value").get();
      const schema = {
        type: "object",
        ifc: { integrity: ["object-proof"] },
      } as const;
      const source = flowRuntime.getCell(space, "flow-source", schema, tx);
      const middle = flowRuntime.getCell(space, "flow-middle", schema, tx);
      const holder = flowRuntime.getCell(space, "flow-holder", schema, tx);
      holder.set({ first: middle, second: middle });
      recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
        "first",
        "second",
      ]);
      source.set({ copy: value });
      middle.set({ source });
      recordReferencedArgumentFields(tx, middle.getAsNormalizedFullLink(), [
        "source",
      ]);

      // Preparing the holder derives the middle's link before the source has
      // its flow label. Preparing the middle sees the source's persisted label.
      expect((await tx.commit()).error).toBeUndefined();
      const entries = readStoredCfcMetadata(
        flowRuntime.readTx(),
        middle.getAsNormalizedFullLink(),
      )!
        .labelMap.entries;
      const linked = entries.find((entry) =>
        entry.origin === "link" && entry.path.join("/") === "source"
      );
      expect(linked?.label.confidentiality).toContain("secret");
    } finally {
      await flowRuntime.dispose();
    }
  });

  it("recomputes a shared graph after its source label changes", async () => {
    const initial = stageReferenceGraph(runtime, space, 4, 2, "bottom-up");
    runtime.prepareTxForCommit(initial.tx);
    expect((await initial.tx.commit()).error).toBeUndefined();

    const update = runtime.edit();
    runtime.getCell(space, "reference-graph-leaf", {
      type: "object",
      ifc: { confidentiality: ["secret", "second-secret"] },
    }, update).set({ value: "updated" });
    runtime.prepareTxForCommit(update);
    expect((await update.commit()).error).toBeUndefined();

    const { tx, holder } = stageReferenceGraph(
      runtime,
      space,
      4,
      2,
      "bottom-up",
      "updated-graph",
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const inspect = runtime.edit();
    const entries =
      readStoredCfcMetadata(inspect, holder.getAsNormalizedFullLink())!
        .labelMap.entries;
    inspect.abort();
    const leaves = entries.filter((entry) => entry.path.length === 5);
    expect(leaves).toHaveLength(16);
    for (const entry of leaves) {
      expect(entry.label.confidentiality).toContain("second-secret");
    }
  });
});
