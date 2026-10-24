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

const signer = await Identity.fromPassphrase("staged-reference-replacement");
const space = signer.did();

describe("staged-reference-replacement", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
    });
    const tx = runtime.edit();
    runtime.getCell(space, "endorsed", {
      type: "object",
      ifc: { integrity: ["old-proof"], confidentiality: ["old-secret"] },
    }, tx).set({ text: "endorsed" });
    runtime.getCell(space, "replacement", { type: "object" }, tx).set({
      text: "replacement",
    });
    runtime.getCell(space, "labeled-replacement", {
      type: "object",
      ifc: { integrity: ["new-proof"], confidentiality: ["new-secret"] },
    }, tx).set({ text: "replacement" });
    expect((await tx.commit().settled).error).toBeUndefined();
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await storage.synced();
    await storage.close();
  });

  it("retains the input check for a weaker reference replaced by an endorsed reference", async () => {
    const tx = runtime.edit();
    const holder = runtime.getCell(space, "holder", {
      type: "object",
      properties: {
        slot: { type: "object", ifc: { requiredIntegrity: ["old-proof"] } },
      },
    }, tx);
    holder.set({
      slot: runtime.getCell(space, "labeled-replacement", undefined, tx),
    });
    holder.set({ slot: runtime.getCell(space, "endorsed", undefined, tx) });
    recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
      "slot",
    ]);
    expect((await tx.commit().settled).error?.message).toContain(
      "requiredIntegrity",
    );
  });

  it("rejects a public inline replacement after consuming a confidential source", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(space, "endorsed", undefined, tx);
    const consumed = source.key("text").get();
    const holder = runtime.getCell(space, "holder", { type: "object" }, tx);
    holder.set({ slot: source });
    holder.setRaw({ slot: consumed });
    expect((await tx.commit().settled).error?.message).toContain("writer-fit");
  });

  it("refuses stale integrity at a floor in the replacement transaction", async () => {
    const tx = runtime.edit();
    const holder = runtime.getCell(space, "holder", {
      type: "object",
      properties: {
        slot: { type: "object", ifc: { requiredIntegrity: ["old-proof"] } },
      },
    }, tx);
    holder.set({ slot: runtime.getCell(space, "endorsed", undefined, tx) });
    holder.set({ slot: runtime.getCell(space, "replacement", undefined, tx) });
    recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
      "slot",
    ]);
    expect((await tx.commit().settled).error?.message).toContain(
      "requiredIntegrity",
    );
  });

  for (const labeled of [false, true]) {
    it(`refuses stale integrity after replacement by ${labeled ? "a labeled" : "an unlabeled"} reference`, async () => {
      const tx = runtime.edit();
      const holder = runtime.getCell(space, "holder", { type: "object" }, tx);
      holder.set({ slot: runtime.getCell(space, "endorsed", undefined, tx) });
      holder.set({
        slot: runtime.getCell(
          space,
          labeled ? "labeled-replacement" : "replacement",
          undefined,
          tx,
        ),
      });
      recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
        "slot",
      ]);
      expect(
        tx.getCfcState().writePolicyInputs.filter((input) =>
          input.kind === "link-write"
        ),
      ).toHaveLength(2);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(holder.withTx(runtime.readTx()).key("slot").key("text").get())
        .toBe("replacement");

      const consume = runtime.edit();
      const sink = runtime.getCell(space, "sink", {
        type: "object",
        properties: {
          slot: { type: "object", ifc: { requiredIntegrity: ["old-proof"] } },
        },
      }, consume);
      sink.set({
        slot: holder.withTx(consume).key("slot").asSchema({ type: "object" }),
      });
      recordReferencedArgumentFields(consume, sink.getAsNormalizedFullLink(), [
        "slot",
      ]);
      expect((await consume.commit().settled).error?.message).toContain(
        "requiredIntegrity",
      );
      // The holder stores nothing of either source; the replacement's labels
      // are reached through the slot, and the replaced source's are not.
      const labels = readStoredCfcMetadata(
        runtime.readTx(),
        holder.getAsNormalizedFullLink(),
      )?.labelMap.entries ?? [];
      expect(labels.flatMap((entry) => entry.label.integrity ?? []))
        .not.toContain("old-proof");
      expect(labels.flatMap((entry) => entry.label.confidentiality ?? []))
        .not.toContain("old-secret");
      expect(labels.flatMap((entry) => entry.label.integrity ?? []))
        .not.toContain("new-proof");
      expect(labels.flatMap((entry) => entry.label.confidentiality ?? []))
        .not.toContain("new-secret");
      const reached = labelsReached(
        runtime,
        holder.getAsNormalizedFullLink(),
        ["slot"],
      );
      expect(reached.integrity).not.toContain("old-proof");
      expect(reached.confidentiality).not.toContain("old-secret");
      expect(reached.integrity).toEqual(labeled ? ["new-proof"] : []);
      expect(reached.confidentiality).toEqual(labeled ? ["new-secret"] : []);
    });
  }

  for (const replacement of ["inline", "deleted", "ancestor"] as const) {
    it(`drops a staged reference's labels when its slot is ${replacement}`, async () => {
      const tx = runtime.edit();
      const holder = runtime.getCell(space, "holder", { type: "object" }, tx);
      const source = runtime.getCell(space, "endorsed", undefined, tx);
      if (replacement === "ancestor") {
        holder.set({ container: { slot: source } });
        holder.setRaw({ container: { slot: { text: "inline" } } });
      } else {
        holder.set({ slot: source });
        holder.setRaw(
          replacement === "inline" ? { slot: { text: "inline" } } : {},
        );
      }
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(holder.withTx(runtime.readTx()).get()).toEqual(
        replacement === "ancestor"
          ? { container: { slot: { text: "inline" } } }
          : replacement === "inline"
          ? { slot: { text: "inline" } }
          : {},
      );
      const entries = readStoredCfcMetadata(
        runtime.readTx(),
        holder.getAsNormalizedFullLink(),
      )?.labelMap.entries ?? [];
      expect(entries.flatMap((entry) => entry.label.integrity ?? []))
        .not.toContain("old-proof");
      expect(entries.filter((entry) => entry.origin === "link")).toEqual([]);
    });
  }

  for (const order of ["bottom-up", "top-down"] as const) {
    it(`preserves the last matching input when a raw write restores a reference in ${order} order`, async () => {
      const tx = runtime.edit();
      const wrapper = runtime.getCell(space, "restored-wrapper", {
        type: "object",
        ifc: { integrity: ["wrapper-proof"] },
      }, tx);
      const holder = runtime.getCell(space, "holder", {
        type: "object",
        ifc: { integrity: ["holder-proof"] },
      }, tx);
      const source = runtime.getCell(space, "endorsed", undefined, tx);
      const linkWithView = (confidentiality: string) =>
        linkRefFrom<CfcCellLinkRefPayload>({
          ...linkRefPayload(source.getAsLink()),
          cfcLabelView: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: [confidentiality] },
            }],
          },
        });
      const restored = linkWithView("current-view");
      const stages = [
        () => {
          wrapper.set({ slot: linkWithView("superseded-view") });
          wrapper.set({ slot: restored });
          wrapper.set({
            slot: runtime.getCell(space, "labeled-replacement", undefined, tx),
          });
          wrapper.setRaw({ slot: restored });
          recordReferencedArgumentFields(
            tx,
            wrapper.getAsNormalizedFullLink(),
            [
              "slot",
            ],
          );
        },
        () => {
          holder.set({ argument: wrapper.key("slot") });
          recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
            "argument",
          ]);
        },
      ];
      for (
        const stage of order === "bottom-up" ? stages : stages.toReversed()
      ) {
        stage();
      }
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(holder.withTx(runtime.readTx()).key("argument").key("text").get())
        .toBe("endorsed");
      // The wrapper's slot carries the restored handle's own view and none
      // of the views it replaced; neither document stores a label of either
      // source. The read through the slot reaches the endorsed source's
      // labels beside the restored view.
      for (const cell of [wrapper, holder]) {
        const entries = readStoredCfcMetadata(
          runtime.readTx(),
          cell.getAsNormalizedFullLink(),
        )?.labelMap.entries ?? [];
        const integrity = entries.flatMap((entry) =>
          entry.label.integrity ?? []
        );
        const confidentiality = entries.flatMap((entry) =>
          entry.label.confidentiality ?? []
        );
        expect(integrity).not.toContain("old-proof");
        expect(integrity).not.toContain("new-proof");
        expect(confidentiality).not.toContain("old-secret");
        expect(confidentiality).not.toContain("superseded-view");
        expect(confidentiality).not.toContain("new-secret");
        expect(confidentiality.filter((atom) => atom === "current-view"))
          .toEqual(cell === wrapper ? ["current-view"] : []);
      }
      const reached = labelsReached(
        runtime,
        wrapper.getAsNormalizedFullLink(),
        ["slot"],
      );
      expect(reached.integrity).toContain("old-proof");
      expect(reached.integrity).not.toContain("new-proof");
      expect(reached.confidentiality).toContain("old-secret");
      expect(reached.confidentiality).toContain("current-view");
      expect(reached.confidentiality).not.toContain("superseded-view");
      expect(reached.confidentiality).not.toContain("new-secret");
      const consume = runtime.edit();
      const sink = runtime.getCell(space, "sink", {
        type: "object",
        properties: {
          slot: { type: "object", ifc: { requiredIntegrity: ["old-proof"] } },
        },
      }, consume);
      sink.set({
        slot: holder.withTx(consume).key("argument").asSchema({
          type: "object",
        }),
      });
      recordReferencedArgumentFields(consume, sink.getAsNormalizedFullLink(), [
        "slot",
      ]);
      expect((await consume.commit().settled).error).toBeUndefined();
      expect(sink.withTx(runtime.readTx()).key("slot").key("text").get())
        .toBe("endorsed");
    });
  }

  for (const order of ["bottom-up", "top-down"] as const) {
    it(`uses the final carried labels through a pending source in ${order} order`, async () => {
      const tx = runtime.edit();
      const wrapper = runtime.getCell(space, "wrapper", {
        type: "object",
        ifc: { integrity: ["wrapper-proof"] },
      }, tx);
      const holder = runtime.getCell(space, "holder", {
        type: "object",
        ifc: { integrity: ["holder-proof"] },
      }, tx);
      const source = runtime.getCell(
        space,
        "labeled-replacement",
        undefined,
        tx,
      );
      const stages = [
        () => {
          for (const confidentiality of ["superseded-view", "current-view"]) {
            const link = linkRefFrom<CfcCellLinkRefPayload>({
              ...linkRefPayload(source.getAsLink()),
              cfcLabelView: {
                version: 1,
                entries: [{
                  path: [],
                  label: { confidentiality: [confidentiality] },
                }],
              },
            });
            wrapper.set({ slot: link });
          }
          recordReferencedArgumentFields(
            tx,
            wrapper.getAsNormalizedFullLink(),
            ["slot"],
          );
        },
        () => {
          holder.set({ argument: wrapper });
          recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
            "argument",
          ]);
        },
      ];
      for (
        const stage of order === "bottom-up" ? stages : stages.toReversed()
      ) stage();
      expect((await tx.commit().settled).error).toBeUndefined();
      // The wrapper's slot carries the last handle's view; the holder, whose
      // reference covers the wrapper, stores nothing beneath its slot. The
      // source's labels are reached through the wrapper's slot.
      const wrapperEntries = readStoredCfcMetadata(
        runtime.readTx(),
        wrapper.getAsNormalizedFullLink(),
      )!.labelMap.entries;
      const wrapperConfidentiality = wrapperEntries.flatMap((entry) =>
        entry.label.confidentiality ?? []
      );
      expect(wrapperConfidentiality).toContain("current-view");
      expect(wrapperConfidentiality).not.toContain("superseded-view");
      expect(wrapperConfidentiality).not.toContain("new-secret");
      expect(wrapperEntries.flatMap((entry) => entry.label.integrity ?? []))
        .not.toContain("new-proof");
      expect(
        readStoredCfcMetadata(
          runtime.readTx(),
          holder.getAsNormalizedFullLink(),
        )!.labelMap.entries.map((entry) => entry.path),
      ).toEqual([[]]);
      const reached = labelsReached(
        runtime,
        wrapper.getAsNormalizedFullLink(),
        ["slot"],
      );
      expect(reached.confidentiality).toContain("current-view");
      expect(reached.confidentiality).toContain("new-secret");
      expect(reached.confidentiality).not.toContain("superseded-view");
      expect(reached.integrity).toContain("new-proof");
    });
  }

  for (const order of ["bottom-up", "top-down"] as const) {
    for (const initialized of [true, false]) {
      for (const labeled of [false, true]) {
        it(`drops replaced stored-source labels in ${order} order with ${labeled ? "a labeled" : "an unlabeled"} replacement${initialized ? " and initialization evidence" : " without initialization evidence"}`, async () => {
          const seed = runtime.edit();
          const wrapper = runtime.getCell(space, "stored-wrapper", {
            type: "object",
          }, seed);
          wrapper.set({
            slot: runtime.getCell(space, "endorsed", undefined, seed),
          });
          recordReferencedArgumentFields(
            seed,
            wrapper.getAsNormalizedFullLink(),
            [
              "slot",
            ],
          );
          expect((await seed.commit().settled).error).toBeUndefined();
          const tx = runtime.edit();
          const holder = runtime.getCell(space, "holder", {
            type: "object",
            ifc: { integrity: ["holder-proof"] },
          }, tx);
          const stages = [
            () => {
              wrapper.withTx(tx).set({
                slot: runtime.getCell(
                  space,
                  labeled ? "labeled-replacement" : "replacement",
                  undefined,
                  tx,
                ),
              });
              if (initialized) {
                recordReferencedArgumentFields(
                  tx,
                  wrapper.getAsNormalizedFullLink(),
                  [
                    "slot",
                  ],
                );
              }
            },
            () => {
              holder.set({ argument: wrapper.withTx(tx) });
              if (initialized) {
                recordReferencedArgumentFields(
                  tx,
                  holder.getAsNormalizedFullLink(),
                  [
                    "argument",
                  ],
                );
              }
            },
          ];
          for (
            const stage of order === "bottom-up" ? stages : stages.toReversed()
          ) {
            stage();
          }
          expect((await tx.commit().settled).error).toBeUndefined();
          expect(
            holder.withTx(runtime.readTx()).key("argument").key("slot").key(
              "text",
            ).get(),
          )
            .toBe("replacement");
          const entries = readStoredCfcMetadata(
            runtime.readTx(),
            holder.getAsNormalizedFullLink(),
          )!.labelMap.entries;
          // The holder stores its own label and nothing of either source;
          // the replacement's labels are reached through the wrapper's slot,
          // and the replaced source's are not.
          expect(entries.map((entry) => entry.path)).toEqual([[]]);
          expect(entries.flatMap((entry) => entry.label.integrity ?? []))
            .toContain("holder-proof");
          const reached = labelsReached(
            runtime,
            wrapper.getAsNormalizedFullLink(),
            ["slot"],
          );
          expect(reached.integrity).not.toContain("old-proof");
          expect(reached.confidentiality).not.toContain("old-secret");
          expect(reached.integrity).toEqual(labeled ? ["new-proof"] : []);
          expect(reached.confidentiality).toEqual(
            labeled ? ["new-secret"] : [],
          );
          const consume = runtime.edit();
          const sink = runtime.getCell(space, "sink", {
            type: "object",
            properties: {
              slot: {
                type: "object",
                ifc: { requiredIntegrity: ["old-proof"] },
              },
            },
          }, consume);
          sink.set({
            slot: holder.withTx(consume).key("argument").key("slot")
              .asSchema({ type: "object" }),
          });
          recordReferencedArgumentFields(
            consume,
            sink.getAsNormalizedFullLink(),
            [
              "slot",
            ],
          );
          expect((await consume.commit().settled).error?.message).toContain(
            "requiredIntegrity",
          );
        });
      }
    }
  }

  for (const order of ["bottom-up", "top-down"] as const) {
    it(`persists nothing of a carried view below the root when a stored reference is rewritten in ${order} order`, async () => {
      // A handle's carried view is the reference's own label at its root
      // alone. A view below the root is not persisted by the staging that
      // stored the reference nor by the one that rewrites it, and the
      // source's labels are reached through the slot.
      const source = runtime.getCell(space, "labeled-replacement");
      const linkWithView = (confidentiality: string) =>
        linkRefFrom<CfcCellLinkRefPayload>({
          ...linkRefPayload(source.getAsLink()),
          cfcLabelView: {
            version: 1,
            entries: [{
              path: ["text"],
              label: { confidentiality: [confidentiality] },
            }],
          },
        });
      const seed = runtime.edit();
      const wrapper = runtime.getCell(space, "stored-wrapper", {
        type: "object",
        ifc: { integrity: ["wrapper-proof"] },
      }, seed);
      wrapper.set({ slot: linkWithView("superseded-view") });
      recordReferencedArgumentFields(seed, wrapper.getAsNormalizedFullLink(), [
        "slot",
      ]);
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      const holder = runtime.getCell(space, "holder", {
        type: "object",
        ifc: { integrity: ["holder-proof"] },
      }, tx);
      const stages = [
        () => {
          wrapper.withTx(tx).set({ slot: linkWithView("current-view") });
          recordReferencedArgumentFields(
            tx,
            wrapper.getAsNormalizedFullLink(),
            ["slot"],
          );
        },
        () => {
          holder.set({ argument: wrapper.withTx(tx) });
          recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
            "argument",
          ]);
        },
      ];
      for (
        const stage of order === "bottom-up" ? stages : stages.toReversed()
      ) stage();
      expect((await tx.commit().settled).error).toBeUndefined();
      for (const cell of [wrapper, holder]) {
        const entries = readStoredCfcMetadata(
          runtime.readTx(),
          cell.getAsNormalizedFullLink(),
        )!.labelMap.entries;
        expect(entries.map((entry) => entry.path)).toEqual([[]]);
      }
      const reached = labelsReached(
        runtime,
        wrapper.getAsNormalizedFullLink(),
        ["slot", "text"],
      );
      expect(reached.confidentiality).toContain("new-secret");
      expect(reached.confidentiality).not.toContain("current-view");
      expect(reached.confidentiality).not.toContain("superseded-view");
      expect(
        holder.withTx(runtime.readTx()).key("argument").key("slot").key("text")
          .get(),
      ).toBe("replacement");
    });
  }

  it("preserves the final source's proof for a later integrity floor", async () => {
    const tx = runtime.edit();
    const holder = runtime.getCell(space, "holder", { type: "object" }, tx);
    holder.set({ slot: runtime.getCell(space, "endorsed", undefined, tx) });
    holder.set({
      slot: runtime.getCell(space, "labeled-replacement", undefined, tx),
    });
    recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
      "slot",
    ]);
    expect((await tx.commit().settled).error).toBeUndefined();
    const consume = runtime.edit();
    const sink = runtime.getCell(space, "sink", {
      type: "object",
      properties: {
        slot: { type: "object", ifc: { requiredIntegrity: ["new-proof"] } },
      },
    }, consume);
    sink.set({
      slot: holder.withTx(consume).key("slot").asSchema({ type: "object" }),
    });
    recordReferencedArgumentFields(consume, sink.getAsNormalizedFullLink(), [
      "slot",
    ]);
    expect((await consume.commit().settled).error).toBeUndefined();
    expect(sink.withTx(runtime.readTx()).key("slot").key("text").get()).toBe(
      "replacement",
    );
  });

  it("drops a reference's proof when replaced by another path in the same source", async () => {
    const seed = runtime.edit();
    const source = runtime.getCell(space, "two-paths", {
      type: "object",
      properties: {
        endorsed: { type: "object", ifc: { integrity: ["old-proof"] } },
        plain: { type: "object" },
      },
    }, seed);
    source.set({
      endorsed: { text: "endorsed" },
      plain: { text: "replacement" },
    });
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    const holder = runtime.getCell(space, "holder", { type: "object" }, tx);
    holder.set({ slot: source.withTx(tx).key("endorsed") });
    holder.set({ slot: source.withTx(tx).key("plain") });
    recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
      "slot",
    ]);
    expect((await tx.commit().settled).error).toBeUndefined();
    const entries =
      readStoredCfcMetadata(runtime.readTx(), holder.getAsNormalizedFullLink())
        ?.labelMap.entries ?? [];
    expect(entries.flatMap((entry) => entry.label.integrity ?? [])).not
      .toContain("old-proof");
    expect(holder.withTx(runtime.readTx()).key("slot").key("text").get()).toBe(
      "replacement",
    );
  });

  it("rejects an unsupported carried reader even when its reference is replaced", async () => {
    const tx = runtime.edit();
    const source = runtime.getCell(space, "endorsed", undefined, tx);
    const link = linkRefFrom<CfcCellLinkRefPayload>({
      ...linkRefPayload(source.getAsLink()),
      cfcLabelView: {
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: [{
              type: CFC_ATOM_TYPE.User,
              subject: { __ctCurrentPrincipal: true },
            }],
          },
        }],
      },
    });
    const holder = runtime.getCell(space, "holder", { type: "object" }, tx);
    holder.set({ slot: link });
    holder.set({ slot: runtime.getCell(space, "replacement", undefined, tx) });
    expect((await tx.commit().settled).error?.message).toContain(
      "Link CurrentPrincipal confidentiality requires a concrete reader",
    );
  });
});
