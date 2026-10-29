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
import { labelsReached } from "../support/reached-labels.ts";
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
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  for (const order of ["bottom-up", "top-down"] as const) {
    it(`reaches the leaf through every diamond path and stores none of its labels in ${order} order`, async () => {
      // The holder persists its own label alone. Every path through the
      // diamond reads the leaf where it is, so the labels reached are the
      // leaf's own and the holder stores no entry beneath its slot.
      const depth = 7;
      const { tx, holder } = stageReferenceGraph(
        runtime,
        space,
        depth,
        2,
        order,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      const entries = readStoredCfcMetadata(
        runtime.readTx(),
        holder.getAsNormalizedFullLink(),
      )!.labelMap.entries;
      expect(entries.map((entry) => entry.path)).toEqual([[]]);
      for (const bits of [0, 2 ** depth - 1, 0b1010101, 0b0101010]) {
        const path = [
          "argument",
          ...Array.from({ length: depth }, (_, i) => `p${(bits >> i) & 1}`),
        ];
        const reached = labelsReached(
          runtime,
          holder.getAsNormalizedFullLink(),
          path,
        );
        expect(reached.confidentiality).toContain("secret");
        expect(reached.integrity).toContain("leaf-proof");
      }
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
        // The floor on the holder's nested slot is credited through the
        // projected reference. The holder stores nothing beneath its slot;
        // the node stores the reference's own restriction, which is the
        // confidentiality the wrapper declares for the slot it projects, and
        // none of the leaf's labels; the leaf's labels are reached by reading
        // through either field.
        expect((await tx.commit().settled).error).toBeUndefined();
        const holderEntries = readStoredCfcMetadata(
          runtime.readTx(),
          holder.getAsNormalizedFullLink(),
        )!.labelMap.entries;
        expect(holderEntries.map((entry) => entry.path)).toEqual([[]]);
        const nodeEntries = readStoredCfcMetadata(
          runtime.readTx(),
          node.getAsNormalizedFullLink(),
        )!.labelMap.entries;
        for (const field of ["first", "second"]) {
          const reached = labelsReached(
            runtime,
            holder.getAsNormalizedFullLink(),
            ["argument", field],
          );
          expect(reached.confidentiality).toContain("secret");
          expect(reached.integrity).toContain("leaf-proof");
          const slot = nodeEntries.filter((entry) =>
            entry.path.join("/") === field
          );
          expect(slot.flatMap((entry) => entry.label.integrity ?? []))
            .not.toContain("slot-proof");
          expect(slot.flatMap((entry) => entry.label.integrity ?? []))
            .not.toContain("leaf-proof");
          expect(slot.flatMap((entry) => entry.label.confidentiality ?? []))
            .not.toContain("secret");
          if (slotDeclaration === "confidentiality") {
            const confidentiality = slot.flatMap((entry) =>
              entry.label.confidentiality ?? []
            );
            expect(confidentiality).toContain("wrapper-secret");
            expect(confidentiality).toContain("slot-secret");
          } else {
            expect(slot).toEqual([]);
          }
        }
      });
    }
  }

  it("preserves object back-references beside shared acyclic sources", async () => {
    runtime.resetCfcStats();
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
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(runtime.getCfcStats().stagedReferenceCacheHits).toBe(0);
    expect(runtime.getCell(space, "cycle").key("self").key("value").get()).toBe(
      7,
    );
  });

  it("drops a carried reader below the root of a reference to a shared source", async () => {
    // Only the root of a handle's carried view is the reference's own label.
    // A reader placeholder below it is not persisted and binds nothing; the
    // receiver stores no entry, and a read through the reference reaches
    // the leaf's labels where they are.
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
    expect((await tx.commit().settled).error).toBeUndefined();
    expect(
      readStoredCfcMetadata(
        runtime.readTx(),
        receiver.getAsNormalizedFullLink(),
      )?.labelMap.entries ?? [],
    ).toEqual([]);
    const reached = labelsReached(
      runtime,
      receiver.getAsNormalizedFullLink(),
      ["argument", "p0", "p0", "p0", "p0"],
    );
    expect(reached.confidentiality).toEqual(["secret"]);
    expect(reached.integrity).toContain("leaf-proof");
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

      expect((await tx.commit().settled).error).toBeUndefined();
      // The wildcard declaration belongs to the wrapper. The holder stores
      // nothing at its slot, and reading through it reaches the leaf.
      expect(
        readStoredCfcMetadata(
          runtime.readTx(),
          holder.getAsNormalizedFullLink(),
        )!.labelMap.entries.map((entry) => entry.path),
      ).toEqual([[]]);
      const reached = labelsReached(
        runtime,
        holder.getAsNormalizedFullLink(),
        ["item"],
      );
      expect(reached.confidentiality).toContain("secret");
      expect(reached.integrity).toContain("leaf-proof");
    });
  }

  it("reaches a source's changed label through a graph staged before the change", async () => {
    // Nothing in the graph holds a copy of the leaf's label, so a read
    // through a graph staged before the leaf's label changed reaches the
    // label the leaf holds now.
    const { tx, holder } = stageReferenceGraph(
      runtime,
      space,
      4,
      2,
      "bottom-up",
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();

    const update = runtime.edit();
    runtime.getCell(space, "reference-graph-leaf", {
      type: "object",
      ifc: { confidentiality: ["secret", "second-secret"] },
    }, update).set({ value: "updated" });
    runtime.prepareTxForCommit(update);
    expect((await update.commit().settled).error).toBeUndefined();

    expect(
      readStoredCfcMetadata(runtime.readTx(), holder.getAsNormalizedFullLink())!
        .labelMap.entries.map((entry) => entry.path),
    ).toEqual([[]]);
    for (const path of [["p0", "p0", "p0", "p0"], ["p1", "p0", "p1", "p0"]]) {
      const reached = labelsReached(
        runtime,
        holder.getAsNormalizedFullLink(),
        ["argument", ...path],
      );
      expect(reached.confidentiality).toContain("second-secret");
      expect(reached.integrity).toContain("leaf-proof");
    }
  });
});
