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
