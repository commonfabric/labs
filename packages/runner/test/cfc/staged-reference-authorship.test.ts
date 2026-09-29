import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
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
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  for (const kind of ["authored-by", "represents-principal"] as const) {
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
      for (const order of ["bottom-up", "top-down", "stored"] as const) {
        it(`keeps ${kind} on the referenced value with ${confidentialSlot ? "a confidential" : "an undeclared"} slot in ${order} order`, async () => {
          const seed = runtime.edit();
          actAs(seed, bob.did());
          const leaf = runtime.getCell(space, "leaf", claimSchema(kind), seed);
          leaf.set({ content: text });
          recordTrustedWrite(seed, leaf.getAsNormalizedFullLink());
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
          const stageWrapper = (transaction: IExtendedStorageTransaction) => {
            actAs(transaction, alice.did());
            const target = wrapper.withTx(transaction);
            target.set({
              next: leaf.withTx(transaction),
              own: "Alice's value",
            });
            recordReferencedArgumentFields(
              transaction,
              target.getAsNormalizedFullLink(),
              ["next"],
            );
            recordTrustedWrite(transaction, target.getAsNormalizedFullLink());
          };
          if (order === "stored") {
            const stored = runtime.edit();
            stageWrapper(stored);
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
            const stage of order === "top-down" ? stages.toReversed() : stages
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
