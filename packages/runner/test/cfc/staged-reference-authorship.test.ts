import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { linkRefFrom, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import type { CfcCellLinkRefPayload } from "../../src/cfc/link-label-view.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { recordReferencedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import type { NormalizedFullLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const alice = await Identity.fromPassphrase("staged-reference-author-alice");
const bob = await Identity.fromPassphrase("staged-reference-author-bob");
const space = alice.did();
const text = "Bob's existing content";
const currentPrincipal = { __ctCurrentPrincipal: true };
type ClaimKind = "authored-by" | "represents-principal";

/** A principal claim with its verified writer and trusted UI contract. */
const claimSchema = (kind: ClaimKind) => ({
  type: "object",
  ifc: {
    addIntegrity: [{ kind, subject: currentPrincipal }],
    writeAuthorizedBy: {
      __ctWriterIdentityOf: {
        file: "/trusted.tsx",
        path: ["writeValue"],
      },
    },
    uiContract: {
      helper: "UiAction",
      action: "WriteValue",
      trustedPattern: "TrustedSurface",
      requiredEventIntegrity: ["TrustedSurface"],
    },
  },
} as const satisfies JSONSchema);

/** Runs an ordinary verified writer on the named principal's behalf. */
const actAs = (tx: IExtendedStorageTransaction, principal: string): void => {
  setCfcTrustSnapshot(tx, {
    id: `trust-${principal}`,
    actingPrincipal: principal,
  });
  setCfcImplementationIdentity(tx, {
    kind: "verified",
    moduleIdentity: "trusted-writer",
    sourceFile: "/trusted.tsx",
    bindingPath: ["writeValue"],
  });
};

/** Supplies the UI event required to mint the field's principal claim. */
const recordTrustedWrite = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
): void => {
  tx.recordCfcWritePolicyInput({
    kind: "trusted-event",
    target,
    eventId: "trusted-write",
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "TrustedSurface",
        eventIntegrity: ["TrustedSurface"],
        uiContractDataset: { uiAction: "WriteValue" },
      },
    },
  });
};

describe("staged-reference-authorship", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: StorageManager.emulate({ as: alice }),
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  for (const kind of ["authored-by", "represents-principal"] as const) {
    for (const replace of [false, true]) {
      for (const order of ["bottom-up", "top-down", "stored"] as const) {
        it(`rejects the container's ${kind} floor for a ${replace ? "replacement" : "new"} schema-less reference in ${order} order`, async () => {
          const seed = runtime.edit();
          actAs(seed, bob.did());
          const leaf = runtime.getCell(
            space,
            "old-leaf",
            claimSchema(kind),
            seed,
          );
          leaf.set({ content: text });
          recordTrustedWrite(seed, leaf.getAsNormalizedFullLink());
          const plain = runtime.getCell(space, "plain", undefined, seed);
          seedStoredEnvelope(seed, plain.getAsNormalizedFullLink(), {
            value: { content: "unattributed content" },
          });
          expect((await seed.commit()).error).toBeUndefined();
          expect(plain.withTx(runtime.readTx()).key("content").get()).toBe(
            "unattributed content",
          );
          expect(
            readStoredCfcMetadata(
              runtime.readTx(),
              plain.getAsNormalizedFullLink(),
            ),
          )
            .toBeUndefined();

          const wrapper = runtime.getCell(space, "wrapper", claimSchema(kind));
          if (replace) {
            const stored = runtime.edit();
            actAs(stored, alice.did());
            wrapper.withTx(stored).set({
              next: leaf.withTx(stored),
              own: "Alice's value",
            });
            recordReferencedArgumentFields(
              stored,
              wrapper.getAsNormalizedFullLink(),
              ["next"],
            );
            recordTrustedWrite(stored, wrapper.getAsNormalizedFullLink());
            expect((await stored.commit()).error).toBeUndefined();
          }
          const reference = linkRefFrom<CfcCellLinkRefPayload>({
            ...linkRefPayload(plain.getAsLink()),
            cfcLabelView: {
              version: 1,
              entries: [{
                path: ["content"],
                label: { confidentiality: ["carried-secret"] },
              }],
            },
          });
          const stageWrapper = (tx: IExtendedStorageTransaction) => {
            actAs(tx, alice.did());
            wrapper.withTx(tx).set({ next: reference, own: "Alice's value" });
            recordReferencedArgumentFields(
              tx,
              wrapper.getAsNormalizedFullLink(),
              ["next"],
            );
            recordTrustedWrite(tx, wrapper.getAsNormalizedFullLink());
          };
          if (order === "stored") {
            const stored = runtime.edit();
            stageWrapper(stored);
            expect((await stored.commit()).error).toBeUndefined();
          }

          const tx = runtime.edit();
          actAs(tx, alice.did());
          const node = runtime.getCell(space, "node", {
            type: "object",
            ifc: { integrity: ["node-proof"] },
          }, tx);
          const stages = [
            () => {
              if (order !== "stored") stageWrapper(tx);
            },
            () => {
              node.set({
                argument: wrapper.withTx(tx).key("next"),
                own: wrapper.withTx(tx).key("own"),
              });
              recordReferencedArgumentFields(
                tx,
                node.getAsNormalizedFullLink(),
                ["argument", "own"],
              );
            },
          ];
          for (
            const stage of order === "top-down" ? stages.toReversed() : stages
          ) {
            stage();
          }
          expect((await tx.commit()).error).toBeUndefined();
          expect(
            node.withTx(runtime.readTx()).key("argument").key("content").get(),
          )
            .toBe("unattributed content");

          // The inline sibling retains the container's verified claim. Neither
          // the reference nor its child may use it to satisfy a later floor.
          for (const path of [["own"], ["argument"], ["argument", "content"]]) {
            const consume = runtime.edit();
            const source = node.withTx(consume).key(...path);
            const sink = runtime.getCell(space, `sink-${path.join("-")}`, {
              type: "object",
              properties: {
                slot: {
                  ifc: { requiredIntegrity: [{ kind, subject: alice.did() }] },
                },
              },
            }, consume);
            sink.set({ slot: source });
            recordReferencedArgumentFields(
              consume,
              sink.getAsNormalizedFullLink(),
              ["slot"],
            );
            const result = await consume.commit();
            if (path[0] === "own") {
              expect(result.error).toBeUndefined();
              expect(sink.withTx(runtime.readTx()).key("slot").get()).toBe(
                "Alice's value",
              );
            } else {
              expect(result.error?.message).toContain("write floor failed");
            }
          }
          const entries = readStoredCfcMetadata(
            runtime.readTx(),
            node.getAsNormalizedFullLink(),
          )!
            .labelMap.entries;
          expect(
            entries.find((entry) => entry.path.join("/") === "argument")?.label
              .integrity,
          )
            .toContainEqual(
              expect.objectContaining({ type: CFC_ATOM_TYPE.LinkReference }),
            );
          expect(
            entries.find((entry) => entry.path.join("/") === "argument/content")
              ?.label.confidentiality,
          )
            .toContain("carried-secret");
        });
      }
    }

    it(`keeps ${kind} on a stored field claim beneath a root claim`, async () => {
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      const source = runtime.getCell(space, "seeded-source", undefined, seed);
      seedStoredEnvelope(seed, source.getAsNormalizedFullLink(), {
        value: { field: text },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [
              {
                path: [],
                label: { integrity: [{ kind, subject: alice.did() }] },
              },
              {
                path: ["field"],
                label: { integrity: [{ kind, subject: bob.did() }] },
              },
            ],
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();
      for (const principal of [alice.did(), bob.did()]) {
        const tx = runtime.edit();
        const sink = runtime.getCell(space, `seeded-sink-${principal}`, {
          type: "object",
          properties: {
            copied: {
              type: "string",
              ifc: { requiredIntegrity: [{ kind, subject: principal }] },
            },
          },
        }, tx);
        sink.set({ copied: source.withTx(tx).key("field") });
        recordReferencedArgumentFields(tx, sink.getAsNormalizedFullLink(), [
          "copied",
        ]);
        const result = await tx.commit();
        if (principal === alice.did()) {
          expect(result.error?.message).toContain("write floor failed");
        } else {
          expect(result.error).toBeUndefined();
          expect(sink.withTx(runtime.readTx()).key("copied").get()).toBe(
            text,
          );
        }
      }
    });

    it(`keeps ${kind} on a stored reference in a field named \`value\``, async () => {
      // A payload field named `value` is an ordinary field, not the document
      // root, so the reference it holds keeps its author's claim rather than
      // taking the wrapper's.

      const seed = runtime.edit();
      actAs(seed, bob.did());
      const leaf = runtime.getCell(
        space,
        "value-leaf",
        claimSchema(kind),
        seed,
      );
      leaf.set({ content: text });
      recordTrustedWrite(seed, leaf.getAsNormalizedFullLink());
      expect((await seed.commit()).error).toBeUndefined();

      const stored = runtime.edit();
      actAs(stored, alice.did());
      const wrapper = runtime.getCell(
        space,
        "value-wrapper",
        claimSchema(kind),
        stored,
      );
      wrapper.set({ value: leaf.withTx(stored), own: "Alice's value" });
      recordReferencedArgumentFields(
        stored,
        wrapper.getAsNormalizedFullLink(),
        ["value"],
      );
      recordTrustedWrite(stored, wrapper.getAsNormalizedFullLink());
      expect((await stored.commit()).error).toBeUndefined();

      for (const principal of [alice.did(), bob.did()]) {
        const copy = runtime.edit();
        actAs(copy, alice.did());
        const sink = runtime.getCell(space, `value-sink-${principal}`, {
          type: "object",
          properties: {
            copied: {
              type: "object",
              ifc: { requiredIntegrity: [{ kind, subject: principal }] },
            },
          },
        }, copy);
        sink.set({ copied: wrapper.withTx(copy).key("value") as never });
        recordReferencedArgumentFields(copy, sink.getAsNormalizedFullLink(), [
          "copied",
        ]);
        const result = await copy.commit();
        if (principal === alice.did()) {
          expect(result.error?.message).toContain("write floor failed");
        } else {
          expect(result.error).toBeUndefined();
          expect(
            sink.withTx(runtime.readTx()).key("copied").key("content").get(),
          ).toBe(text);
        }
      }
    });

    for (const confidentialSlot of [false, true]) {
      for (
        const order of [
          "bottom-up",
          "top-down",
          "stored",
          "replaced-bottom-up",
          "replaced-top-down",
        ] as const
      ) {
        it(`keeps ${kind} on the referenced value with ${confidentialSlot ? "a confidential" : "an undeclared"} slot in ${order} order`, async () => {
          const seed = runtime.edit();
          actAs(seed, bob.did());
          const leaf = runtime.getCell(space, "leaf", claimSchema(kind), seed);
          leaf.set({ content: text });
          recordTrustedWrite(seed, leaf.getAsNormalizedFullLink());
          const oldLeaf = runtime.getCell(
            space,
            "old-leaf",
            claimSchema(kind),
            seed,
          );
          if (order.startsWith("replaced-")) {
            oldLeaf.set({ content: "Bob's previous content" });
            recordTrustedWrite(seed, oldLeaf.getAsNormalizedFullLink());
          }
          expect((await seed.commit()).error).toBeUndefined();

          const tx = runtime.edit();
          actAs(tx, alice.did());
          const wrapperSchema = {
            ...claimSchema(kind),
            ...(confidentialSlot
              ? {
                properties: {
                  next: {
                    type: "object",
                    ifc: { confidentiality: ["slot-secret"] },
                  },
                },
              }
              : {}),
          } as const satisfies JSONSchema;
          const wrapper = runtime.getCell(space, "wrapper", wrapperSchema, tx);
          const stageWrapper = (
            transaction: IExtendedStorageTransaction,
            source = leaf,
          ) => {
            actAs(transaction, alice.did());
            const target = wrapper.withTx(transaction);
            target.set({
              next: source.withTx(transaction),
              own: "Alice's value",
            });
            recordReferencedArgumentFields(
              transaction,
              target.getAsNormalizedFullLink(),
              ["next"],
            );
            recordTrustedWrite(transaction, target.getAsNormalizedFullLink());
          };
          if (order === "stored" || order.startsWith("replaced-")) {
            const stored = runtime.edit();
            stageWrapper(stored, order === "stored" ? leaf : oldLeaf);
            expect((await stored.commit()).error).toBeUndefined();
          }
          const node = runtime.getCell(space, "node", {
            type: "object",
            ifc: { integrity: ["node-proof"] },
          }, tx);
          const holder = runtime.getCell(space, "holder", {
            type: "object",
            ifc: { integrity: ["holder-proof"] },
          }, tx);
          const stages = [
            () => {
              if (order !== "stored") stageWrapper(tx);
            },
            () => {
              node.set({
                first: wrapper.key("next"),
                content: wrapper.key("next").key("content"),
                own: wrapper.key("own"),
                whole: wrapper,
              });
              recordReferencedArgumentFields(
                tx,
                node.getAsNormalizedFullLink(),
                [
                  "first",
                  "content",
                  "own",
                  "whole",
                ],
              );
            },
            () => {
              holder.set({
                argument: node,
                projected: node.key("whole").key("next"),
                content: node.key("whole").key("next").key("content"),
              });
              recordReferencedArgumentFields(
                tx,
                holder.getAsNormalizedFullLink(),
                ["argument", "projected", "content"],
              );
            },
          ];
          for (
            const stage of order.endsWith("top-down")
              ? stages.toReversed()
              : stages
          ) {
            stage();
          }
          expect((await tx.commit()).error).toBeUndefined();
          const entries = readStoredCfcMetadata(
            runtime.readTx(),
            holder.getAsNormalizedFullLink(),
          )!.labelMap.entries;
          for (
            const path of [
              "argument/first",
              "argument/content",
              "argument/whole/next",
            ]
          ) {
            const integrity = entries.find((entry) =>
              entry.path.join("/") === path
            )
              ?.label.integrity;
            expect(integrity).toContainEqual({ kind, subject: bob.did() });
            expect(integrity).not.toContainEqual({
              kind,
              subject: alice.did(),
            });
          }
          for (const path of ["argument/own", "argument/whole"]) {
            expect(
              entries.find((entry) => entry.path.join("/") === path)
                ?.label.integrity,
            ).toContainEqual({ kind, subject: alice.did() });
          }

          for (const principal of [alice.did(), bob.did()]) {
            const copy = runtime.edit();
            const sink = runtime.getCell(space, `sink-${principal}`, {
              type: "object",
              properties: {
                copied: {
                  type: "object",
                  ifc: { requiredIntegrity: [{ kind, subject: principal }] },
                },
              },
            }, copy);
            sink.set({
              copied: holder.withTx(copy).key("argument").key("first"),
            });
            recordReferencedArgumentFields(
              copy,
              sink.getAsNormalizedFullLink(),
              [
                "copied",
              ],
            );
            const result = await copy.commit();
            if (principal === alice.did()) {
              expect(result.error?.message).toContain("write floor failed");
            } else {
              expect(result.error).toBeUndefined();
              expect(
                sink.withTx(runtime.readTx()).key("copied").key("content")
                  .get(),
              )
                .toBe(text);
            }
          }
        });
      }
    }
  }
});
